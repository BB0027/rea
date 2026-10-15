import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, onTestFinished } from "vitest";
import {
  readSharedMcpLine,
  sharedMcpOpeningSchema,
} from "../../src/main/sharedMcpProtocol.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";

const executable = fileURLToPath(
  new URL(
    "../../native/mcp-bridge/build/rea-mcp-bridge-win32-x64.exe",
    import.meta.url,
  ),
);
const enabled =
  process.platform === "win32" &&
  process.env.REA_TEST_NATIVE_MCP_BRIDGE === "1";
const token = "1".repeat(64);

async function peer(onConnection: (socket: Socket) => void) {
  const root = await createTestTempDirectory("rea-native-bridge-");
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => undefined);
    socket.on("close", () => sockets.delete(socket));
    onConnection(socket);
  });
  onTestFinished(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("Peer did not listen");
  const endpointFile = join(root, "endpoint.json");
  await writeFile(
    endpointFile,
    JSON.stringify({ version: 1, port: address.port, token }),
  );
  return { root, endpointFile, port: address.port };
}

function start(endpointFile: string, cwd: string) {
  const child = spawn(executable, [], {
    cwd,
    windowsHide: true,
    env: {
      ...process.env,
      REA_MCP_SHARED_ENDPOINT: endpointFile,
      REA_BRIDGE_LITERAL: '中文 "引号"\\路径\n下一行',
      HOPPER_TARGET_PATH: "目标.zip",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const exited = once(child, "exit");
  onTestFinished(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
  });
  const output: Buffer[] = [],
    errors: Buffer[] = [];
  child.stdout.on("data", (data: Buffer) => output.push(data));
  child.stderr.on("data", (data: Buffer) => errors.push(data));
  child.stdin.on("error", () => undefined);
  return {
    child,
    exited,
    stdout: () => Buffer.concat(output),
    stderr: () => Buffer.concat(errors).toString(),
  };
}

async function completed(child: ChildProcessWithoutNullStreams) {
  return once(child, "close");
}

describe.skipIf(!enabled)(
  "native shared MCP stream boundary (requires Windows native bridge build)",
  () => {
    it("preserves Unicode environment, client cwd and coalesced binary payloads through EOF", async () => {
      let observed: unknown;
      const errors: unknown[] = [];
      const backend = await peer((socket) => {
        void (async () => {
          observed = JSON.parse(
            await readSharedMcpLine(socket, 1024 * 1024, 5000),
          );
          socket.write('{"ready":true}\nserver-prefix\n');
          socket.pipe(socket);
          socket.resume();
        })().catch((error: unknown) => {
          errors.push(error);
          socket.destroy();
        });
      });
      const cwd = join(backend.root, "工作 目录");
      await mkdir(cwd);
      const bridge = start(backend.endpointFile, cwd);
      const closed = completed(bridge.child);
      const payload = Buffer.alloc(2 * 1024 * 1024);
      for (let i = 0; i < payload.length; i += 1) payload[i] = i % 256;
      bridge.child.stdin.end(payload);
      expect((await closed)[0], bridge.stderr()).toBe(0);
      expect(errors).toEqual([]);
      expect(
        bridge
          .stdout()
          .equals(Buffer.concat([Buffer.from("server-prefix\n"), payload])),
      ).toBe(true);
      const opening = sharedMcpOpeningSchema.parse(observed);
      expect(opening.cwd).toBe(cwd);
      expect(opening.environment.REA_BRIDGE_LITERAL).toBe(
        '中文 "引号"\\路径\n下一行',
      );
      expect(opening.environment.HOPPER_TARGET_PATH).toBe(
        join(cwd, "目标.zip"),
      );
      expect(opening.environment).not.toHaveProperty("REA_MCP_SHARED_ENDPOINT");
      expect(bridge.stderr()).toBe("");
    }, 15_000);

    it("exits on backend loss while the client keeps stdin open", async () => {
      const backend = await peer((socket) => {
        void readSharedMcpLine(socket, 1024 * 1024, 5000)
          .then(() => {
            socket.end('{"ready":true}\n');
          })
          .catch(() => socket.destroy());
      });
      const bridge = start(backend.endpointFile, backend.root);
      const closed = completed(bridge.child);
      expect((await closed)[0]).toBe(1);
      expect(bridge.stderr()).toContain("REA shared MCP connection failed");
      expect(bridge.stderr()).not.toContain(token);
    }, 5000);

    it.each(["oversized", "invalid-port", "extra-field"])(
      "rejects a %s descriptor before connecting",
      async (kind) => {
        let accepted = 0;
        const backend = await peer((socket) => {
          accepted += 1;
          socket.destroy();
        });
        const descriptor =
          kind === "oversized"
            ? " ".repeat(4097)
            : JSON.stringify({
                version: 1,
                port: kind === "invalid-port" ? 65536 : backend.port,
                token,
                ...(kind === "extra-field" ? { extra: true } : {}),
              });
        await writeFile(backend.endpointFile, descriptor);
        const bridge = start(backend.endpointFile, backend.root);
        expect((await completed(bridge.child))[0]).toBe(1);
        expect(bridge.stdout().length).toBe(0);
        expect(accepted).toBe(0);
        expect(bridge.stderr()).not.toContain(token);
      },
    );
  },
);
