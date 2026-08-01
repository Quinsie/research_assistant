import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  cp,
  lstat,
  mkdir,
  readdir,
  readFile,
  rm,
  rmdir,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pathExists, writeUtf8 } from "./files.mjs";
import { fingerprintAsset } from "./lifecycle.mjs";
import { inventoryProject } from "./inventory.mjs";
import { refreshValidatedHashes } from "./integrity.mjs";
import { parseNodeDocument, serializeNodeDocument } from "./meta.mjs";
import { snapshotBootstrapRestrictedInputs } from "./snapshot.mjs";
import { validateProject } from "./validator.mjs";
import { enforceWindowsRestrictedAcls } from "./windows-acl.mjs";

const runtimeDirectory = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(runtimeDirectory, "..", "..");
const templateRoot = path.join(packageRoot, "project-template");
const projectRuntimeRoot = path.join(packageRoot, "runtime", "project");
const installedLibraryNames = [
  "activation.mjs",
  "bootstrap-contract.mjs",
  "bootstrap-resolution.mjs",
  "contract.mjs",
  "codex.mjs",
  "doctor.mjs",
  "deferred.mjs",
  "episode.mjs",
  "files.mjs",
  "initialization.mjs",
  "integrity.mjs",
  "locale.mjs",
  "lifecycle.mjs",
  "meta.mjs",
  "migration.mjs",
  "policy.mjs",
  "projection.mjs",
  "router.mjs",
  "structure.mjs",
  "transaction.mjs",
  "version-check.mjs",
  "validator.mjs",
  "windows-acl.mjs"
];

function tomlString(value) {
  return JSON.stringify(value.replaceAll("\\", "/"));
}

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function renderAdditionalRestrictedToml(boundaries) {
  return boundaries
    .map((boundary) => `${JSON.stringify(boundary.relative)} = "deny"`)
    .join("\n");
}

export function setWindowsHidden(directory) {
  if (process.platform !== "win32") return Promise.resolve(false);
  return new Promise((resolve, reject) => {
    const child = spawn("attrib.exe", ["+H", directory], {
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"]
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve(true);
      else reject(new Error(`failed to hide assistant directory: ${stderr.trim()}`));
    });
  });
}

function runGit(root, args) {
  return new Promise((resolve) => {
    const child = spawn("git", args, {
      cwd: root,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.once("error", () => resolve(null));
    child.once("close", (code) => resolve(code === 0 ? stdout.trim() : null));
  });
}

const EXCLUDE_START = "# assistant-managed:start";
const EXCLUDE_END = "# assistant-managed:end";

export async function installGitExclude(root, patterns) {
  const repositoryPrefix = await runGit(root, ["rev-parse", "--show-prefix"]);
  const rawPath = await runGit(root, ["rev-parse", "--git-path", "info/exclude"]);
  if (!rawPath || repositoryPrefix === null) return null;
  const excludePath = path.resolve(root, rawPath);
  const targetPrefix = repositoryPrefix
    .replaceAll("\\", "/")
    .replace(/\/+$/u, "");
  const scopedPatterns = patterns.map((pattern) => {
    const suffix = pattern.startsWith("/") ? pattern.slice(1) : pattern;
    return `/${targetPrefix ? `${targetPrefix}/` : ""}${suffix}`;
  });
  const priorExists = await pathExists(excludePath);
  const prior = priorExists ? await readFile(excludePath, "utf8") : "";
  if (prior.includes(EXCLUDE_START) || prior.includes(EXCLUDE_END)) {
    throw new Error("existing Git local exclude contains assistant managed markers");
  }
  const body = [
    EXCLUDE_START,
    ...scopedPatterns,
    EXCLUDE_END
  ].join("\n");
  const separator = prior.length === 0 || prior.endsWith("\n") ? "" : "\n";
  const prefix = prior.length === 0 ? "" : `${separator}\n`;
  await mkdir(path.dirname(excludePath), { recursive: true });
  await writeFile(excludePath, `${prior}${prefix}${body}\n`, "utf8");
  return {
    path: excludePath,
    prior_exists: priorExists,
    patterns: scopedPatterns
  };
}

async function removeGitExclude(change) {
  if (!change || !(await pathExists(change.path))) return;
  const content = await readFile(change.path, "utf8");
  const start = content.indexOf(EXCLUDE_START);
  const end = content.indexOf(EXCLUDE_END);
  if (start < 0 || end < start) return;
  const after = end + EXCLUDE_END.length;
  const next = `${content.slice(0, start)}${content.slice(after)}`
    .replace(/\r?\n{3,}/gu, "\n\n")
    .trimEnd();
  await writeFile(change.path, next ? `${next}\n` : "", "utf8");
}

async function writeInstallationLedger(root, assets) {
  await writeUtf8(
    path.join(root, ".assistant", "internal", "installation.json"),
    `${JSON.stringify({
      schema: "assistant.installation/v1",
      installed_at: new Date().toISOString(),
      assets
    }, null, 2)}\n`
  );
}

export async function replacePlaceholders(root, replacements) {
  const textExtensions = new Set([".md", ".json", ".toml", ".gitignore"]);
  async function visit(current) {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await visit(absolute);
      } else if (entry.isFile()) {
        const extension = path.extname(entry.name).toLowerCase();
        if (
          !textExtensions.has(extension) &&
          entry.name !== "AGENTS.md" &&
          extension !== ".mjs"
        ) continue;
        let content = await readFile(absolute, "utf8");
        for (const [key, value] of Object.entries(replacements)) {
          content = content.replaceAll(`{{${key}}}`, value);
        }
        await writeFile(absolute, content, "utf8");
      }
    }
  }
  await visit(root);
}

