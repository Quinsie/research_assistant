import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  rmdir,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathExists } from "./files.mjs";
import {
  enforceWindowsRestrictedAcls,
  rollbackWindowsRestrictedAcls
} from "./windows-acl.mjs";
import {
  hasCommittedRelocations,
  previewRelocationRestore,
  restoreRelocations
} from "./relocation.mjs";

const MANAGED_START = "<!-- assistant-managed:start -->";
const MANAGED_END = "<!-- assistant-managed:end -->";
const EXCLUDE_START = "# assistant-managed:start";
const EXCLUDE_END = "# assistant-managed:end";
const LEDGER_RELATIVE = ".assistant/internal/installation.json";

function portable(root, absolute) {
  return path.relative(root, absolute).replaceAll(path.sep, "/");
}

function inside(parent, child) {
  const relative = path.relative(parent, child);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function ownedLocation(root, relative) {
  if (typeof relative !== "string" || path.isAbsolute(relative)) {
    throw new Error("installation ledger contains an invalid owned path");
  }
  const normalized = relative.replaceAll("\\", "/").replace(/^\.\/+/u, "");
  const allowed =
    normalized === ".codex/config.toml" ||
    /^\.agents\/skills\/assistant-(?:research|software)-workflow$/u.test(normalized) ||
    normalized === ".assistant/internal/pending/assistant-config.toml" ||
    /^\.assistant\/internal\/pending\/skills\/assistant-(?:research|software)-workflow$/u.test(normalized);
  const absolute = path.resolve(root, ...normalized.split("/"));
  if (!allowed || !inside(root, absolute)) {
    throw new Error(`installation ledger path is outside assistant ownership: ${relative}`);
  }
  return absolute;
}

function runGit(root, args) {
  return new Promise((resolve) => {
    const child = spawn("git", args, {
      cwd: root,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"]
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.once("error", () => resolve(null));
    child.once("close", (code) => resolve(code === 0 ? stdout.trim() : null));
  });
}

async function currentGitExclude(root) {
  const location = await runGit(root, ["rev-parse", "--git-path", "info/exclude"]);
  return location ? path.resolve(root, location) : null;
}

async function sha256File(location) {
  return createHash("sha256").update(await readFile(location)).digest("hex");
}

async function sha256Tree(location) {
  const entries = [];
  async function visit(current) {
    const children = await readdir(current, { withFileTypes: true });
    children.sort((a, b) => a.name.localeCompare(b.name, "en"));
    for (const child of children) {
      const absolute = path.join(current, child.name);
      const relative = path.relative(location, absolute).replaceAll(path.sep, "/");
      if (child.isDirectory()) {
        entries.push(`d:${relative}`);
        await visit(absolute);
      } else if (child.isFile()) {
        entries.push(`f:${relative}:${await sha256File(absolute)}`);
      } else {
        entries.push(`o:${relative}`);
      }
    }
  }
  await visit(location);
  return createHash("sha256").update(entries.join("\n")).digest("hex");
}

async function fingerprint(location) {
  if (!(await pathExists(location))) return null;
  const info = await lstat(location);
  return info.isDirectory() ? sha256Tree(location) : sha256File(location);
}

export async function fingerprintAsset(location) {
  return fingerprint(location);
}

async function readJsonIfPresent(location) {
  if (!(await pathExists(location))) return null;
  return JSON.parse(await readFile(location, "utf8"));
}

async function inventoryPaths(root) {
  const inventory = await readJsonIfPresent(
    path.join(root, ".assistant", "internal", "bootstrap", "inventory.json")
  );
  return new Set(
    (inventory?.entries ?? inventory?.paths ?? [])
      .map((entry) => typeof entry === "string" ? entry : entry.path)
      .filter(Boolean)
      .map((entry) => entry.replaceAll("\\", "/"))
  );
}

async function inferLegacyLedger(root) {
  const paths = await inventoryPaths(root);
  const profile = (
    await readJsonIfPresent(path.join(root, ".assistant", "manifest.json"))
  )?.profile ?? "research";
  const skill = `.agents/skills/assistant-${profile}-workflow`;
  const agentsExisted = paths.has("AGENTS.md") ||
    (await pathExists(path.join(root, ".assistant", "internal", "backup", "AGENTS.md")));
  const configExisted = paths.has(".codex/config.toml");
  const skillExisted = [...paths].some((item) => item === skill || item.startsWith(`${skill}/`));
  return {
    schema: "assistant.installation/v1",
    inferred_legacy: true,
    assets: {
      agents: {
        action: agentsExisted ? "merged" : "created",
        path: "AGENTS.md",
        backup: agentsExisted ? ".assistant/internal/backup/AGENTS.md" : null
      },
      codex_config: {
        action: configExisted ? "preserved_or_staged" : "created",
        path: ".codex/config.toml",
        fingerprint: configExisted ? null : await fingerprint(path.join(root, ".codex", "config.toml"))
      },
      skill: {
        action: skillExisted ? "preserved_or_staged" : "created",
        path: skill,
        fingerprint: skillExisted ? null : await fingerprint(path.join(root, ...skill.split("/")))
      },
      discovery_directories: [
        { path: ".agents", created: ![...paths].some((item) => item === ".agents" || item.startsWith(".agents/")) },
        { path: ".codex", created: ![...paths].some((item) => item === ".codex" || item.startsWith(".codex/")) }
      ],
      git_exclude: null
    }
  };
}

export async function readInstallationLedger(target) {
  const root = path.resolve(target);
  return (
    await readJsonIfPresent(path.join(root, ...LEDGER_RELATIVE.split("/")))
  ) ?? inferLegacyLedger(root);
}

function removeBoundedBlock(content, startMarker, endMarker) {
  const start = content.indexOf(startMarker);
  const end = content.indexOf(endMarker);
  if (start < 0 && end < 0) return { content, found: false };
  if (start < 0 || end < start) {
    throw new Error(`managed integration markers are malformed: ${startMarker}`);
  }
  const after = end + endMarker.length;
  let next = `${content.slice(0, start)}${content.slice(after)}`;
  next = next.replace(/\r?\n{3,}/gu, "\n\n").trimEnd();
  return { content: next ? `${next}\n` : "", found: true };
}

async function inspectAssetConflict(root, asset) {
  if (!asset || asset.action !== "created" || !asset.fingerprint) return null;
  const location = ownedLocation(root, asset.path);
  if (!(await pathExists(location))) return null;
  const current = await fingerprint(location);
  return current === asset.fingerprint
    ? null
    : `${asset.path} changed after assistant installation`;
}

async function buildRemovalPreview(root, mode, layout = null) {
  if (!(await pathExists(path.join(root, ".assistant")))) {
    throw new Error("target is not initialized");
  }
  const ledger = await readInstallationLedger(root);
  const conflicts = [];
  for (const asset of [ledger.assets?.codex_config, ledger.assets?.skill]) {
    const conflict = await inspectAssetConflict(root, asset);
    if (conflict) conflicts.push(conflict);
  }
  const agentsPath = path.join(root, "AGENTS.md");
  if (await pathExists(agentsPath)) {
    const agents = await readFile(agentsPath, "utf8");
    const hasStart = agents.includes(MANAGED_START);
    const hasEnd = agents.includes(MANAGED_END);
    if (hasStart !== hasEnd) conflicts.push("AGENTS.md assistant markers are malformed");
  }
  const excludePath = await currentGitExclude(root);
  if (excludePath && await pathExists(excludePath)) {
    const content = await readFile(excludePath, "utf8");
    if (content.includes(EXCLUDE_START) !== content.includes(EXCLUDE_END)) {
      conflicts.push("Git local exclude assistant markers are malformed");
    }
  }
  const remove = [
    "assistant-managed AGENTS.md block",
    ledger.assets?.codex_config?.action === "created"
      ? ledger.assets.codex_config.path
      : null,
    ledger.assets?.skill?.action === "created" ? ledger.assets.skill.path : null,
    excludePath ? "assistant-managed .git/info/exclude block" : null,
    mode === "purge" ? ".assistant/" : ".assistant/system/"
  ].filter(Boolean);
  const preserve = [
    "all project code, data, config, and Git history",
    "docs/ including the docs/report derived-report interface",
    ...(mode === "uninstall"
      ? [".assistant canonical knowledge, POLICY.md, vault, and protection ledger"]
      : [])
  ];
  const relocationRestore = await previewRelocationRestore(root);
  const relocationsPending = await hasCommittedRelocations(root);
  if (
    layout !== null &&
    !["keep", "restore"].includes(layout)
  ) {
    conflicts.push(`invalid relocation layout choice: ${layout}`);
  }
  return {
    schema: "assistant.lifecycle-preview/v1",
    target: root,
    operation: mode,
    status: conflicts.length ? "conflict" : "preview",
    legacy_inference: ledger.inferred_legacy === true,
    remove,
    preserve,
    conflicts,
    relocation_layout: layout,
    relocation_restore: relocationRestore,
    relocation_choice_required: relocationsPending && layout === null,
    requires_confirmation: true
  };
}

async function removeManagedAgents(root, ledger) {
  const agentsPath = path.join(root, "AGENTS.md");
  if (!(await pathExists(agentsPath))) return;
  const result = removeBoundedBlock(
    await readFile(agentsPath, "utf8"),
    MANAGED_START,
    MANAGED_END
  );
  if (!result.found) return;
  if (ledger.assets?.agents?.action === "created" && result.content.trim() === "") {
    await rm(agentsPath, { force: true });
  } else {
    await writeFile(agentsPath, result.content, "utf8");
  }
}

async function removeManagedExclude(root, ledger) {
  if (!ledger.assets?.git_exclude?.path) return;
  const excludePath = await currentGitExclude(root);
  if (!excludePath) return;
  if (!excludePath || !(await pathExists(excludePath))) return;
  const result = removeBoundedBlock(
    await readFile(excludePath, "utf8"),
    EXCLUDE_START,
    EXCLUDE_END
  );
  if (result.found) await writeFile(excludePath, result.content, "utf8");
}

async function removeCreatedAsset(root, asset) {
  if (!asset || asset.action !== "created") return;
  const location = ownedLocation(root, asset.path);
  if (await pathExists(location)) await rm(location, { recursive: true, force: true });
}

async function removeEmptyDiscoveryDirectories(root, ledger) {
  if (ledger.assets?.skill?.action === "created") {
    const skillsDirectory = path.join(root, ".agents", "skills");
    if (await pathExists(skillsDirectory)) {
      try {
        await rmdir(skillsDirectory);
      } catch (error) {
        if (!["ENOENT", "ENOTEMPTY"].includes(error.code)) throw error;
      }
    }
  }
  const directories = [...(ledger.assets?.discovery_directories ?? [])].reverse();
  for (const record of directories) {
    if (!record.created) continue;
    const location = path.join(root, ...record.path.split("/"));
    if (!(await pathExists(location))) continue;
    try {
      await rmdir(location);
    } catch (error) {
      if (!["ENOENT", "ENOTEMPTY"].includes(error.code)) throw error;
    }
  }
}

async function backupAssistantState(root) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "assistant-removal-"));
  return { temporary, records: [] };
}

