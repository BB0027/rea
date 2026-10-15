import { open } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { isAbsolute, resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import {
  readSharedMcpLine,
  sharedMcpEndpointSchema,
} from "./sharedMcpProtocol.js";

const STARTUP_TIMEOUT_MS = 30_000;

/** A stdio bridge imports no analysis runtime and forwards MCP bytes with backpressure. */
export const connectSharedMcp = async (
  endpointFile: string,
  environment: NodeJS.ProcessEnv,
  input: Readable = process.stdin,
  output: Writable = process.stdout,
): Promise<void> => {
  if (!isAbsolute(endpointFile))
    throw new Error("Shared MCP endpoint path must be absolute");
  const file = await open(endpointFile, "r");
  let endpoint;
  try {
    const bytes = Buffer.alloc(4097);
    const read = await file.read(bytes, 0, bytes.length, 0);
    if (read.bytesRead > 4096)
      throw new Error("Shared MCP endpoint file is too large");
    endpoint = sharedMcpEndpointSchema.parse(
      JSON.parse(bytes.subarray(0, read.bytesRead).toString("utf8")),
    );
  } finally {
    await file.close();
  }
  const socket = connect({ host: "127.0.0.1", port: endpoint.port });
  // The opening owns error handling from connect through authentication.
  const ready = readSharedMcpLine(socket, 1024, STARTUP_TIMEOUT_MS);
  const selectedEnvironment = Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  delete selectedEnvironment.REA_MCP_SHARED_ENDPOINT;
  if (selectedEnvironment.HOPPER_TARGET_PATH) {
    selectedEnvironment.HOPPER_TARGET_PATH = resolve(
      selectedEnvironment.HOPPER_TARGET_PATH,
    );
  }
  socket.write(
    `${JSON.stringify({ version: 1, token: endpoint.token, environment: selectedEnvironment, cwd: process.cwd() })}\n`,
  );
  try {
    if ((await ready) !== '{"ready":true}')
      throw new Error("Shared MCP backend refused the connection");
    await forwardStdio(socket, input, output);
  } finally {
    socket.destroy();
  }
};

const forwardStdio = (
  socket: Socket,
  input: Readable,
  output: Writable,
): Promise<void> =>
  new Promise((resolve, reject) => {
    let inputEnded = input.readableEnded;
    let failure: Error | undefined;
    const fail = (error: Error): void => {
      failure ??= error;
      socket.destroy();
    };
    const onEnd = (): void => {
      inputEnded = true;
      socket.end();
    };
    socket.once("close", () => {
      input.unpipe(socket);
      input.pause();
      socket.unpipe(output);
      input.off("end", onEnd);
      input.off("close", onEnd);
      input.off("error", fail);
      output.off("error", fail);
      socket.off("error", fail);
      if (failure) reject(failure);
      else if (!inputEnded)
        reject(
          new Error("Shared MCP backend disconnected; reconnect the client"),
        );
      else resolve();
    });
    socket.on("error", fail);
    input.on("error", fail);
    output.on("error", fail);
    input.once("end", onEnd);
    input.once("close", onEnd);
    socket.pipe(output, { end: false });
    input.pipe(socket);
    socket.resume();
    if (inputEnded || input.destroyed) onEnd();
  });

export const runSharedMcpClient = async (
  endpointFile: string,
): Promise<void> => {
  try {
    await connectSharedMcp(endpointFile, process.env);
  } catch {
    process.stderr.write(
      "REA shared MCP connection failed. Start the backend and check REA_MCP_SHARED_ENDPOINT.\n",
    );
    process.exitCode = 1;
  }
};
