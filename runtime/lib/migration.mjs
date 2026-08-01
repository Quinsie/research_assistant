import { cp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { requiredSecurityFragments } from "./doctor.mjs";
import { pathExists, writeUtf8 } from "./files.mjs";
import { refreshValidatedHashes } from "./integrity.mjs";
import { parseNodeDocument, serializeNodeDocument } from "./meta.mjs";

export async function inspectPendingMigrations(target) {
  const root = path.resolve(target);
  const pendingRoot = path.join(root, ".assistant", "internal", "pending");
  if (!(await pathExists(pendingRoot))) {
    return { schema: "assistant.migration-status/v1", pending: [] };
  }
  const pending = [];
  const agentsPath = path.join(pendingRoot, "agents-control-plane.json");
  if (await pathExists(agentsPath)) {
    const record = JSON.parse(await readFile(agentsPath, "utf8"));
    pending.push({
      kind: "agents_control_plane",
      staged_path: ".assistant/internal/pending/agents-control-plane.json",
      competing_control_paths: record.competing_control_paths ?? [],
      action:
        "review the original AGENTS backup; preserve repository-native rules, migrate durable assistant policy to .assistant/POLICY.md as intended, remove competing canonical routes, then confirm completion"
    });
  }
  const configPath = path.join(pendingRoot, "assistant-config.toml");
  if (await pathExists(configPath)) {
    pending.push({
      kind: "codex_config",
      staged_path: ".assistant/internal/pending/assistant-config.toml",
      action:
        "manually merge the staged assistant sections into .codex/config.toml, preserving compatible existing settings, then confirm completion"
    });
  }
  const skillsRoot = path.join(pendingRoot, "skills");
  if (await pathExists(skillsRoot)) {
    for (const entry of await readdir(skillsRoot, { withFileTypes: true })) {
      pending.push({
        kind: "agent_skill",
        name: entry.name,
        staged_path: `.assistant/internal/pending/skills/${entry.name}`,
        action:
          "resolve the existing skill collision explicitly before activation"
      });
    }
  }
  return { schema: "assistant.migration-status/v1", pending };
}

export async function markPendingMigrationRequired(target, migrations) {
  const root = path.resolve(target);
  const timestamp = new Date().toISOString();
  const manifestPath = path.join(root, ".assistant", "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.initialization_status = "awaiting_user_input";
  manifest.activity_status = "paused";
  await writeUtf8(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const currentPath = path.join(root, ".assistant", "CURRENT.md");
  const current = parseNodeDocument(await readFile(currentPath, "utf8"));
  current.metadata.initialization_status = "awaiting_user_input";
  current.metadata.activity_status = "paused";
  current.metadata.active_work_id = "BOOTSTRAP-EXISTING";
  current.metadata.authorization = "active";
  current.metadata.verified_at = timestamp;
  const kinds = migrations.pending.map((item) => item.kind);
  await writeUtf8(
    currentPath,
    serializeNodeDocument(
      current.metadata,
      `# Current state

- Initialization: \`awaiting_user_input\`
- Activity: \`paused\`
- Active work: existing-project system migration
- Current authorization: inspect and resolve only the staged migrations
- Pending migration kinds: ${kinds.map((kind) => `\`${kind}\``).join(", ")}
- Blocked work: canonical activation and normal project work
- Next safe route: run the migration status command, review each staged/active difference, and obtain explicit confirmation
- Last verified: \`${timestamp}\`

Semantic survey output is staged, but competing system control assets must be
resolved before activation. Preserve user-owned rules and files until the
confirmed migration records their intended owner.
`
    )
  );
  const statePath = path.join(
    root,
    ".assistant",
    "internal",
    "bootstrap",
    "state.json"
  );
  if (await pathExists(statePath)) {
    const state = JSON.parse(await readFile(statePath, "utf8"));
    state.phase = "system_migration";
    state.status = "awaiting_user_input";
    state.pending_migration_kinds = kinds;
    state.updated_at = timestamp;
    await writeUtf8(statePath, `${JSON.stringify(state, null, 2)}\n`);
  }
  await refreshValidatedHashes(root, "pending_system_migration");
}

const MANAGED_START = "<!-- assistant-managed:start -->";
const MANAGED_END = "<!-- assistant-managed:end -->";

function competingAgentControlPaths(content) {
  const unmanaged = content.replace(
    /<!-- assistant-managed:start -->[\s\S]*?<!-- assistant-managed:end -->/gu,
    ""
  );
  return [
    ...new Set(
      [...unmanaged.matchAll(
        /(?:^|[\s`"'(])((?:docs|documentation)[/\\](?:agent|assistant)[/\\](?:INDEX|CURRENT|PLAN|POLICY)\.md)/gimu
      )].map((match) => match[1].replaceAll("\\", "/"))
    )
  ];
}

export async function completeAgentsControlPlaneMigration(
  target,
  options = {}
) {
  const root = path.resolve(target);
  if (options.confirmed !== true) {
    throw new Error("AGENTS control-plane migration completion requires --confirm");
  }
  const pending = path.join(
    root,
    ".assistant",
    "internal",
    "pending",
    "agents-control-plane.json"
  );
  if (!(await pathExists(pending))) {
    throw new Error("no staged AGENTS control-plane migration exists");
  }
  const active = path.join(root, "AGENTS.md");
  const content = await readFile(active, "utf8");
  if (
    (content.match(new RegExp(MANAGED_START, "gu")) ?? []).length !== 1 ||
    (content.match(new RegExp(MANAGED_END, "gu")) ?? []).length !== 1
  ) {
    throw new Error("active AGENTS.md does not contain exactly one managed block");
  }
  const remaining = competingAgentControlPaths(content);
  if (remaining.length > 0) {
    throw new Error(
      `active AGENTS.md still contains competing assistant control paths: ${remaining.join(", ")}`
    );
  }
  const migrationId = `MIG-AGENTS-${Date.now()}`;
  const archive = path.join(
    root,
    ".assistant",
    "internal",
    "migrations",
    migrationId
  );
  await mkdir(archive, { recursive: true });
  await cp(active, path.join(archive, "accepted-AGENTS.md"));
  await cp(pending, path.join(archive, "pending-record.json"));
  const policy = path.join(root, ".assistant", "POLICY.md");
  await cp(policy, path.join(archive, "accepted-POLICY.md"));
  const original = path.join(
    root,
    ".assistant",
    "internal",
    "backup",
    "AGENTS.md"
  );
  if (await pathExists(original)) {
    await cp(original, path.join(archive, "original-AGENTS.md"));
  }
  await writeUtf8(
    path.join(archive, "record.json"),
    `${JSON.stringify({
      schema: "assistant.system-migration/v1",
      id: migrationId,
      kind: "agents_control_plane",
      status: "completed",
      confirmation:
        "caller confirmed semantic review of retained AGENTS rules and POLICY ownership",
      completed_at: new Date().toISOString()
    }, null, 2)}\n`
  );
  await rm(pending, { force: true });
  return {
    schema: "assistant.system-migration-result/v1",
    id: migrationId,
    status: "completed",
    next: "rerun assistant init --target <project> to resume semantic activation"
  };
}

export async function completeCodexConfigMigration(target, options = {}) {
  const root = path.resolve(target);
  if (options.confirmed !== true) {
    throw new Error("Codex config migration completion requires --confirm");
  }
  const pending = path.join(
    root,
    ".assistant",
    "internal",
    "pending",
    "assistant-config.toml"
  );
  if (!(await pathExists(pending))) {
    throw new Error("no staged Codex config migration exists");
  }
  const active = path.join(root, ".codex", "config.toml");
  if (!(await pathExists(active))) throw new Error("active Codex config is missing");
  const content = await readFile(active, "utf8");
  const required = await requiredSecurityFragments(root);
  const missing = required.filter((fragment) => !content.includes(fragment));
  if (missing.length > 0) {
    throw new Error(
      `active Codex config does not contain the staged security contract: ${missing.join(", ")}`
    );
  }
  const migrationId = `MIG-CODEX-${Date.now()}`;
  const archive = path.join(
    root,
    ".assistant",
    "internal",
    "migrations",
    migrationId
  );
  await mkdir(archive, { recursive: true });
  await cp(active, path.join(archive, "accepted-config.toml"));
  await cp(pending, path.join(archive, "staged-assistant-config.toml"));
  const original = path.join(
    root,
    ".assistant",
    "internal",
    "backup",
    ".codex",
    "config.toml"
  );
  if (await pathExists(original)) {
    await cp(original, path.join(archive, "original-config.toml"));
  }
  await writeUtf8(
    path.join(archive, "record.json"),
    `${JSON.stringify({
      schema: "assistant.system-migration/v1",
      id: migrationId,
      kind: "codex_config",
      status: "completed",
      completed_at: new Date().toISOString()
    }, null, 2)}\n`
  );
  await rm(pending, { force: true });
  return {
    schema: "assistant.system-migration-result/v1",
    id: migrationId,
    status: "completed",
    next: "rerun assistant init --target <project> to resume semantic activation"
  };
}

export async function replacePendingSkillMigration(
  target,
  skillName,
  options = {}
) {
  const root = path.resolve(target);
  if (options.confirmed !== true) {
    throw new Error("skill replacement requires --confirm");
  }
  if (
    typeof skillName !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(skillName)
  ) {
    throw new Error("invalid skill name");
  }
  const pending = path.join(
    root,
    ".assistant",
    "internal",
    "pending",
    "skills",
    skillName
  );
  if (!(await pathExists(pending))) {
    throw new Error(`no staged skill migration exists for ${skillName}`);
  }
  const active = path.join(root, ".agents", "skills", skillName);
  const migrationId = `MIG-SKILL-${Date.now()}`;
  const archive = path.join(
    root,
    ".assistant",
    "internal",
    "migrations",
    migrationId
  );
  await mkdir(archive, { recursive: true });
  if (await pathExists(active)) {
    await cp(active, path.join(archive, "original-skill"), {
      recursive: true
    });
  }
  await cp(pending, path.join(archive, "staged-skill"), {
    recursive: true
  });
  try {
    if (await pathExists(active)) {
      await rm(active, { recursive: true, force: true });
    }
    await mkdir(path.dirname(active), { recursive: true });
    await cp(pending, active, { recursive: true });
    await rm(pending, { recursive: true, force: true });
    await writeUtf8(
      path.join(archive, "record.json"),
      `${JSON.stringify({
        schema: "assistant.system-migration/v1",
        id: migrationId,
        kind: "agent_skill",
        skill_name: skillName,
        status: "completed",
        completed_at: new Date().toISOString()
      }, null, 2)}\n`
    );
    return {
      schema: "assistant.system-migration-result/v1",
      id: migrationId,
      status: "completed",
      replaced_skill: skillName,
      next: "rerun assistant init --target <project> to resume semantic activation"
    };
  } catch (error) {
    if (await pathExists(active)) {
      await rm(active, { recursive: true, force: true });
    }
    const backup = path.join(archive, "original-skill");
    if (await pathExists(backup)) {
      await cp(backup, active, { recursive: true });
    }
    throw error;
  }
}