async function captureRollbackPaths(root, ledger, backup, preview = null) {
  const candidates = [
    path.join(root, ".assistant"),
    path.join(root, "AGENTS.md"),
    ledger.assets?.codex_config?.path
      ? ownedLocation(root, ledger.assets.codex_config.path)
      : null,
    ledger.assets?.skill?.path
      ? ownedLocation(root, ledger.assets.skill.path)
      : null,
    await currentGitExclude(root),
    ...(preview?.relocation_restore?.assets ?? []).flatMap((asset) => [
      path.resolve(root, ...asset.original_path.split("/")),
      path.resolve(root, ...asset.destination_path.split("/"))
    ])
  ].filter(Boolean);
  let index = 0;
  for (const location of [...new Set(candidates)]) {
    const existed = await pathExists(location);
    const record = {
      location,
      existed,
      backup: path.join(backup.temporary, `asset-${index}`)
    };
    index += 1;
    if (existed) await cp(location, record.backup, { recursive: true });
    backup.records.push(record);
  }
}

function setHidden(location) {
  if (process.platform !== "win32") return Promise.resolve();
  return new Promise((resolve, reject) => {
    const child = spawn("attrib.exe", ["+H", location], {
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"]
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`failed to restore hidden attribute: ${stderr.trim()}`))
    );
  });
}

