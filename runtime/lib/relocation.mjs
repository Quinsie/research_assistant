import { createHash, randomUUID } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import { pathExists, writeUtf8 } from "./files.mjs";
import { enforceWindowsRestrictedAcls } from "./windows-acl.mjs";

const LEDGER_RELATIVE = ".assistant/internal/relocations/ledger.json";
const BOUNDARY_RELATIVE = ".assistant/internal/restricted/boundaries.json";
const CONFIG_START = "# assistant-dynamic-boundaries:start";
const CONFIG_END = "# assistant-dynamic-boundaries:end";

function portable(root, absolute) {
  return path.relative(root, absolute).replaceAll(path.sep, "/");
}

function inside(root, absolute) {
  const relative = path.relative(root, absolute);
  return (
    relative !== "" &&
    !relative.startsWith("..") &&
    !path.isAbsolute(relative)
  );
}

function resolveProjectPath(root, relative) {
  if (
    typeof relative !== "string" ||
    path.isAbsolute(relative) ||
    relative.startsWith("/") ||
    /^[A-Za-z]:[\\/]/u.test(relative)
  ) {
    throw new Error(`unsafe project-relative path: ${relative}`);
  }
  const absolute = path.resolve(root, ...relative.replaceAll("\\", "/").split("/"));
  if (!inside(root, absolute)) throw new Error(`path escapes project: ${relative}`);
  return absolute;
}

async function sha256File(location) {
  const info = await lstat(location);
  if (!info.isFile()) throw new Error(`relocation supports files only: ${location}`);
  return createHash("sha256").update(await readFile(location)).digest("hex");
}

async function readJson(location, fallback) {
  if (!(await pathExists(location))) return fallback;
  return JSON.parse(await readFile(location, "utf8"));
}

async function readLedger(root) {
  return readJson(path.join(root, ...LEDGER_RELATIVE.split("/")), {
    schema: "assistant.relocation-ledger/v1",
    transactions: []
  });
}

async function writeLedger(root, ledger) {
  await writeUtf8(
    path.join(root, ...LEDGER_RELATIVE.split("/")),
    `${JSON.stringify(ledger, null, 2)}\n`
  );
}

async function readBoundaries(root) {
  return readJson(path.join(root, ...BOUNDARY_RELATIVE.split("/")), {
    schema: "assistant.restricted-boundaries/v1",
    boundaries: []
  });
}

function uniqueBoundaries(boundaries) {
  const map = new Map();
  for (const boundary of boundaries) {
    map.set(
      `${boundary.relative}\u0000${boundary.kind}\u0000${boundary.boundary_kind}`,
      boundary
    );
  }
  return [...map.values()].sort((left, right) =>
    left.relative.localeCompare(right.relative, "en"));
}

async function writeBoundaries(root, registry) {
  registry.boundaries = uniqueBoundaries(registry.boundaries ?? []);
  registry.recorded_at = new Date().toISOString();
  await writeUtf8(
    path.join(root, ...BOUNDARY_RELATIVE.split("/")),
    `${JSON.stringify(registry, null, 2)}\n`
  );
  await updateCodexDynamicBoundaries(root, registry.boundaries);
  await enforceWindowsRestrictedAcls(root, registry.boundaries);
}

function tomlKey(value) {
  return JSON.stringify(value.replaceAll("\\", "/"));
}

async function selectConfigPath(root) {
  for (const candidate of [
    path.join(root, ".codex", "config.toml"),
    path.join(root, ".assistant", "internal", "pending", "assistant-config.toml")
  ]) {
    if (await pathExists(candidate)) return candidate;
  }
  return null;
}

