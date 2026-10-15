// Local stdio/TCP byte bridge. MCP framing and session state belong to REA.
// No Node runtime, shell, child process, or persisted client environment.
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <algorithm>
#include <atomic>
#include <cstdint>
#include <cstdio>
#include <cwchar>
#include <regex>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

namespace {
constexpr size_t opening_limit = 1024 * 1024;
constexpr DWORD startup_timeout_ms = 30000;
std::atomic<SOCKET> active_socket{INVALID_SOCKET};
std::atomic<bool> interrupted{false};

[[noreturn]] void fail() { throw std::runtime_error("shared MCP bridge failed"); }

struct Handle {
  HANDLE value = INVALID_HANDLE_VALUE;
  ~Handle() { if (value != INVALID_HANDLE_VALUE) CloseHandle(value); }
};

struct Connection {
  SOCKET value = INVALID_SOCKET;
  ~Connection() {
    active_socket.store(INVALID_SOCKET);
    if (value != INVALID_SOCKET) closesocket(value);
  }
};

struct Winsock {
  Winsock() { WSADATA data{}; if (WSAStartup(MAKEWORD(2, 2), &data) != 0) fail(); }
  ~Winsock() { WSACleanup(); }
};

BOOL WINAPI interrupt(DWORD event) {
  if (event != CTRL_C_EVENT && event != CTRL_BREAK_EVENT && event != CTRL_CLOSE_EVENT) return FALSE;
  interrupted.store(true);
  const SOCKET socket = active_socket.load();
  if (socket != INVALID_SOCKET) shutdown(socket, SD_BOTH);
  return TRUE;
}

std::string utf8(const std::wstring& text) {
  if (text.empty()) return {};
  const int count = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, text.data(),
    static_cast<int>(text.size()), nullptr, 0, nullptr, nullptr);
  if (count == 0) fail();
  std::string result(static_cast<size_t>(count), '\0');
  if (WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, text.data(),
      static_cast<int>(text.size()), result.data(), count, nullptr, nullptr) != count) fail();
  return result;
}

std::string quoted(const std::string& text) {
  constexpr char hex[] = "0123456789abcdef";
  std::string result = "\"";
  for (const unsigned char c : text) {
    if (c == '"' || c == '\\') { result += '\\'; result += static_cast<char>(c); }
    else if (c < 32) { result += "\\u00"; result += hex[c >> 4]; result += hex[c & 15]; }
    else result += static_cast<char>(c);
  }
  result += '"';
  return result;
}

std::wstring environment_value(const wchar_t* name) {
  const DWORD size = GetEnvironmentVariableW(name, nullptr, 0);
  if (size == 0) fail();
  std::vector<wchar_t> buffer(size);
  const DWORD length = GetEnvironmentVariableW(name, buffer.data(), size);
  if (length == 0 || length >= size) fail();
  return std::wstring(buffer.data(), length);
}

std::wstring absolute_path(const std::wstring& path) {
  const DWORD size = GetFullPathNameW(path.c_str(), 0, nullptr, nullptr);
  if (size == 0) fail();
  std::vector<wchar_t> buffer(size);
  const DWORD length = GetFullPathNameW(path.c_str(), size, buffer.data(), nullptr);
  if (length == 0 || length >= size) fail();
  return std::wstring(buffer.data(), length);
}

bool is_absolute(const std::wstring& path) {
  return (path.size() >= 3 && path[1] == L':' && (path[2] == L'\\' || path[2] == L'/')) ||
    (path.size() >= 2 && path[0] == L'\\' && path[1] == L'\\');
}

struct Endpoint { uint16_t port; std::string token; };

Endpoint read_endpoint(const std::wstring& path) {
  if (!is_absolute(path)) fail();
  Handle file{CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr,
    OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr)};
  if (file.value == INVALID_HANDLE_VALUE) fail();
  char bytes[4097];
  DWORD count = 0;
  if (!ReadFile(file.value, bytes, sizeof(bytes), &count, nullptr) || count > 4096) fail();
  const std::string text(bytes, count);
  // Private version-1 descriptor emitted by sharedMcpServer, not arbitrary JSON.
  // An anchored grammar rejects extra fields, malformed ports and trailing data.
  const std::regex format(R"rea(\s*\{\s*"version"\s*:\s*1\s*,\s*"port"\s*:\s*([1-9][0-9]{0,4})\s*,\s*"token"\s*:\s*"([a-f0-9]{64})"\s*\}\s*)rea");
  std::smatch match;
  if (!std::regex_match(text, match, format)) fail();
  const int port = std::stoi(match[1].str());
  if (port > 65535) fail();
  return {static_cast<uint16_t>(port), match[2].str()};
}