export async function copyInstalledRuntime(destination) {
  await cp(projectRuntimeRoot, path.join(destination, "runtime"), {
    recursive: true,
    errorOnExist: true,
    force: false
  });
  const libraryDestination = path.join(destination, "lib");
  await mkdir(libraryDestination, { recursive: true });
  for (const name of installedLibraryNames) {
    await cp(
      path.join(packageRoot, "runtime", "lib", name),
      path.join(libraryDestination, name),
      { errorOnExist: true, force: false }
    );
  }
}

export async function initializeBlankProject(target) {
  const root = path.resolve(target);
  await mkdir(root, { recursive: true });
  const existing = await readdir(root);
  if (existing.length > 0) {
    throw new Error("existing-project bootstrap is not implemented in this slice; target must be empty");
  }

  const templateEntries = await readdir(templateRoot);
  for (const entry of templateEntries) {
    await cp(path.join(templateRoot, entry), path.join(root, entry), {
      recursive: true,
      errorOnExist: true,
      force: false
    });
  }
  await copyInstalledRuntime(path.join(root, ".assistant", "system"));
  const visibility = [];
  for (const relative of [".assistant", ".agents", ".codex"]) {
    if (await setWindowsHidden(path.join(root, relative))) {
      visibility.push({ path: relative, created: true, hidden_by_assistant: true });
    }
  }
  const timestamp = new Date().toISOString();
  await replacePlaceholders(root, {
    PROJECT_ID: randomUUID(),
    TIMESTAMP: timestamp,
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
  });

  const manifest = JSON.parse(
    await readFile(path.join(root, ".assistant", "manifest.json"), "utf8")
  );
  const skillPath = `.agents/skills/assistant-${manifest.profile}-workflow`;
  const gitExclude = await installGitExclude(root, [
    "/.assistant/",
    "/.agents/",
    "/.codex/",
    "/AGENTS.md"
  ]);
  await writeInstallationLedger(root, {
    agents: { action: "created", path: "AGENTS.md" },
    codex_config: {
      action: "created",
      path: ".codex/config.toml",
      fingerprint: await fingerprintAsset(path.join(root, ".codex", "config.toml"))
    },
    skill: {
      action: "created",
      path: skillPath,
      fingerprint: await fingerprintAsset(path.join(root, ...skillPath.split("/")))
    },
    discovery_directories: [
      { path: ".agents", created: true },
      { path: ".codex", created: true }
    ],
    visibility,
    git_exclude: gitExclude
  });

  await refreshValidatedHashes(root, "blank_initialization");
  const validation = await validateProject(root);
  if (!validation.valid) {
    throw new Error(`installed project failed validation: ${JSON.stringify(validation.findings)}`);
  }
  await enforceWindowsRestrictedAcls(root);

  return {
    schema: "assistant.init-result/v1",
    target: root,
    mode: "blank",
    initialization_status: "ready",
    activity_status: "awaiting_direction",
    validation
  };
}

const MANAGED_START = "<!-- assistant-managed:start -->";
const MANAGED_END = "<!-- assistant-managed:end -->";

