import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { doctorProject } from "./doctor.mjs";
import { pathExists } from "./files.mjs";
import {
  copyInstalledRuntime,
  installGitExclude,
  readManagedBlock,
  renderInstalledFile,
  setWindowsHidden
} from "./installer.mjs";
import { fingerprintAsset, readInstallationLedger } from "./lifecycle.mjs";
import { refreshValidatedHashes } from "./integrity.mjs";
import { validateProject } from "./validator.mjs";

const runtimeDirectory = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(runtimeDirectory, "..", "..");
const templateRoot = path.join(packageRoot, "project-template");
const MANAGED_START = "<!-- assistant-managed:start -->";
const MANAGED_END = "<!-- assistant-managed:end -->";

function ownedLocation(root, relative) {
  if (typeof relative !== "string" || path.isAbsolute(relative)) {
    throw new Error("installation ledger contains an invalid update path");
  }
  const normalized = relative.replaceAll("\\", "/").replace(/^\.\/+/u, "");
  const allowed =
    normalized === ".codex/config.toml" ||
    /^\.agents\/skills\/assistant-(?:research|software)-workflow$/u.test(normalized) ||
    normalized === ".assistant/internal/pending/assistant-config.toml" ||
    /^\.assistant\/internal\/pending\/skills\/assistant-(?:research|software)-workflow$/u.test(normalized);
  const location = path.resolve(root, ...normalized.split("/"));
  const relation = path.relative(root, location);
  if (
    !allowed ||
    relation === "" ||
    relation.startsWith("..") ||
    path.isAbsolute(relation)
  ) {
    throw new Error(`installation ledger path is outside update ownership: ${relative}`);
  }
  return location;
}

function tomlString(value) {
  return JSON.stringify(value.replaceAll("\\", "/"));
}

function replacements(root) {
  return {
    PROJECT_ROOT_TOML: tomlString(root),
    NODE_EXECUTABLE_TOML: tomlString(process.execPath),
    HOOK_SCRIPT_TOML: tomlString(
      path.join(root, ".assistant", "system", "runtime", "user-prompt-submit.mjs")
    ),
    HOOK_COMMAND_TOML: tomlString(
      `node "${path.join(
        root,
        ".assistant",
        "system",
        "runtime",
        "user-prompt-submit.mjs"
      )}"`
    ),
    GATEWAY_SCRIPT_TOML: tomlString(
      path.join(root, ".assistant", "system", "runtime", "gateway.mjs")
    ),
    ADDITIONAL_RESTRICTED_TOML: ""
  };
}

function replaceManagedBlock(content, block) {
  const start = content.indexOf(MANAGED_START);
  const end = content.indexOf(MANAGED_END);
  if (start < 0 || end < start) {
    throw new Error("AGENTS.md assistant managed block is missing or malformed");
  }
  return `${content.slice(0, start)}${block}${content.slice(end + MANAGED_END.length)}`;
}

