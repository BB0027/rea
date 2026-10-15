#!/usr/bin/env node
import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const packageJson = JSON.parse(
  await readFile(new URL("package.json", root), "utf8"),
);
let manifest;
try {
  manifest = JSON.parse(
    await readFile(
      new URL("native/mcp-bridge/build/manifest.json", root),
      "utf8",
    ),
  );
} catch (cause) {
  if (process.argv.includes("--if-present") && cause?.code === "ENOENT") {
    try {
      await access(
        new URL("native/mcp-bridge/build/rea-mcp-bridge-win32-x64.exe", root),
      );
    } catch (missing) {
      if (missing?.code === "ENOENT") process.exit(0);
      throw missing;
    }
  }
  throw cause;
}
const bytes = await readFile(
  new URL("native/mcp-bridge/build/rea-mcp-bridge-win32-x64.exe", root),
);
if (
  manifest.version !== packageJson.version ||
  manifest.platform !== "win32" ||
  manifest.arch !== "x64" ||
  manifest.protocol !== 1 ||
  manifest.file !== "rea-mcp-bridge-win32-x64.exe" ||
  manifest.bytes !== bytes.length ||
  manifest.sha256 !== createHash("sha256").update(bytes).digest("hex")
)
  throw new Error(
    "Native MCP bridge manifest does not match this package; rebuild it.",
  );
try {
  const source = await readFile(new URL("native/mcp-bridge/windows.cc", root));
  if (
    manifest.sourceSha256 !== createHash("sha256").update(source).digest("hex")
  )
    throw new Error(
      "Native MCP bridge source changed; rebuild the executable before packing.",
    );
} catch (cause) {
  // Published packages carry the verified executable, not the C++ source.
  if (cause?.code !== "ENOENT") throw cause;
}
const offset = bytes.length >= 64 ? bytes.readUInt32LE(0x3c) : bytes.length;
if (
  bytes.toString("ascii", 0, 2) !== "MZ" ||
  offset > bytes.length - 26 ||
  bytes.toString("ascii", offset, offset + 4) !== "PE\0\0" ||
  bytes.readUInt16LE(offset + 4) !== 0x8664 ||
  bytes.readUInt16LE(offset + 24) !== 0x20b
)
  throw new Error("Native MCP bridge must be a Windows x64 PE32+ executable.");
process.stdout.write(
  `Verified native MCP bridge (${String(bytes.length)} bytes).\n`,
);
