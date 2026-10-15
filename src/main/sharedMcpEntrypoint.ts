import { startSharedMcpServer } from "./sharedMcpServer.js";

export const runSharedMcpServer = async (
  args: readonly string[],
): Promise<void> => {
  if (args.length === 1 && args[0] === "--help") {
    process.stdout.write(
      "Usage: rea mcp serve [--idle-timeout-ms 60000] [--max-clients 32]\nStart one local shared backend. Set REA_MCP_SHARED_ENDPOINT to the emitted endpointFile for each `rea mcp` client. A timeout of 0 keeps the backend running until stopped.\n",
    );
    return;
  }
  try {
    const options: { idleTimeoutMs?: number; maxClients?: number } = {};
    for (let i = 0; i < args.length; i += 2) {
      const value = args[i + 1];
      if (value === undefined || !/^\d+$/u.test(value))
        throw new Error("Invalid shared MCP arguments");
      if (args[i] === "--idle-timeout-ms")
        options.idleTimeoutMs = Number(value);
      else if (args[i] === "--max-clients") options.maxClients = Number(value);
      else throw new Error("Unknown shared MCP argument");
    }
    const backend = await startSharedMcpServer(options);
    const stop = (): void => {
      void backend.close().catch(() => {
        process.exitCode = 1;
      });
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    process.stdout.write(
      `${JSON.stringify({ endpointFile: backend.endpointFile, pid: process.pid })}\n`,
    );
    await backend.closed;
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  } catch {
    process.stderr.write(
      "REA shared MCP backend could not start. Check arguments and private runtime support.\n",
    );
    process.exitCode = 1;
  }
};