export async function updateCodexDynamicBoundaries(root, boundaries) {
  const configPath = await selectConfigPath(root);
  if (!configPath) return false;
  const installationPath = path.join(
    root,
    ".assistant",
    "internal",
    "installation.json"
  );
  const installation = await readJson(installationPath, null);
  if (
    installation?.assets?.codex_config?.action === "created" &&
    installation.assets.codex_config.fingerprint
  ) {
    const current = await sha256File(configPath);
    if (current !== installation.assets.codex_config.fingerprint) {
      throw new Error(
        "Codex config changed outside the Assistant-managed dynamic boundary block"
      );
    }
  }
  let content = await readFile(configPath, "utf8");
  let start = content.indexOf(CONFIG_START);
  let end = content.indexOf(CONFIG_END);
  if (start < 0 || end < start) {
    const hookSection = content.indexOf("[[hooks.UserPromptSubmit]]");
    if (hookSection < 0 || !content.includes("\".assistant/internal/restricted\" = \"deny\"")) {
      throw new Error(
        "Codex config lacks a safely upgradable Assistant permission section"
      );
    }
    content =
      `${content.slice(0, hookSection).trimEnd()}\n` +
      `${CONFIG_START}\n${CONFIG_END}\n\n` +
      content.slice(hookSection);
    start = content.indexOf(CONFIG_START);
    end = content.indexOf(CONFIG_END);
  }
  const body = uniqueBoundaries(boundaries)
    .filter((boundary) => {
      const relative = boundary.relative.replaceAll("\\", "/");
      return !(
        relative === "docs" ||
        relative.startsWith("docs/") ||
        relative === ".assistant/vault" ||
        relative.startsWith(".assistant/vault/")
      );
    })
    .map((boundary) => `${tomlKey(boundary.relative)} = "deny"`)
    .join("\n");
  const replacement = `${CONFIG_START}\n${body}\n${CONFIG_END}`;
  await writeFile(
    configPath,
    `${content.slice(0, start)}${replacement}${content.slice(end + CONFIG_END.length)}`,
    "utf8"
  );
  if (installation?.assets?.codex_config?.action === "created") {
    installation.assets.codex_config.fingerprint = await sha256File(configPath);
    await writeFile(
      installationPath,
      `${JSON.stringify(installation, null, 2)}\n`,
      "utf8"
    );
  }
  return true;
}

async function moveFile(source, destination) {
  await mkdir(path.dirname(destination), { recursive: true });
  try {
    await rename(source, destination);
  } catch (error) {
    if (error.code !== "EXDEV") throw error;
    await copyFile(source, destination, 0);
    await rm(source);
  }
}

function executableAssets(assets) {
  return assets.filter(
    (asset) =>
      asset.decision_status === "approved" &&
      ["move_to_docs", "cold_in_place"].includes(asset.proposed_action)
  );
}

export async function applyApprovedRelocations(rootInput, assets, options = {}) {
  const root = path.resolve(rootInput);
  const planned = executableAssets(assets);
  if (planned.length > 0 && options.confirmed !== true) {
    throw new Error("relocation requires explicit whole-plan confirmation");
  }
  const transactionId = `RELOC-${randomUUID()}`;
  if (planned.length === 0) {
    return {
      schema: "assistant.relocation-result/v1",
      transaction_id: null,
      status: "not_required",
      assets: 0
    };
  }
  const ledger = await readLedger(root);
  const registry = await readBoundaries(root);
  const beforeBoundaries = structuredClone(registry);
  const record = {
    id: transactionId,
    status: "applying",
    approved_at: new Date().toISOString(),
    approval: options.approval ?? [],
    prior_boundaries: beforeBoundaries.boundaries ?? [],
    created_directories: [],
    assets: []
  };
  ledger.transactions.push(record);
  await writeLedger(root, ledger);
  try {
    for (const asset of planned) {
      const source = resolveProjectPath(root, asset.path);
      if (!(await pathExists(source))) {
        throw new Error(`relocation source is absent: ${asset.path}`);
      }
      const sourceHash = await sha256File(source);
      if (asset.proposed_action === "move_to_docs") {
        const destination = resolveProjectPath(root, asset.proposed_destination);
        const relativeDestination = portable(root, destination);
        if (
          !relativeDestination.startsWith("docs/") ||
          relativeDestination.startsWith("docs/report/")
        ) {
          throw new Error(
            `relocation destination must be below docs and outside docs/report: ${relativeDestination}`
          );
        }
        if (await pathExists(destination)) {
          throw new Error(`relocation destination exists: ${relativeDestination}`);
        }
        const parent = path.dirname(destination);
        if (!(await pathExists(parent))) {
          record.created_directories.push(portable(root, parent));
        }
        await moveFile(source, destination);
        const destinationHash = await sha256File(destination);
        if (destinationHash !== sourceHash) {
          throw new Error(`relocation hash mismatch: ${asset.path}`);
        }
        record.assets.push({
          original_path: asset.path,
          destination_path: relativeDestination,
          action: "move_to_docs",
          observed_role: asset.observed_role,
          canonical_target_ids: asset.target_ids,
          reason: asset.reason,
          source_sha256: sourceHash,
          destination_sha256: destinationHash,
          status: "moved",
          restore_status: "not_requested"
        });
      } else {
        registry.boundaries.push({
          relative: asset.path,
          kind: "document",
          boundary_kind: "file",
          reason: "approved_cold_in_place"
        });
        record.assets.push({
          original_path: asset.path,
          destination_path: null,
          action: "cold_in_place",
          observed_role: asset.observed_role,
          canonical_target_ids: asset.target_ids,
          reason: asset.reason,
          source_sha256: sourceHash,
          destination_sha256: null,
          status: "cold",
          restore_status: "not_applicable"
        });
      }
      await writeLedger(root, ledger);
    }
    await writeBoundaries(root, registry);
    record.status = "committed";
    record.committed_at = new Date().toISOString();
    await writeLedger(root, ledger);
    return {
      schema: "assistant.relocation-result/v1",
      transaction_id: transactionId,
      status: "committed",
      assets: record.assets.length
    };
  } catch (error) {
    for (const asset of [...record.assets].reverse()) {
      if (asset.action !== "move_to_docs") continue;
      const source = resolveProjectPath(root, asset.original_path);
      const destination = resolveProjectPath(root, asset.destination_path);
      if ((await pathExists(destination)) && !(await pathExists(source))) {
        await moveFile(destination, source);
      }
    }
    record.status = "rolled_back";
    record.error = error.message;
    record.rolled_back_at = new Date().toISOString();
    await writeBoundaries(root, beforeBoundaries);
    await writeLedger(root, ledger);
    throw error;
  }
}

