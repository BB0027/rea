#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
if (process.platform !== "win32")
  throw new Error(
    "The native MCP bridge build currently requires Windows and existing Visual Studio C++ Build Tools.",
  );
const vswhere = join(
  process.env["ProgramFiles(x86)"] ?? "C:/Program Files (x86)",
  "Microsoft Visual Studio/Installer/vswhere.exe",
);
const installation = execFileSync(
  vswhere,
  [
    "-latest",
    "-products",
    "*",
    "-requires",
    "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
    "-property",
    "installationPath",
  ],
  { encoding: "utf8", windowsHide: true },
).trim();
if (!installation)
  throw new Error(
    "Install Visual Studio C++ Build Tools separately before building the native MCP bridge.",
  );
const vcvars = join(installation, "VC/Auxiliary/Build/vcvars64.bat");
if (/["%\r\n&|<>^]/u.test(vcvars))
  throw new Error("Unsupported compiler environment path");
// vcvars is the toolchain's environment initializer. Its output stays in memory.
const initialized = execFileSync(
  process.env.ComSpec ?? "cmd.exe",
  ["/d", "/u", "/s", "/c", `""${vcvars}" >nul && set"`],
  { encoding: "utf16le", windowsHide: true, windowsVerbatimArguments: true },
);
const env = { ...process.env };
for (const line of initialized.split(/\r?\n/u)) {
  const separator = line.indexOf("=");
  if (separator > 0) env[line.slice(0, separator)] = line.slice(separator + 1);
}
const toolchain = env.VCToolsInstallDir;
if (!toolchain)
  throw new Error(
    "The C++ compiler environment did not report VCToolsInstallDir",
  );
const output = join(root, "native/mcp-bridge/build");
await mkdir(output, { recursive: true });
const binary = join(output, "rea-mcp-bridge-win32-x64.exe");
execFileSync(
  join(toolchain, "bin/Hostx64/x64/cl.exe"),
  [
    "/nologo",
    "/std:c++17",
    "/EHsc",
    "/W4",
    "/WX",
    "/O2",
    "/MT",
    "/DUNICODE",
    "/D_UNICODE",
    "/D_WIN32_WINNT=0x0A00",
    `/Fe:${binary}`,
    `/Fo:${join(output, "bridge.obj")}`,
    join(root, "native/mcp-bridge/windows.cc"),
    "ws2_32.lib",
  ],
  { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
);
const bytes = await readFile(binary);
const metadata = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
await writeFile(
  join(output, "manifest.json"),
  JSON.stringify(
    {
      version: metadata.version,
      platform: "win32",
      arch: "x64",
      protocol: 1,
      file: "rea-mcp-bridge-win32-x64.exe",
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      sourceSha256: createHash("sha256")
        .update(await readFile(join(root, "native/mcp-bridge/windows.cc")))
        .digest("hex"),
    },
    null,
    2,
  ) + "\n",
);
process.stdout.write(
  `Built native MCP bridge: ${binary} (${String(bytes.length)} bytes)\n`,
);
