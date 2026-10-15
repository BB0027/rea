import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, readFile, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { TextReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";
import { describe, expect, it, onTestFinished } from "vitest";
import { z } from "zod";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";

const dispatcher = fileURLToPath(
  new URL("../../scripts/rea.mjs", import.meta.url),
);

async function startBackend(maxClients = 32) {
  const backend = spawn(
    process.execPath,
    [
      dispatcher,
      "mcp",
      "serve",
      "--idle-timeout-ms",
      "3000",
      "--max-clients",
      String(maxClients),
    ],
    {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: { ...process.env, REA_LOG_LEVEL: "silent" },
    },
  );
  const exited = once(backend, "exit");
  const lines = createInterface({ input: backend.stdout });
  let stderr = "";
  backend.stderr.on("data", (data: Buffer) => {
    stderr += data.toString();
  });
  onTestFinished(async () => {
    if (backend.exitCode === null && backend.signalCode === null)
      backend.kill();
    await exited;
    lines.close();
  });
  const opening = await Promise.race([
    once(lines, "line").then(([line]) => z.string().parse(line)),
    exited.then(() => {
      throw new Error(`Shared backend exited before readiness: ${stderr}`);
    }),
  ]);
  const ready = z
    .object({ endpointFile: z.string(), pid: z.number().int() })
    .parse(JSON.parse(opening));
  expect(ready.pid).toBe(backend.pid);
  return { ...ready, exited, stderr: () => stderr };
}

for (const mode of ["node", "native"] as const) {
  describe.skipIf(
    mode === "native" &&
      (process.platform !== "win32" ||
        process.env.REA_TEST_NATIVE_MCP_BRIDGE !== "1"),
  )(`${mode} shared MCP bridge`, () => {
    async function connectClient(
      endpointFile: string,
      env: Record<string, string> = {},
    ) {
      const transport = new StdioClientTransport({
        command:
          mode === "native"
            ? fileURLToPath(
                new URL(
                  "../../native/mcp-bridge/build/rea-mcp-bridge-win32-x64.exe",
                  import.meta.url,
                ),
              )
            : process.execPath,
        args: mode === "native" ? [] : [dispatcher, "mcp"],
        env: {
          PATH: process.env.PATH ?? "",
          REA_LOG_LEVEL: "silent",
          REA_MCP_SHARED_ENDPOINT: endpointFile,
          ...env,
        },
        stderr: "pipe",
      });
      const client = new Client({ name: "shared-client", version: "1" });
      onTestFinished(async () => {
        await client.close();
        await transport.close();
      });
      await client.connect(transport);
      return client;
    }

    async function call(
      client: Client,
      name: string,
      args: Record<string, unknown> = {},
    ) {
      const response = await client.callTool({ name, arguments: args });
      expect(response.isError, JSON.stringify(response)).not.toBe(true);
      return response.structuredContent;
    }

    it("isolates targets, evidence and configuration and retires the backend after the last client", async () => {
      const root = await createTestTempDirectory("rea-shared-isolation-");
      const targets: string[] = [];
      for (const name of ["first", "second"]) {
        const writer = new ZipWriter(new Uint8ArrayWriter());
        await writer.add(`${name}.txt`, new TextReader(name));
        const target = join(root, `${name}.zip`);
        await writeFile(target, await writer.close());
        targets.push(target);
      }
      const backend = await startBackend();
      const first = await connectClient(backend.endpointFile, {
        REA_MCP_INPUT_SCHEMA_PROFILE: "full",
      });
      const originalCatalog = (await first.listTools()).tools;
      const second = await connectClient(backend.endpointFile, {
        REA_MCP_INPUT_SCHEMA_PROFILE: "compact",
      });
      expect(
        (await second.listTools()).tools.map((tool) => tool.inputSchema),
      ).not.toEqual(originalCatalog.map((tool) => tool.inputSchema));
      expect((await first.listTools()).tools).toEqual(originalCatalog);
      await expect(
        connectClient(backend.endpointFile, { REA_LOG_LEVEL: "invalid" }),
      ).rejects.toThrow();
      await Promise.all(
        [first, second].map((client, i) =>
          call(client, "open_binary", { path: targets[i] }),
        ),
      );
      expect(await call(first, "binary_session")).toMatchObject({
        result: { open: true, path: targets[0] },
      });
      expect(await call(second, "binary_session")).toMatchObject({
        result: { open: true, path: targets[1] },
      });
      const untouched = await call(second, "get_evidence_bundle");
      const empty = await call(first, "get_evidence_bundle");
      await call(first, "inspect_artifact");
      expect(await call(first, "get_evidence_bundle")).not.toEqual(empty);
      expect(await call(second, "get_evidence_bundle")).toEqual(untouched);
      await call(first, "close_binary");
      await first.close();
      expect(await call(second, "binary_session")).toMatchObject({
        result: { open: true, path: targets[1] },
      });
      await call(second, "inspect_artifact");
      await second.close();
      const [code] = await backend.exited;
      expect(code, backend.stderr()).toBe(0);
      await expect(access(backend.endpointFile)).rejects.toMatchObject({
        code: "ENOENT",
      });
    }, 60_000);

    it("rejects unauthenticated peers and excess clients without damaging the active session", async () => {
      const backend = await startBackend(1);
      const endpoint = z
        .object({ port: z.number(), token: z.string() })
        .parse(JSON.parse(await readFile(backend.endpointFile, "utf8")));
      const socket = connect({ host: "127.0.0.1", port: endpoint.port });
      onTestFinished(() => {
        socket.destroy();
      });
      const rejected = once(socket, "close");
      socket.write(
        `${JSON.stringify({ version: 1, token: "0".repeat(64), environment: {}, cwd: process.cwd() })}\n`,
      );
      await rejected;
      const first = await connectClient(backend.endpointFile);
      await expect(connectClient(backend.endpointFile)).rejects.toThrow();
      expect(
        (await first.listTools()).tools.some(
          (tool) => tool.name === "open_binary",
        ),
      ).toBe(true);
      await first.close();
      expect((await backend.exited)[0], backend.stderr()).toBe(0);
      expect(backend.stderr()).not.toContain(endpoint.token);
    }, 60_000);
  });
}