async function restoreRollbackPaths(root, ledger, backup) {
  for (const record of backup.records) {
    if (await pathExists(record.location)) {
      await rm(record.location, { recursive: true, force: true });
    }
    if (record.existed) {
      await mkdir(path.dirname(record.location), { recursive: true });
      await cp(record.backup, record.location, { recursive: true });
    }
  }
  for (const record of ledger.assets?.visibility ?? []) {
    if (!record.hidden_by_assistant) continue;
    const location = path.join(root, ...record.path.split("/"));
    if (await pathExists(location)) await setHidden(location);
  }
}

async function executeRemoval(root, mode, preview) {
  const ledger = await readInstallationLedger(root);
  const backup = await backupAssistantState(root);
  await captureRollbackPaths(root, ledger, backup, preview);
  let aclTouched = false;
  try {
    if (preview.relocation_layout === "restore") {
      const restored = await restoreRelocations(root, { confirmed: true });
      if (restored.status !== "completed" && restored.assets?.length > 0) {
        throw new Error("relocation restore did not complete");
      }
    }
    await removeManagedAgents(root, ledger);
    await removeManagedExclude(root, ledger);
    await removeCreatedAsset(root, ledger.assets?.codex_config);
    await removeCreatedAsset(root, ledger.assets?.skill);
    if (mode === "purge") {
      aclTouched = true;
      await rollbackWindowsRestrictedAcls(root);
      await rm(path.join(root, ".assistant"), { recursive: true, force: true });
    } else {
      const system = path.join(root, ".assistant", "system");
      if (await pathExists(system)) await rm(system, { recursive: true, force: true });
      const manifestPath = path.join(root, ".assistant", "manifest.json");
      const manifest = await readJsonIfPresent(manifestPath);
      if (manifest) {
        manifest.system_status = "uninstalled";
        manifest.uninstalled_at = new Date().toISOString();
        await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
      }
    }
    await removeEmptyDiscoveryDirectories(root, ledger);
  } catch (error) {
    await restoreRollbackPaths(root, ledger, backup);
    if (aclTouched && process.platform === "win32") {
      const boundaries = await readJsonIfPresent(
        path.join(root, ".assistant", "internal", "restricted", "boundaries.json")
      );
      await enforceWindowsRestrictedAcls(root, boundaries?.boundaries ?? []);
    }
    throw error;
  } finally {
    await rm(backup.temporary, { recursive: true, force: true });
  }
  return {
    ...preview,
    status: "completed",
    completed_at: new Date().toISOString()
  };
}

