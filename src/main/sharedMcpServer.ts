import { randomBytes, timingSafeEqual } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { PrivateRuntimeRoot } from "../process/PrivateRuntimeRoot.js";
import {
  readSharedMcpLine,
  sharedMcpOpeningSchema,
} from "./sharedMcpProtocol.js";

type Runtime = Awaited<ReturnType<typeof import("../main.js").openMcpRuntime>>;
type RuntimeModule = typeof import("../main.js");
interface Connection {
  readonly socket: Socket;
  readonly runtime: Promise<Runtime>;
  closeAttempt?: Promise<void>;
}

export interface SharedMcpServer {
  readonly endpointFile: string;
  readonly closed: Promise<void>;
  close(): Promise<void>;
}

/** Own one loopback listener and a separate production runtime per authenticated connection. */
export const startSharedMcpServer = async (
  options: {
    readonly idleTimeoutMs?: number;
    readonly maxClients?: number;
    readonly writeStderr?: (text: string) => void;
  } = {},
): Promise<SharedMcpServer> => {
  const idleTimeoutMs = options.idleTimeoutMs ?? 60_000;
  const maxClients = options.maxClients ?? 32;
  if (
    !Number.isSafeInteger(idleTimeoutMs) ||
    idleTimeoutMs < 0 ||
    !Number.isSafeInteger(maxClients) ||
    maxClients < 1
  )
    throw new Error("Invalid shared MCP limits");
  const writeStderr =
    options.writeStderr ??
    ((text: string) => {
      process.stderr.write(text);
    });
  const root = await PrivateRuntimeRoot.create({ prefix: "rea-shared-mcp-" });
  const token = randomBytes(32).toString("hex");
  const connections = new Set<Connection>();
  let runtimeModule: Promise<RuntimeModule> | undefined;
  let idleTimer: NodeJS.Timeout | undefined;
  let cleanupRetryTimer: NodeJS.Timeout | undefined;
  let stopping = false;
  let closeAttempt: Promise<void> | undefined;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  const server = createServer((socket) => {
    socket.on("error", () => {
      socket.destroy();
    });
    if (stopping || connections.size >= maxClients) {
      socket.destroy();
      return;
    }
    clearTimeout(idleTimer);
    const connection: Connection = { socket, runtime: openConnection(socket) };
    connections.add(connection);
    socket.once("close", () => {
      void retire(connection).catch(reportCleanupFailure);
    });
    void connection.runtime.catch(() => {
      socket.destroy();
    });
  });
  const reportCleanupFailure = (): void => {
    writeStderr(
      "REA shared MCP cleanup failed; the backend retains the connection for cleanup retry.\n",
    );
    cleanupRetryTimer ??= setTimeout(() => {
      cleanupRetryTimer = undefined;
      const retry = stopping
        ? close()
        : Promise.all(
            [...connections]
              .filter(({ socket }) => socket.destroyed)
              .map(retire),
          );
      void retry.catch(reportCleanupFailure);
    }, 5000);
  };
  const scheduleIdleClose = (): void => {
    clearTimeout(idleTimer);
    if (!stopping && connections.size === 0 && idleTimeoutMs > 0) {
      idleTimer = setTimeout(() => {
        void close().catch(reportCleanupFailure);
      }, idleTimeoutMs);
    }
  };
  const retire = (connection: Connection): Promise<void> => {
    connection.closeAttempt ??= (async () => {
      const runtime = await connection.runtime.catch(() => undefined);
      await runtime?.close?.();
      connections.delete(connection);
      scheduleIdleClose();
    })().catch((cause: unknown) => {
      delete connection.closeAttempt;
      throw cause;
    });
    return connection.closeAttempt;
  };
  const openConnection = async (socket: Socket): Promise<Runtime> => {
    // Authentication precedes importing the heavy analysis graph or constructing a session.
    const opening = sharedMcpOpeningSchema.parse(
      JSON.parse(await readSharedMcpLine(socket, 1024 * 1024, 5000)),
    );
    if (
      !timingSafeEqual(
        Buffer.from(opening.token, "hex"),
        Buffer.from(token, "hex"),
      )
    )
      throw new Error("Authentication failed");
    runtimeModule ??= import("../main.js");
    const [{ openMcpRuntime }, { serveStdio, StdioServerTransport }] =
      await Promise.all([
        runtimeModule,
        import("@modelcontextprotocol/server/stdio"),
      ]);
    if (socket.destroyed) throw new Error("Client disconnected during startup");
    const runtime = await openMcpRuntime({
      env: opening.environment,
      cwd: opening.cwd,
      serve: (factory, serveOptions) =>
        serveStdio(factory, {
          ...serveOptions,
          transport: new StdioServerTransport(socket, socket),
        }),
      writeStderr,
      setExitCode: () => {
        socket.destroy();
      },
      registerShutdown: () => () => undefined,
    });
    if (!runtime.ok) {
      socket.destroy();
      return runtime;
    }
    // The connection remains the cleanup owner even when disconnect races startup.
    if (socket.destroyed) return runtime;
    socket.write('{"ready":true}\n');
    socket.resume();
    return runtime;
  };
  const close = (): Promise<void> => {
    closeAttempt ??= (async () => {
      stopping = true;
      clearTimeout(idleTimer);
      clearTimeout(cleanupRetryTimer);
      cleanupRetryTimer = undefined;
      const listenerClosed = new Promise<void>((resolve, reject) => {
        if (!server.listening) {
          resolve();
          return;
        }
        server.close((error) => (error ? reject(error) : resolve()));
      });
      const results = await Promise.allSettled(
        [...connections].map((connection) => {
          connection.socket.destroy();
          return retire(connection);
        }),
      );
      await listenerClosed;
      const failures = results.filter((result) => result.status === "rejected");
      if (failures.length)
        throw new AggregateError(
          failures.map((result) => result.reason),
          "Shared MCP cleanup failed",
        );
      await root.close();
      resolveClosed();
    })().catch((cause: unknown) => {
      closeAttempt = undefined;
      throw cause;
    });
    return closeAttempt;
  };
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new Error("Missing shared MCP port");
    const endpointFile = join(root.path, "endpoint.json");
    await writeFile(
      endpointFile,
      JSON.stringify({ version: 1, port: address.port, token }),
      { flag: "wx", mode: 0o600 },
    );
    scheduleIdleClose();
    return { endpointFile, closed, close };
  } catch (cause: unknown) {
    await close();
    throw cause;
  }
};