std::string opening_frame(const std::string& token) {
  struct Environment {
    LPWCH value = GetEnvironmentStringsW();
    ~Environment() { if (value != nullptr) FreeEnvironmentStringsW(value); }
  } environment;
  if (environment.value == nullptr) fail();
  std::string result = "{\"version\":1,\"token\":" + quoted(token) + ",\"environment\":{";
  bool first = true;
  for (const wchar_t* row = environment.value; *row != L'\0'; row += std::wcslen(row) + 1) {
    const wchar_t* separator = std::wcschr(row, L'=');
    // Windows' hidden per-drive current-directory entries are not environment keys.
    if (separator == nullptr || separator == row) continue;
    const std::wstring key(row, separator);
    if (_wcsicmp(key.c_str(), L"REA_MCP_SHARED_ENDPOINT") == 0) continue;
    std::wstring value(separator + 1);
    if (_wcsicmp(key.c_str(), L"HOPPER_TARGET_PATH") == 0 && !value.empty()) value = absolute_path(value);
    if (!first) result += ',';
    first = false;
    result += quoted(utf8(key)) + ':' + quoted(utf8(value));
    if (result.size() > opening_limit) fail();
  }
  result += "},\"cwd\":" + quoted(utf8(absolute_path(L"."))) + "}\n";
  if (result.size() > opening_limit) fail();
  return result;
}

void connect_loopback(SOCKET socket, uint16_t port) {
  u_long nonblocking = 1;
  if (ioctlsocket(socket, FIONBIO, &nonblocking) != 0) fail();
  sockaddr_in address{};
  address.sin_family = AF_INET;
  address.sin_port = htons(port);
  address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  if (connect(socket, reinterpret_cast<sockaddr*>(&address), sizeof(address)) == SOCKET_ERROR) {
    if (WSAGetLastError() != WSAEWOULDBLOCK) fail();
    fd_set writable, errors;
    FD_ZERO(&writable); FD_SET(socket, &writable);
    FD_ZERO(&errors); FD_SET(socket, &errors);
    timeval timeout{30, 0};
    if (select(0, nullptr, &writable, &errors, &timeout) <= 0 || FD_ISSET(socket, &errors)) fail();
    int error = 0, length = sizeof(error);
    if (getsockopt(socket, SOL_SOCKET, SO_ERROR, reinterpret_cast<char*>(&error), &length) != 0 || error != 0) fail();
  }
  nonblocking = 0;
  if (ioctlsocket(socket, FIONBIO, &nonblocking) != 0) fail();
  BOOL no_delay = TRUE;
  if (setsockopt(socket, IPPROTO_TCP, TCP_NODELAY, reinterpret_cast<char*>(&no_delay), sizeof(no_delay)) != 0) fail();
}

bool send_all(SOCKET socket, const char* bytes, size_t size) {
  while (size > 0) {
    const int written = send(socket, bytes, static_cast<int>(std::min(size, size_t{65536})), 0);
    if (written <= 0) return false;
    bytes += written; size -= static_cast<size_t>(written);
  }
  return true;
}

