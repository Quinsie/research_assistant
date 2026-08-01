import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { listFilesRecursive, pathExists, writeUtf8 } from "./files.mjs";

const LEDGER_RELATIVE = ".assistant/internal/validated-hashes.json";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function canonicalPaths(root) {
  const paths = [".assistant/CURRENT.md", ".assistant/POLICY.md"];
  if (await pathExists(path.join(root, ".assistant", "PLAN.md"))) {
    paths.push(".assistant/PLAN.md");
  }
  const knowledgeRoot = path.join(root, ".assistant", "knowledge");
  if (await pathExists(knowledgeRoot)) {
    for (const entry of await listFilesRecursive(knowledgeRoot)) {
      if (entry.kind === "file" && entry.path.toLowerCase().endsWith(".md")) {
        paths.push(`.assistant/knowledge/${entry.path}`);
      }
    }
  }
  return paths.sort((a, b) => a.localeCompare(b, "en"));
}

async function currentHashes(root) {
  const hashes = {};
  for (const relative of await canonicalPaths(root)) {
    hashes[relative] = sha256(
      await readFile(path.join(root, ...relative.split("/")))
    );
  }
  return hashes;
}

export async function refreshValidatedHashes(target, reason) {
  const root = path.resolve(target);
  const record = {
    schema: "assistant.validated-hashes/v1",
    reason,
    recorded_at: new Date().toISOString(),
    hashes: await currentHashes(root)
  };
  await writeUtf8(
    path.join(root, ...LEDGER_RELATIVE.split("/")),
    `${JSON.stringify(record, null, 2)}\n`
  );
  return record;
}

export async function inspectValidatedHashes(target) {
  const root = path.resolve(target);
  const ledgerPath = path.join(root, ...LEDGER_RELATIVE.split("/"));
  if (!(await pathExists(ledgerPath))) {
    return {
      schema: "assistant.integrity-result/v1",
      status: "missing",
      changed: [],
      added: [],
      removed: []
    };
  }
  const ledger = JSON.parse(await readFile(ledgerPath, "utf8"));
  if (
    ledger.schema !== "assistant.validated-hashes/v1" ||
    typeof ledger.hashes !== "object" ||
    ledger.hashes === null
  ) {
    throw new Error("validated hash ledger is invalid");
  }
  const current = await currentHashes(root);
  const changed = Object.keys(current).filter(
    (relative) =>
      Object.hasOwn(ledger.hashes, relative) &&
      ledger.hashes[relative] !== current[relative]
  );
  const added = Object.keys(current).filter(
    (relative) => !Object.hasOwn(ledger.hashes, relative)
  );
  const removed = Object.keys(ledger.hashes).filter(
    (relative) => !Object.hasOwn(current, relative)
  );
  return {
    schema: "assistant.integrity-result/v1",
    status:
      changed.length + added.length + removed.length === 0
        ? "clean"
        : "candidate_unintegrated",
    changed,
    added,
    removed,
    ledger_recorded_at: ledger.recorded_at
  };
}
