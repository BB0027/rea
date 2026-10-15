import type { ServeStdioOptions } from "@modelcontextprotocol/server/stdio";
import { describe, expect, it } from "vitest";

import { openMcpRuntime, run, runEntrypoint } from "../../../src/main.js";
import { createServer } from "../../../src/server/createServer.js";

type RuntimeDependencies = NonNullable<Parameters<typeof run>[0]>;

const nextTurn = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));

const dependencies = ({
  serve,
  output,
  shutdown,
  exitCodes,
  shutdownUnregistrations = [],
  loadOptionalProviders,
}: {
  readonly serve: RuntimeDependencies["serve"];
  readonly output: string[];
  readonly shutdown: Array<() => void>;
  readonly exitCodes: number[];
  readonly shutdownUnregistrations?: string[];
  readonly loadOptionalProviders?: RuntimeDependencies["loadOptionalProviders"];
}): RuntimeDependencies => ({
  env: {},
  serve,
  writeStderr: (text) => output.push(text),
  setExitCode: (code) => exitCodes.push(code),
  registerShutdown: (handler) => {
    shutdown.push(handler);
    return () => shutdownUnregistrations.push("shutdown");
  },
  ...(loadOptionalProviders === undefined ? {} : { loadOptionalProviders }),
});

describe("MCP runtime errors", () => {
  it("retains server resources for retry when transport teardown suppresses a provider cleanup failure", async () => {
    let cleanupAllowed = false;
    let closeCalls = 0;
    const runtime = await openMcpRuntime({
      ...dependencies({
        serve: (factory) => {
          void factory({ era: "legacy" });
          // The SDK reports provider errors through onerror but resolves close.
          return { close: async () => undefined };
        },
        output: [],
        shutdown: [],
        exitCodes: [],
      }),
      createServer: (source, options) => {
        const server = createServer(source, options);
        const close = server.close.bind(server);
        server.close = async () => {
          closeCalls += 1;
          if (!cleanupAllowed) throw new Error("provider cleanup denied");
          await close();
        };
        return server;
      },
    });
    if (!runtime.ok) throw new Error("Runtime did not start");
    try {
      await expect(runtime.close()).rejects.toThrow("provider cleanup denied");
    } finally {
      cleanupAllowed = true;
      await runtime.close();
    }
    expect(closeCalls).toBe(2);
  });

  it("reports connection loss without the transport cause", async () => {
    const output: string[] = [];
    const shutdown: Array<() => void> = [];
    const shutdownUnregistrations: string[] = [];
    let options: ServeStdioOptions | undefined;
    let closeCalls = 0;
    const close = (): Promise<void> => {
      closeCalls += 1;
      return Promise.resolve();
    };
    const exitCodes: number[] = [];
    expect(
      await run(
        dependencies({
          serve: (_factory, received) => {
            options = received;
            return { close };
          },
          output,
          shutdown,
          exitCodes,
          shutdownUnregistrations,
        }),
      ),
    ).toBe(0);
    options?.onerror?.(new Error("SECRET transport stack"));
    expect(output).toEqual([
      "REA lost its MCP client connection. Restart REA from your MCP client.\n",
    ]);
    shutdown[0]?.();
    await nextTurn();
    expect(closeCalls).toBe(1);
    expect(shutdownUnregistrations).toEqual(["shutdown"]);
  });

  it("unregisters every process-lifetime handler during idempotent shutdown", async () => {
    const shutdown: Array<() => void> = [];
    const unregistrations: string[] = [];
    let closeCalls = 0;
    const runtime: RuntimeDependencies = {
      ...dependencies({
        serve: () => ({
          close: async () => {
            closeCalls += 1;
          },
        }),
        output: [],
        shutdown,
        exitCodes: [],
        shutdownUnregistrations: unregistrations,
      }),
    };

    expect(await run(runtime)).toBe(0);
    expect(shutdown).toHaveLength(1);

    shutdown[0]?.();
    shutdown[0]?.();
    await nextTurn();

    expect(closeCalls).toBe(1);
    expect(unregistrations).toEqual(["shutdown"]);
  });

  it("reports transport startup failure without its cause", async () => {
    const output: string[] = [];
    expect(
      await run(
        dependencies({
          serve: () => {
            throw new Error("SECRET startup stack");
          },
          output,
          shutdown: [],
          exitCodes: [],
        }),
      ),
    ).toBe(1);
    expect(output).toEqual([
      "REA could not start its MCP connection. Restart REA from your MCP client; run `rea doctor` if it fails again.\n",
    ]);
  });

  it("reports shutdown failure and sets a failing exit code", async () => {
    const output: string[] = [];
    const shutdown: Array<() => void> = [];
    const exitCodes: number[] = [];
    await run(
      dependencies({
        serve: () => ({
          close: () => Promise.reject(new Error("SECRET close")),
        }),
        output,
        shutdown,
        exitCodes,
      }),
    );
    shutdown[0]?.();
    await nextTurn();
    expect(exitCodes).toEqual([1]);
    expect(output).toEqual([
      "REA could not close cleanly. End the REA process before starting it again.\n",
    ]);
  });

  it("reports an unexpected entrypoint failure without its cause", async () => {
    const output: string[] = [];
    const exitCodes: number[] = [];
    await runEntrypoint(
      () => Promise.reject(new Error("SECRET entrypoint stack")),
      (text) => output.push(text),
      (code) => exitCodes.push(code),
    );
    expect(output).toEqual([
      "REA could not start. Run `rea doctor`, then restart REA from your MCP client.\n",
    ]);
    expect(exitCodes).toEqual([1]);
  });
});
