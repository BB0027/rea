import type { Socket } from "node:net";
import { isAbsolute } from "node:path";
import { z } from "zod";

export const sharedMcpEndpointSchema = z.strictObject({
  version: z.literal(1),
  port: z.number().int().min(1).max(65_535),
  token: z.string().regex(/^[a-f0-9]{64}$/u),
});

export const sharedMcpOpeningSchema = z.strictObject({
  version: z.literal(1),
  token: z.string().regex(/^[a-f0-9]{64}$/u),
  environment: z.record(z.string(), z.string()),
  cwd: z.string().refine(isAbsolute),
});

/** Read only the bounded opening frame, leaving subsequent MCP bytes paused. */
export const readSharedMcpLine = (
  socket: Socket,
  maxBytes: number,
  timeoutMs: number,
): Promise<string> =>
  new Promise((resolve, reject) => {
    let buffered = Buffer.alloc(0);
    const cleanup = (): void => {
      clearTimeout(timer);
      socket.pause();
      socket.off("data", onData);
      socket.off("error", fail);
      socket.off("end", onEnd);
      socket.off("close", onEnd);
    };
    const fail = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onEnd = (): void =>
      fail(new Error("Shared MCP connection closed during startup"));
    const onData = (chunk: Buffer): void => {
      const end = chunk.indexOf(10);
      const openingBytes = end < 0 ? chunk.length : end;
      if (buffered.length + openingBytes > maxBytes) {
        fail(new Error("Shared MCP opening exceeds its byte limit"));
        return;
      }
      if (end < 0) {
        buffered = Buffer.concat([buffered, chunk]);
        return;
      }
      const line = Buffer.concat([buffered, chunk.subarray(0, end)]).toString(
        "utf8",
      );
      cleanup();
      if (end + 1 < chunk.length) socket.unshift(chunk.subarray(end + 1));
      resolve(line);
    };
    const timer = setTimeout(
      () => fail(new Error("Shared MCP startup timed out")),
      timeoutMs,
    );
    socket.on("data", onData);
    socket.once("error", fail);
    socket.once("end", onEnd);
    socket.once("close", onEnd);
    socket.resume();
  });
