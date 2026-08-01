import { randomUUID, createHash } from "node:crypto";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { assertInside, pathExists, writeUtf8 } from "./files.mjs";
import { parseNodeDocument } from "./meta.mjs";
import { refreshIndex } from "./structure.mjs";
import { refreshValidatedHashes } from "./integrity.mjs";
import { validateProject } from "./validator.mjs";

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function canonicalRelative(relative) {
  const normalized = relative.replaceAll("\\", "/").replace(/^\/+/u, "");
  if (
    ![
      ".assistant/CURRENT.md",
      ".assistant/POLICY.md",
      ".assistant/PLAN.md"
    ].includes(normalized) &&
    !normalized.startsWith(".assistant/knowledge/")
  ) {
    throw new Error(`transaction target is not a canonical owner: ${relative}`);
  }
  if (!normalized.toLowerCase().endsWith(".md")) {
    throw new Error(`canonical target must be Markdown: ${relative}`);
  }
  return normalized;
}

async function restrictedRelatives(root) {
  const registryPath = path.join(
    root,
    ".assistant",
    "internal",
    "restricted",
    "boundaries.json"
  );
  if (!(await pathExists(registryPath))) return [];
  const registry = JSON.parse(await readFile(registryPath, "utf8"));
  if (
    registry.schema !== "assistant.restricted-boundaries/v1" ||
    !Array.isArray(registry.boundaries)
  ) {
    throw new Error("restricted boundary registry is invalid");
  }
  return registry.boundaries.map((item) =>
    String(item.relative).replaceAll("\\", "/").toLowerCase()
  );
}

function assertSourceIndependent(content, relative, dynamicRelatives) {
  const normalized = content.replaceAll("\\", "/").toLowerCase();
  const forbidden = ["docs/user", "docs/report", ...dynamicRelatives];
  const liveReference = forbidden.find((candidate) =>
    normalized.includes(candidate)
  );
  if (liveReference) {
    throw new Error(
      `${relative} contains a forbidden live source/report reference: ${liveReference}`
    );
  }
}

export async function stageCanonicalUpdate(target, specification) {
  const root = path.resolve(target);
  if (!Array.isArray(specification.writes) || specification.writes.length === 0) {
    throw new Error("transaction requires at least one canonical write");
  }
  const id = specification.id || `TXN-${randomUUID()}`;
  const transactionRoot = path.join(
    root,
    ".assistant",
    "internal",
    "transactions",
    id
  );
  if (await pathExists(transactionRoot)) throw new Error(`transaction exists: ${id}`);
  const stagedRoot = path.join(transactionRoot, "staged");
  const writes = [];
  const dynamicRelatives = await restrictedRelatives(root);
  if (specification.type === "source_integration") {
    if (
      !Array.isArray(specification.source_snapshot_ids) ||
      specification.source_snapshot_ids.length === 0 ||
      specification.source_snapshot_ids.some(
        (identity) => !/^snapshot:sha256:[0-9a-f]{64}$/u.test(identity)
      )
    ) {
      throw new Error(
        "source integration requires at least one valid immutable snapshot identity"
      );
    }
    if (!Array.isArray(specification.coverage) || specification.coverage.length === 0) {
      throw new Error("source integration requires section coverage");
    }
    const allowedCoverage = new Set([
      "preserved",
      "consolidated",
      "historical",
      "superseded",
      "omitted_with_reason"
    ]);
    for (const item of specification.coverage) {
      if (
        typeof item.section !== "string" ||
        item.section.trim().length === 0 ||
        !allowedCoverage.has(item.disposition) ||
        !Array.isArray(item.canonical_owner_ids) ||
        (item.disposition === "omitted_with_reason" &&
          (typeof item.reason !== "string" || item.reason.trim().length === 0))
      ) {
        throw new Error("source integration contains invalid section coverage");
      }
    }
  }
  try {
    for (const write of specification.writes) {
      const relative = canonicalRelative(write.path);
      if (typeof write.content !== "string") {
        throw new Error(`${relative} content must be a string`);
      }
      assertSourceIndependent(write.content, relative, dynamicRelatives);
      parseNodeDocument(write.content, relative);
      const active = assertInside(root, path.join(root, ...relative.split("/")));
      const before = await pathExists(active) ? await readFile(active) : null;
      const staged = assertInside(
        stagedRoot,
        path.join(stagedRoot, ...relative.split("/"))
      );
      await writeUtf8(staged, write.content);
      writes.push({
        path: relative,
        before_sha256: before ? sha256(before) : null,
        after_sha256: sha256(Buffer.from(write.content, "utf8"))
      });
    }
    const conflicts = specification.conflicts ?? [];
    const material = conflicts.filter((item) => item.material === true);
    const status = material.length > 0 ? "awaiting_confirmation" : "staged";
    const record = {
      schema: "assistant.transaction/v1",
      id,
      type: specification.type || "canonical_update",
      status,
      authority: specification.authority || "current_user_instruction",
      instruction_hash: specification.instruction_hash || null,
      source_snapshot_ids: specification.source_snapshot_ids ?? [],
      coverage: specification.coverage ?? [],
      writes,
      conflicts,
      created_at: new Date().toISOString()
    };
    await writeUtf8(
      path.join(transactionRoot, "record.json"),
      `${JSON.stringify(record, null, 2)}\n`
    );
    return record;
  } catch (error) {
    if (await pathExists(transactionRoot)) {
      await rm(transactionRoot, { recursive: true, force: true });
    }
    throw error;
  }
}

