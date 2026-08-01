import { access } from "node:fs/promises";
import path from "node:path";
import { pathExists } from "./files.mjs";

async function firstAccessible(candidates) {
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Continue.
    }
  }
  return null;
}

export async function discoverCodexInvocation() {
  const pathEntries = (process.env.PATH ?? "").split(path.delimiter);
  if (process.platform === "win32") {
    for (const directory of pathEntries) {
      if (!directory) continue;
      const native = await firstAccessible([path.join(directory, "codex.exe")]);
      if (native) return { command: native, prefixArgs: [], kind: "native" };
      const shim = path.join(directory, "codex.cmd");
      if (await pathExists(shim)) {
        const script = path.join(
          directory,
          "node_modules",
          "@openai",
          "codex",
          "bin",
          "codex.js"
        );
        const node = await firstAccessible([
          path.join(directory, "node.exe"),
          process.execPath
        ]);
        if (node && await pathExists(script)) {
          return { command: node, prefixArgs: [script], kind: "npm-cmd-direct" };
        }
      }
    }
  }
  for (const directory of pathEntries) {
    if (!directory) continue;
    const executable = await firstAccessible([path.join(directory, "codex")]);
    if (executable) return { command: executable, prefixArgs: [], kind: "path" };
  }
  throw new Error("unable to locate a safe Codex executable");
}