export async function readManagedBlock() {
  const templateAgents = await readFile(path.join(templateRoot, "AGENTS.md"), "utf8");
  const start = templateAgents.indexOf(MANAGED_START);
  const end = templateAgents.indexOf(MANAGED_END);
  if (start < 0 || end < 0) throw new Error("template AGENTS managed block is invalid");
  return templateAgents.slice(start, end + MANAGED_END.length);
}

async function materializeAssistantDirectory(root, replacements) {
  const destination = path.join(root, ".assistant");
  await cp(path.join(templateRoot, ".assistant"), destination, {
    recursive: true,
    errorOnExist: true,
    force: false
  });
  await copyInstalledRuntime(path.join(destination, "system"));
  await replacePlaceholders(destination, replacements);
}

async function updateCurrentForBootstrap(root, timestamp) {
  const currentPath = path.join(root, ".assistant", "CURRENT.md");
  const parsed = parseNodeDocument(await readFile(currentPath, "utf8"), currentPath);
  parsed.metadata.verified_at = timestamp;
  parsed.metadata.initialization_status = "bootstrap_incomplete";
  parsed.metadata.activity_status = "paused";
  parsed.metadata.active_work_id = "BOOTSTRAP-EXISTING";
  parsed.metadata.authorization = "active";
  const body = `# Current state

- Initialization: \`bootstrap_incomplete\`
- Activity: \`paused\`
- Active work: existing-project semantic bootstrap
- Current authorization: survey and canonical staging only
- Assistant operation not yet authorized: canonical execution based on this incomplete survey
- Pending decision: determined by semantic survey
- Last verified: \`${timestamp}\`

The deterministic inventory is complete, but semantic coverage and closed-book
validation are not. Resume the versioned bootstrap workflow. Do not present this
assistant context as ready. This does not restrict human or non-assistant
project work.
`;
  await writeFile(
    currentPath,
    serializeNodeDocument(parsed.metadata, body),
    "utf8"
  );
}