export async function commitCanonicalUpdate(target, id, options = {}) {
  const root = path.resolve(target);
  const transactionRoot = path.join(
    root,
    ".assistant",
    "internal",
    "transactions",
    id
  );
  const recordPath = path.join(transactionRoot, "record.json");
  const record = JSON.parse(await readFile(recordPath, "utf8"));
  if (record.status === "committed") return { ...record, idempotent: true };
  if (record.status === "awaiting_confirmation" && options.confirmed !== true) {
    throw new Error("material conflict requires explicit whole-transaction confirmation");
  }
  if (!["staged", "awaiting_confirmation"].includes(record.status)) {
    throw new Error(`transaction cannot commit from ${record.status}`);
  }
  const backupRoot = path.join(transactionRoot, "backup");
  const created = [];
  let manifestBackup = null;
  let indexBackup = null;
  const integrityPath = path.join(
    root,
    ".assistant",
    "internal",
    "validated-hashes.json"
  );
  const integrityBackup = await readFile(integrityPath, "utf8");
  try {
    for (const write of record.writes) {
      const active = path.join(root, ...write.path.split("/"));
      const exists = await pathExists(active);
      const current = exists ? await readFile(active) : null;
      if ((current ? sha256(current) : null) !== write.before_sha256) {
        throw new Error(`active owner changed after staging: ${write.path}`);
      }
      if (current) {
        await writeUtf8(
          path.join(backupRoot, ...write.path.split("/")),
          current
        );
      } else {
        created.push(write.path);
      }
    }
    for (const write of record.writes) {
      const staged = path.join(
        transactionRoot,
        "staged",
        ...write.path.split("/")
      );
      await mkdir(path.dirname(path.join(root, ...write.path.split("/"))), {
        recursive: true
      });
      await cp(staged, path.join(root, ...write.path.split("/")), {
        force: true
      });
    }
    const indexPath = path.join(root, ".assistant", "INDEX.md");
    indexBackup = await readFile(indexPath, "utf8");
    await refreshIndex(root);
    const currentWrite = record.writes.find(
      (write) => write.path === ".assistant/CURRENT.md"
    );
    if (currentWrite) {
      const current = parseNodeDocument(
        await readFile(path.join(root, ".assistant", "CURRENT.md"), "utf8")
      );
      const manifestPath = path.join(root, ".assistant", "manifest.json");
      manifestBackup = await readFile(manifestPath, "utf8");
      const manifest = JSON.parse(manifestBackup);
      manifest.initialization_status = current.metadata.initialization_status;
      manifest.activity_status = current.metadata.activity_status;
      await writeFile(
        manifestPath,
        `${JSON.stringify(manifest, null, 2)}\n`,
        "utf8"
      );
    }
    const preliminaryValidation = await validateProject(root);
    if (!preliminaryValidation.valid) {
      throw new Error(`committed state failed validation: ${JSON.stringify(preliminaryValidation.findings)}`);
    }
    await refreshValidatedHashes(root, `transaction:${record.id}`);
    const validation = await validateProject(root);
    record.status = "committed";
    record.confirmed = options.confirmed === true;
    record.committed_at = new Date().toISOString();
    await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    return { ...record, idempotent: false, validation };
  } catch (error) {
    if (manifestBackup !== null) {
      await writeFile(
        path.join(root, ".assistant", "manifest.json"),
        manifestBackup,
        "utf8"
      );
    }
    if (indexBackup !== null) {
      await writeFile(
        path.join(root, ".assistant", "INDEX.md"),
        indexBackup,
        "utf8"
      );
    }
    await writeFile(integrityPath, integrityBackup, "utf8");
    for (const write of record.writes) {
      const backup = path.join(backupRoot, ...write.path.split("/"));
      const active = path.join(root, ...write.path.split("/"));
      if (await pathExists(backup)) await cp(backup, active, { force: true });
    }
    for (const relative of created) {
      const active = path.join(root, ...relative.split("/"));
      if (await pathExists(active)) await rm(active, { force: true });
    }
    record.status = "rolled_back";
    record.error = error.message;
    record.rolled_back_at = new Date().toISOString();
    await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    throw error;
  }
}