export async function uninstallAssistant(target, options = {}) {
  const root = path.resolve(target);
  const preview = await buildRemovalPreview(root, "uninstall", options.layout ?? null);
  if (
    !options.confirmed ||
    preview.conflicts.length > 0 ||
    preview.relocation_choice_required
  ) return preview;
  return executeRemoval(root, "uninstall", preview);
}

export async function purgeAssistant(target, options = {}) {
  const root = path.resolve(target);
  const preview = await buildRemovalPreview(root, "purge", options.layout ?? null);
  if (
    !options.confirmed ||
    preview.conflicts.length > 0 ||
    preview.relocation_choice_required
  ) return preview;
  return executeRemoval(root, "purge", preview);
}

async function collectExportFiles(root) {
  const candidates = [
    "manifest.json",
    "INDEX.md",
    "CURRENT.md",
    "POLICY.md",
    "knowledge",
    "vault",
    "internal/restricted/boundaries.json"
  ];
  return candidates.filter(
    async (relative) => pathExists(path.join(root, ".assistant", ...relative.split("/")))
  );
}

export async function exportAssistant(target, output) {
  const root = path.resolve(target);
  const destination = path.resolve(output);
  if (!inside(root, destination) && inside(destination, root)) {
    throw new Error("export output cannot contain the project root");
  }
  if (inside(root, destination) || destination === root) {
    throw new Error("export output must be outside the project");
  }
  if (await pathExists(destination)) {
    throw new Error(`export output already exists: ${destination}`);
  }
  const assistantRoot = path.join(root, ".assistant");
  if (!(await pathExists(assistantRoot))) throw new Error("target is not initialized");
  await mkdir(destination, { recursive: false });
  const files = [];
  try {
    for (const relative of await collectExportFiles(root)) {
      const source = path.join(assistantRoot, ...relative.split("/"));
      if (!(await pathExists(source))) continue;
      const targetPath = path.join(destination, ...relative.split("/"));
      await mkdir(path.dirname(targetPath), { recursive: true });
      await cp(source, targetPath, { recursive: true });
    }
    async function visit(current) {
      for (const entry of await readdir(current, { withFileTypes: true })) {
        const absolute = path.join(current, entry.name);
        if (entry.isDirectory()) await visit(absolute);
        else if (entry.isFile()) {
          files.push({
            path: portable(destination, absolute),
            bytes: (await lstat(absolute)).size,
            sha256: await sha256File(absolute)
          });
        }
      }
    }
    await visit(destination);
    files.sort((a, b) => a.path.localeCompare(b.path, "en"));
    const manifest = {
      schema: "assistant.export/v1",
      export_id: randomUUID(),
      source_project_id: (
        await readJsonIfPresent(path.join(assistantRoot, "manifest.json"))
      )?.project_id ?? null,
      created_at: new Date().toISOString(),
      files
    };
    await writeFile(
      path.join(destination, "EXPORT_MANIFEST.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8"
    );
    return {
      schema: "assistant.export-result/v1",
      status: "completed",
      target: root,
      output: destination,
      files: files.length
    };
  } catch (error) {
    await rm(destination, { recursive: true, force: true });
    throw error;
  }
}