async function activeTransactions(root) {
  const transactionRoot = path.join(root, ".assistant", "internal", "transactions");
  if (!(await pathExists(transactionRoot))) return [];
  const active = [];
  for (const entry of await readdir(transactionRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const specification = path.join(transactionRoot, entry.name, "transaction.json");
    if (!(await pathExists(specification))) continue;
    const record = JSON.parse(await readFile(specification, "utf8"));
    if (["staged", "applying", "awaiting_confirmation"].includes(record.status)) {
      active.push(record.id ?? entry.name);
    }
  }
  return active;
}

async function buildStaging(root, ledger) {
  const staging = await mkdtemp(path.join(os.tmpdir(), "assistant-update-"));
  const system = path.join(staging, "system");
  await cp(path.join(templateRoot, ".assistant", "system"), system, {
    recursive: true
  });
  await copyInstalledRuntime(system);
  const values = replacements(root);
  await renderInstalledFile(path.join(system, "assistant.cmd"), values);
  await renderInstalledFile(path.join(system, "assistant"), values);

  const managed = await readManagedBlock();
  const agentsPath = path.join(root, "AGENTS.md");
  const agents = await pathExists(agentsPath)
    ? await readFile(agentsPath, "utf8")
    : "";
  const renderedAgents = agents.includes(MANAGED_START) ||
    agents.includes(MANAGED_END)
    ? replaceManagedBlock(agents, managed)
    : `${agents}${agents && !agents.endsWith("\n") ? "\n" : ""}${
      agents ? "\n" : ""
    }${managed}\n`;
  await writeFile(
    path.join(staging, "AGENTS.md"),
    renderedAgents,
    "utf8"
  );

  const configAsset = ledger.assets?.codex_config;
  if (configAsset?.path) ownedLocation(root, configAsset.path);
  if (configAsset?.action === "created") {
    const staged = path.join(staging, "config.toml");
    await cp(path.join(templateRoot, ".codex", "config.toml"), staged);
    await renderInstalledFile(staged, values);
  } else if (configAsset?.action === "staged" && configAsset.path) {
    const staged = path.join(staging, "pending-config.toml");
    await cp(path.join(templateRoot, ".codex", "config.toml"), staged);
    await renderInstalledFile(staged, values);
  }

  const skillAsset = ledger.assets?.skill;
  if (skillAsset?.path) ownedLocation(root, skillAsset.path);
  if (["created", "staged"].includes(skillAsset?.action) && skillAsset.path) {
    const skillName = path.basename(skillAsset.path);
    await cp(
      path.join(templateRoot, ".agents", "skills", skillName),
      path.join(staging, "skill"),
      { recursive: true }
    );
  }
  return staging;
}

async function capture(location, backupRoot, name) {
  const existed = await pathExists(location);
  const backup = path.join(backupRoot, name);
  if (existed) await cp(location, backup, { recursive: true });
  return { location, backup, existed };
}

async function restore(records) {
  for (const record of records) {
    if (await pathExists(record.location)) {
      await rm(record.location, { recursive: true, force: true });
    }
    if (record.existed) await cp(record.backup, record.location, { recursive: true });
  }
}

export async function updateAssistant(target, options = {}) {
  const root = path.resolve(target);
  const manifestPath = path.join(root, ".assistant", "manifest.json");
  if (!(await pathExists(manifestPath))) throw new Error("target is not initialized");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const templateManifest = JSON.parse(
    await readFile(path.join(templateRoot, ".assistant", "manifest.json"), "utf8")
  );
  if (manifest.profile !== templateManifest.profile) {
    throw new Error(
      `profile mismatch: installed=${manifest.profile}, package=${templateManifest.profile}`
    );
  }
  const transactions = await activeTransactions(root);
  if (transactions.length > 0) {
    return {
      schema: "assistant.update-result/v1",
      status: "blocked",
      reason: "active_canonical_transaction",
      transactions
    };
  }
  if (
    manifest.system_version === templateManifest.system_version &&
    manifest.system_status !== "uninstalled" &&
    !options.force
  ) {
    return {
      schema: "assistant.update-result/v1",
      status: "up_to_date",
      current_version: manifest.system_version
    };
  }

  const ledger = await readInstallationLedger(root);
  const staging = await buildStaging(root, ledger);
  const backupRoot = await mkdtemp(path.join(os.tmpdir(), "assistant-update-backup-"));
  const locations = [
    ["system", path.join(root, ".assistant", "system")],
    ["agents", path.join(root, "AGENTS.md")],
    ["manifest", manifestPath],
    ["ledger", path.join(root, ".assistant", "internal", "installation.json")]
  ];
  const configAsset = ledger.assets?.codex_config;
  if (configAsset?.path && ["created", "staged"].includes(configAsset.action)) {
    locations.push(["config", ownedLocation(root, configAsset.path)]);
  }
  const skillAsset = ledger.assets?.skill;
  if (skillAsset?.path && ["created", "staged"].includes(skillAsset.action)) {
    locations.push(["skill", ownedLocation(root, skillAsset.path)]);
  }
  const backups = [];
  try {
    for (const [name, location] of locations) {
      backups.push(await capture(location, backupRoot, name));
    }
    await rm(path.join(root, ".assistant", "system"), { recursive: true, force: true });
    await cp(path.join(staging, "system"), path.join(root, ".assistant", "system"), {
      recursive: true
    });
    await cp(path.join(staging, "AGENTS.md"), path.join(root, "AGENTS.md"), {
      force: true
    });
    if (configAsset?.action === "created") {
      await mkdir(
        path.dirname(ownedLocation(root, configAsset.path)),
        { recursive: true }
      );
      await cp(path.join(staging, "config.toml"), ownedLocation(root, configAsset.path), {
        force: true
      });
      configAsset.fingerprint = await fingerprintAsset(
        ownedLocation(root, configAsset.path)
      );
    } else if (configAsset?.action === "staged" && configAsset.path) {
      await cp(
        path.join(staging, "pending-config.toml"),
        ownedLocation(root, configAsset.path),
        { force: true }
      );
    }
    if (skillAsset?.path && ["created", "staged"].includes(skillAsset.action)) {
      const destination = ownedLocation(root, skillAsset.path);
      await rm(destination, { recursive: true, force: true });
      await mkdir(path.dirname(destination), { recursive: true });
      await cp(path.join(staging, "skill"), destination, { recursive: true });
      if (skillAsset.action === "created") {
        skillAsset.fingerprint = await fingerprintAsset(destination);
      }
    }
    manifest.system_version = templateManifest.system_version;
    manifest.update_origin = templateManifest.update_origin;
    delete manifest.system_status;
    delete manifest.uninstalled_at;
    manifest.updated_at = new Date().toISOString();
    const excludePatterns = ["/.assistant/"];
    if (ledger.assets?.agents?.action === "created") excludePatterns.push("/AGENTS.md");
    if (configAsset?.action === "created") excludePatterns.push("/.codex/config.toml");
    if (skillAsset?.action === "created") excludePatterns.push(`/${skillAsset.path}/`);
    const existingExclude = ledger.assets?.git_exclude?.path;
    const excludeContent = existingExclude && await pathExists(existingExclude)
      ? await readFile(existingExclude, "utf8")
      : "";
    if (!excludeContent.includes("# assistant-managed:start")) {
      ledger.assets.git_exclude = await installGitExclude(root, excludePatterns);
    }
    for (const record of ledger.assets?.discovery_directories ?? []) {
      if (record.created) {
        const location = path.join(root, ...record.path.split("/"));
        if (await pathExists(location)) await setWindowsHidden(location);
      }
    }
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    ledger.updated_at = manifest.updated_at;
    await writeFile(
      path.join(root, ".assistant", "internal", "installation.json"),
      `${JSON.stringify(ledger, null, 2)}\n`,
      "utf8"
    );
    await refreshValidatedHashes(root, "system_update");
    const validation = await validateProject(root);
    if (!validation.valid) {
      throw new Error(`updated system failed validation: ${JSON.stringify(validation.findings)}`);
    }
    const doctor = await doctorProject(root, { probeSandbox: false });
    if (doctor.status === "failed") {
      throw new Error("updated system failed doctor checks");
    }
    return {
      schema: "assistant.update-result/v1",
      status: doctor.status === "ready" ? "completed" : "review_required",
      from_version: backups
        .find((record) => record.location === manifestPath)
        ?.existed ? JSON.parse(await readFile(
          backups.find((record) => record.location === manifestPath).backup,
          "utf8"
        )).system_version : null,
      to_version: manifest.system_version,
      validation,
      doctor
    };
  } catch (error) {
    await restore(backups);
    throw error;
  } finally {
    await rm(staging, { recursive: true, force: true });
    await rm(backupRoot, { recursive: true, force: true });
  }
}
