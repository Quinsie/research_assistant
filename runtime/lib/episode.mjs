import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { pathExists } from "./files.mjs";
import { loadCanonicalNodes, validateProject } from "./validator.mjs";

const TERMINAL_STATUSES = new Set([
  "terminal",
  "completed",
  "blocked",
  "abandoned",
  "superseded"
]);

export async function authorizeTerminalEpisode(target, options) {
  const root = path.resolve(target);
  if (!options.workId || !options.episodeId) {
    throw new Error("workId and episodeId are required");
  }
  const validation = await validateProject(root);
  if (
    !validation.valid ||
    validation.findings.some((item) =>
      ["CANONICAL_UNINTEGRATED_EDIT", "INTEGRITY_LEDGER_MISSING"].includes(
        item.code
      )
    )
  ) {
    throw new Error("canonical state must validate before terminal authorization");
  }
  const loaded = await loadCanonicalNodes(root);
  const records = loaded.nodes.flatMap((node) =>
    node.metadata.records ?? [node.metadata]
  );
  const current = records.find((record) => record.type === "current");
  const work = records.find((record) => record.id === options.workId);
  if (!work || work.type !== "work") throw new Error("terminal work record is missing");
  if (!TERMINAL_STATUSES.has(work.status)) {
    throw new Error(`work ${options.workId} is not terminal`);
  }
  if (current.active_work_id !== options.workId) {
    throw new Error("CURRENT does not identify the terminal work");
  }
  if (!["terminal", "blocked"].includes(current.activity_status)) {
    throw new Error("CURRENT activity is not at a terminal reporting boundary");
  }
  const ledgerPath = path.join(
    root,
    ".assistant",
    "internal",
    "work",
    "terminal-events.jsonl"
  );
  const existing = await pathExists(ledgerPath)
    ? (await readFile(ledgerPath, "utf8")).split(/\r?\n/u).filter(Boolean).map(JSON.parse)
    : [];
  const prior = existing.find(
    (item) =>
      item.work_id === options.workId &&
      item.episode_id === options.episodeId &&
      item.event === "authorized"
  );
  if (prior) return { ...prior, idempotent: true };
  const record = {
    schema: "assistant.terminal-event/v1",
    event: "authorized",
    work_id: options.workId,
    episode_id: options.episodeId,
    locale: options.locale || null,
    canonical_validation_at: new Date().toISOString(),
    authorized_at: new Date().toISOString()
  };
  await mkdir(path.dirname(ledgerPath), { recursive: true });
  await appendFile(ledgerPath, `${JSON.stringify(record)}\n`, "utf8");
  return { ...record, idempotent: false };
}