async function updateManifestForBootstrap(root) {
  const manifestPath = path.join(root, ".assistant", "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.initialization_status = "bootstrap_incomplete";
  manifest.activity_status = "paused";
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

async function installRootAgents(root) {
  const agentsPath = path.join(root, "AGENTS.md");
  const managedBlock = await readManagedBlock();
  if (!(await pathExists(agentsPath))) {
    await writeFile(agentsPath, `${managedBlock}\n`, "utf8");
    return { action: "created", backup: null };
  }

  const existing = await readFile(agentsPath, "utf8");
  if (existing.includes(MANAGED_START) || existing.includes(MANAGED_END)) {
    throw new Error("existing AGENTS.md contains an assistant managed marker");
  }
  const backupPath = path.join(root, ".assistant", "internal", "backup", "AGENTS.md");
  await writeUtf8(backupPath, existing);
  const competingControlPaths = [
    ...new Set(
      [...existing.matchAll(
        /(?:^|[\s`"'(])((?:docs|documentation)[/\\](?:agent|assistant)[/\\](?:INDEX|CURRENT|PLAN|POLICY)\.md)/gimu
      )].map((match) => match[1].replaceAll("\\", "/"))
    )
  ];
  let pendingMigration = null;
  if (competingControlPaths.length > 0) {
    pendingMigration = path.join(
      root,
      ".assistant",
      "internal",
      "pending",
      "agents-control-plane.json"
    );
    await writeUtf8(
      pendingMigration,
      `${JSON.stringify({
        schema: "assistant.agents-migration/v1",
        kind: "agents_control_plane",
        status: "pending_user_review",
        original_backup: ".assistant/internal/backup/AGENTS.md",
        competing_control_paths: competingControlPaths,
        required_resolution: [
          "keep non-conflicting repository-native build, test, and subtree instructions in AGENTS.md",
          "move durable assistant side-effect policy to .assistant/POLICY.md when it should remain active",
          "remove or rewrite legacy canonical orientation and state-owner routes so .assistant is the only assistant control plane",
          "review the proposed result, then explicitly confirm migration completion"
        ],
        created_at: new Date().toISOString()
      }, null, 2)}\n`
    );
  }
  const separator = existing.endsWith("\n") ? "\n" : "\n\n";
  await writeFile(agentsPath, `${existing}${separator}${managedBlock}\n`, "utf8");
  return {
    action: pendingMigration ? "merged_with_pending_migration" : "merged",
    backup: backupPath,
    pending_migration: pendingMigration
  };
}

export async function renderInstalledFile(filePath, replacements) {
  let content = await readFile(filePath, "utf8");
  for (const [key, value] of Object.entries(replacements)) {
    content = content.replaceAll(`{{${key}}}`, value);
  }
  await writeFile(filePath, content, "utf8");
}

async function installProjectConfig(root, replacements) {
  const codexDirectory = path.join(root, ".codex");
  const configPath = path.join(codexDirectory, "config.toml");
  if (await pathExists(configPath)) {
    const pendingPath = path.join(
      root,
      ".assistant",
      "internal",
      "pending",
      "assistant-config.toml"
    );
    await mkdir(path.dirname(pendingPath), { recursive: true });
    const backupPath = path.join(
      root,
      ".assistant",
      "internal",
      "backup",
      ".codex",
      "config.toml"
    );
    await mkdir(path.dirname(backupPath), { recursive: true });
    await cp(configPath, backupPath, {
      errorOnExist: true,
      force: false
    });
    await cp(path.join(templateRoot, ".codex", "config.toml"), pendingPath, {
      errorOnExist: true,
      force: false
    });
    await renderInstalledFile(pendingPath, replacements);
    return { action: "staged", path: pendingPath };
  }
  await mkdir(codexDirectory, { recursive: true });
  await cp(path.join(templateRoot, ".codex", "config.toml"), configPath, {
    errorOnExist: true,
    force: false
  });
  await renderInstalledFile(configPath, replacements);
  return { action: "created", path: configPath };
}

async function installAgentSkills(root) {
  const templateManifest = JSON.parse(
    await readFile(
      path.join(templateRoot, ".assistant", "manifest.json"),
      "utf8"
    )
  );
  const skillName = `assistant-${templateManifest.profile}-workflow`;
  const source = path.join(
    templateRoot,
    ".agents",
    "skills",
    skillName
  );
  const destination = path.join(
    root,
    ".agents",
    "skills",
    skillName
  );
  if (await pathExists(destination)) {
    const pending = path.join(
      root,
      ".assistant",
      "internal",
      "pending",
      "skills",
      skillName
    );
    await mkdir(path.dirname(pending), { recursive: true });
    await cp(source, pending, {
      recursive: true,
      errorOnExist: true,
      force: false
    });
    return { action: "staged", path: pending };
  }
  await mkdir(path.dirname(destination), { recursive: true });
  await cp(source, destination, {
    recursive: true,
    errorOnExist: true,
    force: false
  });
  return { action: "created", path: destination };
}

async function ensureInterfaceDirectories(root) {
  const changes = [];
  for (const relative of ["docs/user", "docs/report"]) {
    const destination = path.join(root, ...relative.split("/"));
    if (!(await pathExists(destination))) {
      await mkdir(destination, { recursive: true });
      changes.push({ path: relative, action: "created" });
    } else {
      changes.push({ path: relative, action: "preserved" });
    }
  }
  return changes;
}

export async function initializeExistingProject(target, options = {}) {
  const root = path.resolve(target);
  if (!(await pathExists(root))) throw new Error(`target does not exist: ${root}`);
  if (await pathExists(path.join(root, ".assistant"))) {
    throw new Error("reserved path conflict: target already contains .assistant");
  }

  const inventory = await inventoryProject(root);
  const preexisting = {
    agentsDirectory: await pathExists(path.join(root, ".agents")),
    codexDirectory: await pathExists(path.join(root, ".codex"))
  };
  const timestamp = new Date().toISOString();
  const replacements = {
    PROJECT_ID: randomUUID(),
    TIMESTAMP: timestamp,
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
    ADDITIONAL_RESTRICTED_TOML: renderAdditionalRestrictedToml(
      options.restrictedBoundaries ?? []
    )
  };
  let agentsChange = null;
  let configChange = null;
  let skillsChange = null;
  let gitExclude = null;
  const createdPaths = [];

  try {
    await materializeAssistantDirectory(root, replacements);
    createdPaths.push(path.join(root, ".assistant"));
    const visibility = [];
    if (await setWindowsHidden(path.join(root, ".assistant"))) {
      visibility.push({
        path: ".assistant",
        created: true,
        hidden_by_assistant: true
      });
    }
    await updateManifestForBootstrap(root);
    await updateCurrentForBootstrap(root, timestamp);
    await writeUtf8(
      path.join(root, ".assistant", "internal", "bootstrap", "inventory.json"),
      `${JSON.stringify(inventory, null, 2)}\n`
    );
    if ((options.importedSources ?? []).length > 0) {
      await writeUtf8(
        path.join(
          root,
          ".assistant",
          "internal",
          "bootstrap",
          "source-authority.json"
        ),
        `${JSON.stringify({
          schema: "assistant.bootstrap-source-authority/v1",
          authority: "current_user_instruction",
          purpose: "canonical_initialization",
          imported_paths: options.importedSources,
          recorded_at: timestamp
        }, null, 2)}\n`
      );
    }
    await writeUtf8(
      path.join(
        root,
        ".assistant",
        "internal",
        "restricted",
        "boundaries.json"
      ),
      `${JSON.stringify({
        schema: "assistant.restricted-boundaries/v1",
        boundaries: options.restrictedBoundaries ?? [],
        recorded_at: timestamp
      }, null, 2)}\n`
    );
    const restrictedSnapshots = await snapshotBootstrapRestrictedInputs(
      root,
      inventory
    );
    await writeUtf8(
      path.join(root, ".assistant", "internal", "bootstrap", "state.json"),
      `${JSON.stringify({
        schema: "assistant.bootstrap-state/v1",
        run_id: randomUUID(),
        phase: "bootstrapping",
        status: "bootstrap_incomplete",
        inventory_complete: true,
        semantic_survey_complete: false,
        closed_book_validated: false,
        created_at: timestamp
      }, null, 2)}\n`
    );

    agentsChange = await installRootAgents(root);
    if (agentsChange.action === "created") createdPaths.push(path.join(root, "AGENTS.md"));
    configChange = await installProjectConfig(root, replacements);
    if (configChange.action === "created") createdPaths.push(configChange.path);
    skillsChange = await installAgentSkills(root);
    if (skillsChange.action === "created") createdPaths.push(skillsChange.path);
    const interfaceChanges = await ensureInterfaceDirectories(root);
    for (const record of [
      { path: ".agents", created: !preexisting.agentsDirectory },
      { path: ".codex", created: !preexisting.codexDirectory }
    ]) {
      if (record.created && await setWindowsHidden(path.join(root, record.path))) {
        visibility.push({ ...record, hidden_by_assistant: true });
      }
    }

    const excludePatterns = ["/.assistant/"];
    if (agentsChange.action === "created") excludePatterns.push("/AGENTS.md");
    if (configChange.action === "created") excludePatterns.push("/.codex/config.toml");
    if (skillsChange.action === "created") {
      excludePatterns.push(`/${path.relative(root, skillsChange.path).replaceAll(path.sep, "/")}/`);
    }
    gitExclude = await installGitExclude(root, excludePatterns);
    await writeInstallationLedger(root, {
      agents: {
        action: agentsChange.action,
        path: "AGENTS.md",
        backup: agentsChange.backup
          ? path.relative(root, agentsChange.backup).replaceAll(path.sep, "/")
          : null
      },
      codex_config: {
        action: configChange.action,
        path: configChange.action === "staged"
          ? path.relative(root, configChange.path).replaceAll(path.sep, "/")
          : ".codex/config.toml",
        fingerprint: configChange.action === "created"
          ? await fingerprintAsset(configChange.path)
          : null
      },
      skill: {
        action: skillsChange.action,
        path: path.relative(root, skillsChange.path).replaceAll(path.sep, "/"),
        fingerprint: skillsChange.action === "created"
          ? await fingerprintAsset(skillsChange.path)
          : null
      },
      discovery_directories: [
        { path: ".agents", created: !preexisting.agentsDirectory },
        { path: ".codex", created: !preexisting.codexDirectory }
      ],
      visibility,
      git_exclude: gitExclude
    });

    await refreshValidatedHashes(root, "existing_bootstrap_staging");
    const validation = await validateProject(root);
    if (!validation.valid) {
      throw new Error(`bootstrap staging failed validation: ${JSON.stringify(validation.findings)}`);
    }
    await enforceWindowsRestrictedAcls(
      root,
      options.restrictedBoundaries ?? []
    );

    return {
      schema: "assistant.init-result/v1",
      target: root,
      mode: "existing",
      initialization_status: "bootstrap_incomplete",
      activity_status: "paused",
      inventory: inventory.summary,
      restricted_snapshots: restrictedSnapshots.records.length,
      changes: {
        agents: agentsChange.action,
        codex_config: configChange.action,
        agent_skills: skillsChange.action,
        interfaces: interfaceChanges
      },
      next: "run semantic bootstrap",
      validation
    };
  } catch (error) {
    await removeGitExclude(gitExclude);
    if (agentsChange?.action?.startsWith("merged") && agentsChange.backup) {
      await cp(agentsChange.backup, path.join(root, "AGENTS.md"), { force: true });
    }
    for (const created of createdPaths.reverse()) {
      if (await pathExists(created)) {
        await rm(created, { recursive: true, force: true });
      }
    }
    for (const directory of [
      !preexisting.agentsDirectory ? path.join(root, ".agents") : null,
      !preexisting.codexDirectory ? path.join(root, ".codex") : null
    ].filter(Boolean)) {
      if (!(await pathExists(directory))) continue;
      try {
        await rmdir(directory);
      } catch (cleanupError) {
        if (!["ENOTEMPTY", "ENOENT"].includes(cleanupError.code)) throw cleanupError;
      }
    }
    throw error;
  }
}

async function importInitializationSources(root, sources) {
  const imported = [];
  const restrictedBoundaries = [];
  const createdDirectories = [];
  for (const sourceInput of sources) {
    const source = path.resolve(sourceInput);
    if (!(await pathExists(source))) {
      throw new Error(`initialization source does not exist: ${source}`);
    }
    const sourceInfo = await lstat(source);
    const destinationRoot = path.join(
      root,
      "docs",
      "user",
      "bootstrap-source"
    );
    if (sourceInfo.isDirectory() && isInside(source, destinationRoot)) {
      throw new Error(
        "initialization source directory cannot contain its import destination"
      );
    }
    for (const directory of [
      path.join(root, "docs"),
      path.join(root, "docs", "user"),
      destinationRoot
    ]) {
      if (!(await pathExists(directory))) createdDirectories.push(directory);
    }
    await mkdir(destinationRoot, { recursive: true });
    const destination = path.join(destinationRoot, path.basename(source));
    if (await pathExists(destination)) {
      throw new Error(`initialization source collision: ${destination}`);
    }
    await cp(source, destination, {
      recursive: true,
      errorOnExist: true,
      force: false
    });
    imported.push(path.relative(root, destination).replaceAll(path.sep, "/"));
    if (isInside(root, source)) {
      const relative = path.relative(root, source).replaceAll(path.sep, "/");
      const coveredByDefault =
        relative === "docs/user" ||
        relative.startsWith("docs/user/") ||
        relative === "docs/report" ||
        relative.startsWith("docs/report/") ||
        relative === ".assistant/vault" ||
        relative.startsWith(".assistant/vault/");
      if (!coveredByDefault) {
        restrictedBoundaries.push({
          relative,
          kind: "source",
          boundary_kind: sourceInfo.isDirectory() ? "directory" : "file",
          reason: "explicit_initialization_source"
        });
      }
    }
  }
  return {
    imported,
    restrictedBoundaries,
    createdDirectories: [...new Set(createdDirectories)]
  };
}

export async function initializeProject(target, options = {}) {
  const root = path.resolve(target);
  await mkdir(root, { recursive: true });
  if (await pathExists(path.join(root, ".assistant"))) {
    throw new Error("target is already initialized");
  }
  const sourceImport = await importInitializationSources(
    root,
    options.sources ?? []
  );
  try {
    const entries = await readdir(root);
    if (entries.length === 0) return initializeBlankProject(root);
    return initializeExistingProject(root, {
      importedSources: sourceImport.imported,
      restrictedBoundaries: sourceImport.restrictedBoundaries
    });
  } catch (error) {
    for (const relative of sourceImport.imported.reverse()) {
      const importedPath = path.join(root, ...relative.split("/"));
      if (await pathExists(importedPath)) {
        await rm(importedPath, { recursive: true, force: true });
      }
    }
    for (const directory of sourceImport.createdDirectories.reverse()) {
      if (!(await pathExists(directory))) continue;
      try {
        await rmdir(directory);
      } catch (cleanupError) {
        if (!["ENOTEMPTY", "ENOENT"].includes(cleanupError.code)) throw cleanupError;
      }
    }
    throw error;
  }
}