void authenticate(SOCKET socket, const std::string& token) {
  DWORD timeout = startup_timeout_ms;
  if (setsockopt(socket, SOL_SOCKET, SO_RCVTIMEO, reinterpret_cast<char*>(&timeout), sizeof(timeout)) != 0 ||
      setsockopt(socket, SOL_SOCKET, SO_SNDTIMEO, reinterpret_cast<char*>(&timeout), sizeof(timeout)) != 0) fail();
  const std::string opening = opening_frame(token);
  if (!send_all(socket, opening.data(), opening.size())) fail();
  std::string ready;
  const ULONGLONG started = GetTickCount64();
  for (;;) {
    const ULONGLONG elapsed = GetTickCount64() - started;
    if (elapsed >= startup_timeout_ms || ready.size() >= 1024) fail();
    timeout = static_cast<DWORD>(startup_timeout_ms - elapsed);
    if (setsockopt(socket, SOL_SOCKET, SO_RCVTIMEO, reinterpret_cast<char*>(&timeout), sizeof(timeout)) != 0) fail();
    char byte;
    if (recv(socket, &byte, 1, 0) != 1) fail();
    if (byte == '\n') break;
    ready += byte;
  }
  if (ready != "{\"ready\":true}") fail();
  timeout = 0;
  if (setsockopt(socket, SOL_SOCKET, SO_RCVTIMEO, reinterpret_cast<char*>(&timeout), sizeof(timeout)) != 0 ||
      setsockopt(socket, SOL_SOCKET, SO_SNDTIMEO, reinterpret_cast<char*>(&timeout), sizeof(timeout)) != 0) fail();
}

bool write_all(HANDLE output, const char* bytes, DWORD size) {
  while (size > 0) {
    DWORD written = 0;
    if (!WriteFile(output, bytes, size, &written, nullptr) || written == 0) return false;
    bytes += written; size -= written;
  }
  return true;
}

void forward(SOCKET socket) {
  std::atomic<bool> input_ended{false}, failed{false}, stopping{false};
  const HANDLE input = GetStdHandle(STD_INPUT_HANDLE);
  const HANDLE output = GetStdHandle(STD_OUTPUT_HANDLE);
  std::thread upstream([&] {
    char buffer[65536];
    while (!stopping.load()) {
      DWORD count = 0;
      if (!ReadFile(input, buffer, sizeof(buffer), &count, nullptr)) {
        if (GetLastError() == ERROR_BROKEN_PIPE) count = 0;
        else { if (!stopping.load()) failed.store(true); shutdown(socket, SD_BOTH); return; }
      }
      if (count == 0) { input_ended.store(true); shutdown(socket, SD_SEND); return; }
      if (!send_all(socket, buffer, count)) { failed.store(true); shutdown(socket, SD_BOTH); return; }
    }
  });
  char buffer[65536];
  for (;;) {
    const int count = recv(socket, buffer, sizeof(buffer), 0);
    if (count == 0) break;
    if (count < 0 || !write_all(output, buffer, static_cast<DWORD>(count))) { failed.store(true); break; }
  }
  stopping.store(true);
  shutdown(socket, SD_BOTH);
  // The pipe can stay open after backend failure. Cancel its owned blocking read
  // and await the thread; never leave a helper process waiting on client stdin.
  do {
    CancelSynchronousIo(upstream.native_handle());
  } while (WaitForSingleObject(upstream.native_handle(), 10) == WAIT_TIMEOUT);
  upstream.join();
  if (failed.load() || !input_ended.load() || interrupted.load()) fail();
}
}  // namespace

int wmain(int argc, wchar_t** argv) {
  if (argc == 2 && std::wcscmp(argv[1], L"--help") == 0) {
    std::fputs("REA native stdio bridge (Windows x64). Set REA_MCP_SHARED_ENDPOINT to the backend endpoint file. No arguments are required.\n", stdout);
    return 0;
  }
  try {
    if (argc != 1) fail();
    Winsock winsock;
    const Endpoint endpoint = read_endpoint(environment_value(L"REA_MCP_SHARED_ENDPOINT"));
    Connection connection{socket(AF_INET, SOCK_STREAM, IPPROTO_TCP)};
    if (connection.value == INVALID_SOCKET) fail();
    active_socket.store(connection.value);
    SetConsoleCtrlHandler(interrupt, TRUE);
    connect_loopback(connection.value, endpoint.port);
    authenticate(connection.value, endpoint.token);
    forward(connection.value);
    return 0;
  } catch (...) {
    // Never print descriptor contents, environment values, or authentication.
    std::fputs("REA shared MCP connection failed. Check the backend and REA_MCP_SHARED_ENDPOINT.\n", stderr);
    return 1;
  }
}