export async function rollbackRelocationTransaction(rootInput, transactionId) {
  if (!transactionId) return { status: "not_required" };
  const root = path.resolve(rootInput);
  const ledger = await readLedger(root);
  const transaction = ledger.transactions.find((item) => item.id === transactionId);
  if (!transaction) throw new Error(`unknown relocation transaction ${transactionId}`);
  if (transaction.status === "rolled_back") return { status: "already_rolled_back" };
  for (const asset of [...transaction.assets].reverse()) {
    if (asset.action !== "move_to_docs") continue;
    const original = resolveProjectPath(root, asset.original_path);
    const destination = resolveProjectPath(root, asset.destination_path);
    if (await pathExists(original)) {
      throw new Error(`cannot roll back; original path is occupied: ${asset.original_path}`);
    }
    if (!(await pathExists(destination))) {
      throw new Error(`cannot roll back; destination is absent: ${asset.destination_path}`);
    }
    if (await sha256File(destination) !== asset.destination_sha256) {
      throw new Error(`cannot roll back modified destination: ${asset.destination_path}`);
    }
    await moveFile(destination, original);
    asset.status = "rolled_back";
    asset.restore_status = "restored";
  }
  transaction.status = "rolled_back";
  transaction.rolled_back_at = new Date().toISOString();
  const registry = await readBoundaries(root);
  registry.boundaries = transaction.prior_boundaries ?? registry.boundaries;
  await writeBoundaries(root, registry);
  await writeLedger(root, ledger);
  return { status: "rolled_back", transaction_id: transactionId };
}

export async function previewRelocationRestore(rootInput) {
  const root = path.resolve(rootInput);
  const ledger = await readLedger(root);
  const assets = [];
  for (const transaction of ledger.transactions) {
    if (transaction.status !== "committed") continue;
    for (const asset of transaction.assets ?? []) {
      if (asset.action !== "move_to_docs" || asset.restore_status === "restored") continue;
      const original = resolveProjectPath(root, asset.original_path);
      const destination = resolveProjectPath(root, asset.destination_path);
      const originalExists = await pathExists(original);
      const destinationExists = await pathExists(destination);
      const destinationHash = destinationExists
        ? await sha256File(destination)
        : null;
      const status = originalExists
        ? "blocked_original_occupied"
        : !destinationExists
          ? "blocked_destination_absent"
          : destinationHash !== asset.destination_sha256
            ? "blocked_destination_modified"
            : "restorable";
      assets.push({
        transaction_id: transaction.id,
        original_path: asset.original_path,
        destination_path: asset.destination_path,
        status
      });
    }
  }
  return {
    schema: "assistant.relocation-restore-preview/v1",
    status: assets.some((asset) => asset.status.startsWith("blocked"))
      ? "conflict"
      : "preview",
    assets,
    requires_confirmation: assets.length > 0
  };
}

export async function restoreRelocations(rootInput, options = {}) {
  const root = path.resolve(rootInput);
  const preview = await previewRelocationRestore(root);
  if (!options.confirmed || preview.status === "conflict") return preview;
  const ids = [...new Set(preview.assets.map((asset) => asset.transaction_id))];
  for (const id of ids.reverse()) {
    await rollbackRelocationTransaction(root, id);
  }
  return {
    ...preview,
    status: "completed",
    completed_at: new Date().toISOString()
  };
}

export async function hasCommittedRelocations(rootInput) {
  const ledger = await readLedger(path.resolve(rootInput));
  return ledger.transactions.some((transaction) =>
    transaction.status === "committed" &&
    (transaction.assets ?? []).some(
      (asset) =>
        asset.action === "move_to_docs" &&
        asset.restore_status !== "restored"
    ));
}
