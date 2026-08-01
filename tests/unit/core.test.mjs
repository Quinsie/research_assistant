import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  initializeBlankProject,
  initializeProject
} from "../../runtime/lib/installer.mjs";
import { activateBootstrap } from "../../runtime/lib/activation.mjs";
import {
  RESEARCH_WORKFLOW_HEADINGS,
  SOFTWARE_WORKFLOW_HEADINGS
} from "../../runtime/lib/contract.mjs";
import {
  discoverCodexInvocation,
  recoverRejectedBootstrap,
  validateBootstrapOutput
} from "../../runtime/lib/bootstrap.mjs";
import {
  repairDeterministicBootstrapRelations,
  validateBootstrapRepair
} from "../../runtime/lib/bootstrap-contract.mjs";
import { buildEvidencePacket } from "../../runtime/lib/evidence-packet.mjs";
import { doctorProject } from "../../runtime/lib/doctor.mjs";
import { pathExists, writeUtf8 } from "../../runtime/lib/files.mjs";
import {
  claimDeferredRequest,
  completeDeferredRequest,
  inspectDeferredRequest
} from "../../runtime/lib/deferred.mjs";
import { authorizeTerminalEpisode } from "../../runtime/lib/episode.mjs";
import { finalizeInstalledProject } from "../../runtime/lib/initialization.mjs";
import { refreshValidatedHashes } from "../../runtime/lib/integrity.mjs";
import { setProjectLocale } from "../../runtime/lib/locale.mjs";
import {
  completeAgentsControlPlaneMigration,
  completeCodexConfigMigration,
  inspectPendingMigrations,
  markPendingMigrationRequired
} from "../../runtime/lib/migration.mjs";
import { resolveBootstrap } from "../../runtime/lib/bootstrap-resolution.mjs";
import { prepareBootstrapRetry } from "../../runtime/lib/bootstrap-retry.mjs";
import {
  parseNodeDocument,
  parsePolicyRules,
  serializeNodeDocument
} from "../../runtime/lib/meta.mjs";
import { resolvePolicy } from "../../runtime/lib/policy.mjs";
import { preflightInitialization } from "../../runtime/lib/preflight.mjs";
import { routeTask } from "../../runtime/lib/router.mjs";
import {
  inspectStructure,
  maintainStructure,
  refreshIndex
} from "../../runtime/lib/structure.mjs";
import {
  commitCanonicalUpdate,
  stageCanonicalUpdate
} from "../../runtime/lib/transaction.mjs";
import {
  loadCanonicalNodes,
  validateProject
} from "../../runtime/lib/validator.mjs";

async function runHook(target, prompt) {
  const script = path.join(
    target,
    ".assistant",
    "system",
    "runtime",
    "user-prompt-submit.mjs"
  );
  const child = spawn(process.execPath, [script], {
    cwd: target,
    env: { ...process.env, ASSISTANT_PROJECT_ROOT: target },
    stdio: ["pipe", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdin.end(JSON.stringify({
    session_id: "session-test",
    turn_id: "turn-test",
    cwd: target,
    hook_event_name: "UserPromptSubmit",
    model: "test",
    permission_mode: "default",
    prompt
  }));
  const status = await new Promise((resolve) => child.on("close", resolve));
  assert.equal(status, 0, stderr);
  return stdout ? JSON.parse(stdout) : null;
}

async function callGateway(target, calls) {
  const script = path.join(
    target,
    ".assistant",
    "system",
    "runtime",
    "gateway.mjs"
  );
  const child = spawn(process.execPath, [script], {
    cwd: target,
    env: { ...process.env, ASSISTANT_PROJECT_ROOT: target },
    stdio: ["pipe", "pipe", "pipe"]
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const responses = [];
  let pending = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    pending += chunk;
    let newline;
    while ((newline = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, newline).trim();
      pending = pending.slice(newline + 1);
      if (line) responses.push(JSON.parse(line));
    }
  });
  for (let index = 0; index < calls.length; index += 1) {
    child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: index + 1,
      method: "tools/call",
      params: calls[index]
    })}\n`);
  }
  const deadline = Date.now() + 5_000;
  while (responses.length < calls.length && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const closed = new Promise((resolve) => child.once("close", resolve));
  child.kill();
  await closed;
  assert.equal(responses.length, calls.length, stderr);
  return responses.sort((a, b) => a.id - b.id);
}

test("node metadata envelope round-trips without moving semantic body", () => {
  const metadata = {
    schema: "assistant.node/v1",
    id: "HYP-001",
    type: "hypothesis",
    status: "proposed",
    authority: "canonical_agent",
    relations: [],
    verified_at: "2026-07-31T00:00:00.000Z"
  };
  const body = "# Hypothesis\n\nExact statement.\n";
  const serialized = serializeNodeDocument(metadata, body);
  const parsed = parseNodeDocument(serialized);
  assert.deepEqual(parsed.metadata, metadata);
  assert.equal(parsed.body, body);
});

test("policy parser resolves only the requested side effect", () => {
  const content = `<!-- assistant-policy
{"id":"POL-A","side_effects":["git_commit"],"value":"explicit","enabled":true}
-->
<!-- assistant-policy
{"id":"POL-B","side_effects":["git_push"],"value":"never","enabled":true}
-->`;
  assert.equal(parsePolicyRules(content).length, 2);
  const result = resolvePolicy(content, "git_push");
  assert.equal(result.status, "resolved");
  assert.equal(result.ruleId, "POL-B");
  assert.equal(result.effective, "never");
  const canonical = resolvePolicy(content, "canonical_write");
  assert.equal(canonical.status, "resolved");
  assert.equal(canonical.source, "profile_default");
  assert.equal(
    canonical.effective,
    "allowed_with_research_schema_transaction_and_validation"
  );
});

test("router is semantic-type based and does not depend on filenames", () => {
  const nodes = [
    {
      path: ".assistant/CURRENT.md",
      metadata: { id: "CUR-001", type: "current" }
    },
    {
      path: ".assistant/knowledge/arbitrary-name.md",
      metadata: { id: "Q-001", type: "question" }
    },
    {
      path: ".assistant/knowledge/not-numbered.md",
      metadata: { id: "H-001", type: "hypothesis" }
    }
  ];
  const result = routeTask(nodes, "hypothesis");
  assert.equal(result.status, "routed");
  assert.deepEqual(
    result.required.map((item) => item.id),
    ["CUR-001", "Q-001", "H-001"]
  );
  const missingExperiment = routeTask(nodes, "experiment");
  assert.equal(missingExperiment.status, "documentation_gap");
  assert.deepEqual(missingExperiment.missing_primary_types, ["experiment"]);
  assert.deepEqual(
    missingExperiment.required.map((item) => item.id),
    ["CUR-001", "Q-001", "H-001"]
  );

  const idle = routeTask([
    {
      path: ".assistant/CURRENT.md",
      metadata: {
        id: "CUR-001",
        type: "current",
        activity_status: "idle",
        authorization: "not_authorized"
      }
    }
  ], "continue");
  assert.equal(idle.status, "awaiting_direction");
  assert.equal(idle.reason, "no active work is registered");
  assert.equal(idle.authorization, "not_authorized");
  assert.equal("missing_primary_types" in idle, false);
});

test("blank initialization creates a valid minimal project", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "assistant-blank-"));
  try {
    const target = path.join(tempRoot, "project");
    const result = await initializeBlankProject(target);
    assert.equal(result.mode, "blank");
    assert.equal(result.validation.valid, true);
    assert.equal(result.validation.summary.nodes, 2);

    const manifest = JSON.parse(
      await readFile(path.join(target, ".assistant", "manifest.json"), "utf8")
    );
    assert.match(manifest.project_id, /^[0-9a-f-]{36}$/);
    assert.equal(manifest.initialization_status, "ready");
    assert.equal(manifest.activity_status, "awaiting_direction");
    const current = parseNodeDocument(
      await readFile(path.join(target, ".assistant", "CURRENT.md"), "utf8")
    );
    assert.equal(current.metadata.initialization_status, "ready");
    assert.equal(current.metadata.activity_status, "awaiting_direction");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("validator rejects a missing relation target", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "assistant-relation-"));
  try {
    const target = path.join(tempRoot, "project");
    await initializeBlankProject(target);
    const currentPath = path.join(target, ".assistant", "CURRENT.md");
    const parsed = parseNodeDocument(await readFile(currentPath, "utf8"));
    parsed.metadata.relations.push({ type: "routes_to", target: "MISSING-001" });
    await writeFile(
      currentPath,
      serializeNodeDocument(parsed.metadata, parsed.body),
      "utf8"
    );

    const validation = await validateProject(target);
    assert.equal(validation.valid, false);
    assert.ok(
      validation.findings.some(
        (finding) => finding.code === "MISSING_RELATION_TARGET"
      )
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("validator rejects duplicate canonical relations", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "assistant-duplicate-relation-"));
  try {
    const target = path.join(tempRoot, "project");
    await initializeBlankProject(target);
    const currentPath = path.join(target, ".assistant", "CURRENT.md");
    const parsed = parseNodeDocument(await readFile(currentPath, "utf8"));
    parsed.metadata.relations = [
      { type: "routes_to", target: "POL-001" },
      { type: "routes_to", target: "POL-001" }
    ];
    await writeFile(
      currentPath,
      serializeNodeDocument(parsed.metadata, parsed.body),
      "utf8"
    );

    const validation = await validateProject(target);
    assert.equal(validation.valid, false);
    assert.ok(
      validation.findings.some(
        (finding) => finding.code === "DUPLICATE_RELATION"
      )
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("validator rejects CURRENT and manifest state drift", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "assistant-drift-"));
  try {
    const target = path.join(tempRoot, "project");
    await initializeBlankProject(target);
    const manifestPath = path.join(target, ".assistant", "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.activity_status = "active";
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
    const validation = await validateProject(target);
    assert.equal(validation.valid, false);
    assert.ok(
      validation.findings.some(
        (finding) => finding.code === "CURRENT_MANIFEST_DRIFT"
      )
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("existing project initialization preserves assets and remains incomplete", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "assistant-existing-"));
  const target = path.join(tempRoot, "legacy project");
  try {
    await mkdir(path.join(target, "docs", "user"), { recursive: true });
    await writeFile(
      path.join(target, "README.md"),
      "# Existing project\n",
      "utf8"
    );
    await writeFile(
      path.join(target, "AGENTS.md"),
      "# Existing conventions\n\nRun local tests.\n",
      "utf8"
    );
    await writeFile(
      path.join(target, "docs", "user", "legacy.md"),
      "legacy source\n",
      "utf8"
    );

    const result = await initializeProject(target);
    assert.equal(result.mode, "existing");
    assert.equal(result.initialization_status, "bootstrap_incomplete");
    assert.equal(result.validation.valid, true);
    assert.ok(result.inventory.paths >= 5);
    assert.equal(result.restricted_snapshots, 1);

    const agents = await readFile(path.join(target, "AGENTS.md"), "utf8");
    assert.match(agents, /Run local tests/);
    assert.match(agents, /assistant-managed:start/);

    const source = await readFile(
      path.join(target, "docs", "user", "legacy.md"),
      "utf8"
    );
    assert.equal(source, "legacy source\n");

    const manifest = JSON.parse(
      await readFile(path.join(target, ".assistant", "manifest.json"), "utf8")
    );
    assert.equal(manifest.initialization_status, "bootstrap_incomplete");
    assert.equal(manifest.activity_status, "paused");

    const inventory = JSON.parse(
      await readFile(
        path.join(
          target,
          ".assistant",
          "internal",
          "bootstrap",
          "inventory.json"
        ),
        "utf8"
      )
    );
    assert.ok(
      inventory.entries.some(
        (entry) => entry.path === "docs/user/legacy.md"
      )
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("legacy AGENTS control routes stage an explicit migration before activation", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "assistant-agents-migration-"));
  const target = path.join(tempRoot, "legacy project");
  try {
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, "README.md"), "# Existing project\n", "utf8");
    await writeFile(
      path.join(target, "AGENTS.md"),
      [
        "# Existing rules",
        "",
        "Read `docs/agent/INDEX.md` and `docs/agent/CURRENT.md` before work.",
        "Run local tests before handoff.",
        ""
      ].join("\n"),
      "utf8"
    );

    const result = await initializeProject(target);
    assert.equal(result.changes.agents, "merged_with_pending_migration");
    const migrations = await inspectPendingMigrations(target);
    assert.deepEqual(
      migrations.pending.map((item) => item.kind),
      ["agents_control_plane"]
    );
    await markPendingMigrationRequired(target, migrations);
    const manifest = JSON.parse(
      await readFile(path.join(target, ".assistant", "manifest.json"), "utf8")
    );
    assert.equal(manifest.initialization_status, "awaiting_user_input");
    const current = parseNodeDocument(
      await readFile(path.join(target, ".assistant", "CURRENT.md"), "utf8")
    );
    assert.equal(current.metadata.initialization_status, "awaiting_user_input");
    assert.match(current.body, /agents_control_plane/);
    assert.equal((await doctorProject(target, { probeSandbox: false })).status, "blocked");

    await assert.rejects(
      completeAgentsControlPlaneMigration(target, { confirmed: true }),
      /still contains competing assistant control paths/
    );
    const activePath = path.join(target, "AGENTS.md");
    const active = await readFile(activePath, "utf8");
    await writeFile(
      activePath,
      active.replace(
        "Read `docs/agent/INDEX.md` and `docs/agent/CURRENT.md` before work.\n",
        ""
      ),
      "utf8"
    );
    const completed = await completeAgentsControlPlaneMigration(target, {
      confirmed: true
    });
    assert.equal(completed.status, "completed");
    assert.equal((await inspectPendingMigrations(target)).pending.length, 0);
    assert.match(await readFile(activePath, "utf8"), /Run local tests/);
    assert.match(await readFile(activePath, "utf8"), /assistant-managed:start/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("explicit initialization source is imported with durable authority context", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "assistant-source-init-"));
  const target = path.join(tempRoot, "new project");
  const source = path.join(tempRoot, "initial plan.md");
  try {
    await writeFile(source, "# Approved initial direction\n", "utf8");
    const result = await initializeProject(target, { sources: [source] });
    assert.equal(result.mode, "existing");
    assert.equal(result.initialization_status, "bootstrap_incomplete");
    const imported = path.join(
      target,
      "docs",
      "user",
      "bootstrap-source",
      "initial plan.md"
    );
    assert.equal(await readFile(imported, "utf8"), "# Approved initial direction\n");
    const authority = JSON.parse(
      await readFile(
        path.join(
          target,
          ".assistant",
          "internal",
          "bootstrap",
          "source-authority.json"
        ),
        "utf8"
      )
    );
    assert.equal(authority.authority, "current_user_instruction");
    assert.deepEqual(authority.imported_paths, [
      "docs/user/bootstrap-source/initial plan.md"
    ]);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("in-project initialization source becomes a dynamic restricted boundary", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "assistant-dynamic-source-"));
  const target = path.join(tempRoot, "legacy project");
  const source = path.join(
    target,
    "docs",
    "user_report",
    "approved direction.md"
  );
  try {
    await mkdir(path.dirname(source), { recursive: true });
    await writeFile(source, "# Exact approved direction\n", "utf8");
    await writeFile(path.join(target, "README.md"), "# Legacy project\n", "utf8");

    await initializeProject(target, { sources: [source] });

    const registry = JSON.parse(
      await readFile(
        path.join(
          target,
          ".assistant",
          "internal",
          "restricted",
          "boundaries.json"
        ),
        "utf8"
      )
    );
    assert.deepEqual(registry.boundaries, [
      {
        relative: "docs/user_report/approved direction.md",
        kind: "source",
        boundary_kind: "file",
        reason: "explicit_initialization_source"
      }
    ]);

    const config = await readFile(
      path.join(target, ".codex", "config.toml"),
      "utf8"
    );
    assert.match(
      config,
      /"docs\/user_report\/approved direction\.md" = "deny"/
    );
    assert.doesNotMatch(config, /\{\{[A-Z_]+\}\}/);

    const output = await runHook(target, `이 파일만 읽어: "${source}"`);
    const context = JSON.parse(output.hookSpecificOutput.additionalContext);
    assert.equal(context.grants.length, 1);
    const [response] = await callGateway(target, [
      {
        name: "source_read_file",
        arguments: {
          grant_token: context.grants[0].token,
          path: source
        }
      }
    ]);
    assert.match(response.result.content[0].text, /Exact approved direction/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("failed deterministic initialization removes only imported bootstrap source", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "assistant-source-rollback-"));
  const target = path.join(tempRoot, "existing project");
  const source = path.join(tempRoot, "initial plan.md");
  try {
    await mkdir(path.join(target, ".assistant"), { recursive: true });
    await writeFile(path.join(target, "keep.txt"), "preserve\n", "utf8");
    await writeFile(source, "# Approved initial direction\n", "utf8");
    await assert.rejects(
      initializeProject(target, { sources: [source] }),
      /already initialized|reserved path conflict/
    );
    await assert.rejects(
      readFile(
        path.join(
          target,
          "docs",
          "user",
          "bootstrap-source",
          "initial plan.md"
        ),
        "utf8"
      ),
      /ENOENT/
    );
    assert.equal(await readFile(path.join(target, "keep.txt"), "utf8"), "preserve\n");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("initialization preflight prunes dependencies and gates large semantic input", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "assistant-preflight-"));
  try {
    await mkdir(path.join(tempRoot, "node_modules", "pkg", "deep"), {
      recursive: true
    });
    await writeFile(
      path.join(tempRoot, "node_modules", "pkg", "deep", "ignored.js"),
      "generated dependency\n",
      "utf8"
    );
    await mkdir(path.join(tempRoot, "submodules", "vendored-lib"), {
      recursive: true
    });
    await writeFile(
      path.join(tempRoot, "submodules", "vendored-lib", "ignored.cpp"),
      "vendored dependency\n",
      "utf8"
    );
    await writeFile(path.join(tempRoot, "README.md"), "Meaningful project text.\n", "utf8");
    const result = await preflightInitialization(tempRoot, {
      limits: {
        paths: 100,
        semanticFiles: 100,
        packetBytes: 1,
        sourceBytes: 100
      }
    });
    assert.equal(result.status, "confirmation_required");
    assert.equal(result.project.semantic_candidate_files, 1);
    assert.ok(result.project.paths <= 3);
    assert.ok(
      result.reasons.some(
        (reason) => reason.metric === "projected_packet_bytes"
      )
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("initialization rejects source input that cannot fit the loss-aware budget before mutation", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "assistant-source-size-"));
  const target = path.join(tempRoot, "target");
  const source = path.join(tempRoot, "large-plan.md");
  try {
    await writeFile(source, "x".repeat(101), "utf8");
    const result = await preflightInitialization(target, {
      sources: [source],
      limits: {
        paths: 100,
        semanticFiles: 100,
        packetBytes: 1_000_000,
        sourceBytes: 100
      }
    });
    assert.equal(result.status, "unsupported_source_size");
    assert.equal(result.blocking_reasons[0].metric, "explicit_source_bytes");
    assert.equal(await import("node:fs").then(({ existsSync }) => existsSync(target)), false);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("bootstrap prompt distinguishes missing bundled assets from material authority conflicts", async () => {
  const prompt = await readFile(
    path.resolve(
      "runtime",
      "prompts",
      "bootstrap-existing-v1.md"
    ),
    "utf8"
  );
  assert.match(
    prompt,
    /asset, dependency, generated output, or example[\s\S]*workstream gap plus a nonmaterial ambiguity/
  );
  assert.match(
    prompt,
    /approved north star, scope, active plan, current state, authorization, Gate/
  );
});

test("bootstrap activation groups records and survives restricted source deletion", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "assistant-activate-"));
  const target = path.join(tempRoot, "project");
  try {
    await mkdir(path.join(target, "docs", "user"), { recursive: true });
    await writeFile(path.join(target, "README.md"), "Active work exists.\n", "utf8");
    await writeFile(
      path.join(target, "docs", "user", "legacy-plan.md"),
      "Historical rationale.\n",
      "utf8"
    );
    await initializeProject(target);
    const modelResult = {
      schema: "assistant.bootstrap-output/v1",
      project_summary: {
        purpose: "Test project",
        scope: "Bounded test",
        current_state: "Waiting for direction",
        current_authorization: "No execution authorization",
        next_safe_route: "Ask for direction"
      },
      candidate_nodes: [
        {
          id: "FND-TEST-001",
          type: "foundation",
          status: "active",
          authority: "candidate_unintegrated",
          certainty: "direct",
          relations: [],
          title: "Test foundation",
          body: "Rationale from docs/user/legacy-plan.md.",
          evidence_paths: ["docs/user/legacy-plan.md"],
          legacy_aliases: []
        },
        {
          id: "WORK-TEST-001",
          type: "work",
          status: "paused",
          authority: "candidate_unintegrated",
          certainty: "direct",
          relations: [
            { type: "depends_on", target: "FND-TEST-001" }
          ],
          title: "Test work",
          body: "Work is waiting.",
          evidence_paths: ["README.md"],
          legacy_aliases: []
        }
      ],
      coverage_groups: [],
      gaps: [
        {
          id: "GAP-NONCRITICAL-001",
          question: "Optional detail?",
          critical: false,
          blocking_level: "nonblocking",
          safe_unknown_state: true,
          unsafe_reason: null,
          reason: "Does not block work",
          affected_concerns: ["detail"]
        }
      ],
      conflicts: []
    };
    await writeFile(
      path.join(
        target,
        ".assistant",
        "internal",
        "bootstrap",
        "model-result.json"
      ),
      JSON.stringify(modelResult, null, 2),
      "utf8"
    );

    const completion = await finalizeInstalledProject(target, {
      initializationStatus: "bootstrap_incomplete",
      probeSandbox: false
    });
    const activation = completion.activation;
    assert.equal(activation.status, "ready_with_gaps");
    assert.equal(activation.semantic_records, 2);
    assert.equal(activation.canonical_documents, 2);
    assert.equal(activation.validation.valid, true);
    assert.equal(completion.initialization_status, "ready_with_gaps");
    assert.equal(completion.readiness, "ready_with_gaps");
    assert.equal(completion.structure.applied, false);
    assert.equal(completion.doctor.status, "ready");
    const replay = await activateBootstrap(target);
    assert.equal(replay.idempotent, true);
    assert.equal(replay.reconciled, true);
    assert.equal(replay.transaction_id, activation.transaction_id);

    const foundationPath = path.join(
      target,
      ".assistant",
      "knowledge",
      "FOUNDATION.md"
    );
    const foundation = await readFile(foundationPath, "utf8");
    assert.doesNotMatch(foundation, /docs\/user\/legacy-plan\.md/);
    assert.match(foundation, /snapshot:sha256:/);

    await rm(path.join(target, "docs", "user", "legacy-plan.md"));
    const validation = await validateProject(target);
    assert.equal(validation.valid, true);
    if (process.platform === "win32") {
      const attributes = await new Promise((resolve, reject) => {
        const child = spawn("attrib.exe", [path.join(target, ".assistant")], {
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"]
        });
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk) => { stdout += chunk; });
        child.stderr.on("data", (chunk) => { stderr += chunk; });
        child.once("error", reject);
        child.once("close", (code) => {
          if (code === 0) resolve(stdout);
          else reject(new Error(stderr));
        });
      });
      assert.match(attributes, /H[^\r\n]*\.assistant/iu);
    }

    const loaded = await loadCanonicalNodes(target);
    const route = routeTask(loaded.nodes, "project_orientation");
    assert.ok(route.required.some((item) => item.id === "FND-TEST-001"));
    assert.ok(route.required.some((item) => item.id === "WORK-TEST-001") === false);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("bootstrap activation routes methodology and authorization by project profile", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "assistant-profile-route-"));
  async function prepare(target, profile, withAuthorization = false) {
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, "README.md"), "A project exists.\n", "utf8");
    await initializeProject(target);
    const manifestPath = path.join(target, ".assistant", "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.profile = profile;
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await writeFile(
      path.join(target, ".assistant", "internal", "bootstrap", "model-result.json"),
      `${JSON.stringify({
        schema: "assistant.bootstrap-output/v1",
        project_summary: {
          purpose: "Profile routing test",
          scope: "Methodology",
          current_state: "Waiting",
          current_authorization: "None",
          ...(withAuthorization
            ? {
                authorization_state: "active",
                authorized_work: ["Freeze the approved protocol"],
                blocked_work: ["Run the experiment before protocol freeze"],
                authorization_basis_paths: ["README.md"]
              }
            : {}),
          next_safe_route: "Await direction"
        },
        candidate_nodes: [
          {
            id: "REQ-PROFILE-001",
            type: "requirement",
            status: "active",
            authority: "candidate_unintegrated",
            certainty: "direct",
            relations: [],
            title: "Evidence requirement",
            body: "Evidence must be auditable.",
            evidence_paths: ["README.md"],
            legacy_aliases: []
          },
          {
            id: "DESIGN-PROFILE-001",
            type: "design",
            status: "active",
            authority: "candidate_unintegrated",
            certainty: "direct",
            relations: [
              { type: "depends_on", target: "REQ-PROFILE-001" }
            ],
            title: "Method design",
            body: "Use controlled comparisons.",
            evidence_paths: ["README.md"],
            legacy_aliases: []
          }
        ],
        coverage_groups: [],
        gaps: [],
        conflicts: []
      }, null, 2)}\n`,
      "utf8"
    );
  }

  try {
    const researchTarget = path.join(tempRoot, "research");
    await prepare(researchTarget, "research", true);
    const researchResult = await activateBootstrap(researchTarget);
    assert.equal(researchResult.validation.valid, true);
    assert.equal(
      await pathExists(
        path.join(
          researchTarget,
          ".assistant",
          "knowledge",
          "research",
          "METHODOLOGY.md"
        )
      ),
      true
    );
    assert.equal(
      await pathExists(
        path.join(
          researchTarget,
          ".assistant",
          "knowledge",
          "software",
          "ARCHITECTURE.md"
        )
      ),
      false
    );
    const researchCurrent = parseNodeDocument(
      await readFile(
        path.join(researchTarget, ".assistant", "CURRENT.md"),
        "utf8"
      )
    );
    assert.equal(researchCurrent.metadata.authorization, "active");
    assert.match(researchCurrent.body, /Freeze the approved protocol/);
    assert.match(researchCurrent.body, /Run the experiment before protocol freeze/);

    const softwareTarget = path.join(tempRoot, "software");
    await prepare(softwareTarget, "software");
    const softwareResult = await activateBootstrap(softwareTarget);
    assert.equal(softwareResult.validation.valid, true);
    const softwareCurrent = parseNodeDocument(
      await readFile(
        path.join(softwareTarget, ".assistant", "CURRENT.md"),
        "utf8"
      )
    );
    assert.equal(softwareCurrent.metadata.authorization, "not_authorized");
    assert.equal(
      await pathExists(
        path.join(
          softwareTarget,
          ".assistant",
          "knowledge",
          "software",
          "ARCHITECTURE.md"
        )
      ),
      true
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("bootstrap activation rolls back an interrupted applying journal before retry", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "assistant-activation-recover-"));
  const target = path.join(tempRoot, "project");
  try {
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, "README.md"), "A project exists.\n", "utf8");
    await initializeProject(target);
    await writeFile(
      path.join(target, ".assistant", "internal", "bootstrap", "model-result.json"),
      `${JSON.stringify({
        schema: "assistant.bootstrap-output/v1",
        project_summary: {
          purpose: "Recovery test",
          scope: "Activation",
          current_state: "Waiting",
          current_authorization: "None",
          next_safe_route: "Await direction"
        },
        candidate_nodes: [
          {
            id: "FND-RECOVERY-001",
            type: "foundation",
            status: "active",
            authority: "candidate_unintegrated",
            certainty: "direct",
            relations: [],
            title: "Recovery foundation",
            body: "Recover before retry.",
            evidence_paths: ["README.md"],
            legacy_aliases: []
          }
        ],
        coverage_groups: [],
        gaps: [],
        conflicts: []
      }, null, 2)}\n`,
      "utf8"
    );

    const transactionId = "TXN-INTERRUPTED-TEST";
    const transactionRoot = path.join(
      target,
      ".assistant",
      "internal",
      "transactions",
      transactionId
    );
    const backupSpecs = [
      ["manifest.json", ".assistant/manifest.json"],
      ["CURRENT.md", ".assistant/CURRENT.md"],
      ["INDEX.md", ".assistant/INDEX.md"],
      [
        "validated-hashes.json",
        ".assistant/internal/validated-hashes.json"
      ],
      [
        "bootstrap-state.json",
        ".assistant/internal/bootstrap/state.json"
      ]
    ];
    for (const [name, relative] of backupSpecs) {
      const source = path.join(target, ...relative.split("/"));
      await writeUtf8(
        path.join(transactionRoot, "backup", name),
        await readFile(source, "utf8")
      );
    }
    const partialPath = path.join(
      target,
      ".assistant",
      "knowledge",
      "FOUNDATION.md"
    );
    await writeUtf8(partialPath, "partial activation\n");
    await writeFile(
      path.join(target, ".assistant", "CURRENT.md"),
      "interrupted current\n",
      "utf8"
    );
    await writeUtf8(
      path.join(transactionRoot, "record.json"),
      `${JSON.stringify({
        schema: "assistant.transaction/v1",
        id: transactionId,
        type: "bootstrap_activation",
        status: "applying",
        profile: "research",
        planned_paths: [".assistant/knowledge/FOUNDATION.md"],
        backups: backupSpecs.map(([name, targetPath]) => ({
          target: targetPath,
          backup: `backup/${name}`
        })),
        started_at: "2026-01-01T00:00:00.000Z"
      }, null, 2)}\n`
    );

    const result = await activateBootstrap(target);
    assert.equal(result.validation.valid, true);
    assert.deepEqual(result.recovered_transactions, [transactionId]);
    assert.match(await readFile(partialPath, "utf8"), /Recovery foundation/);
    const interruptedRecord = JSON.parse(
      await readFile(path.join(transactionRoot, "record.json"), "utf8")
    );
    assert.equal(interruptedRecord.status, "rolled_back");
    assert.equal(interruptedRecord.recovery, "startup_recovery");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("bootstrap activation pre-splits oversized collections before canonical commit", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "assistant-activate-split-"));
  const target = path.join(tempRoot, "project");
  try {
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, "README.md"), "Large software project.\n", "utf8");
    await initializeProject(target);
    const candidates = [
      {
        id: "FND-SPLIT-001",
        type: "foundation",
        status: "active",
        authority: "candidate_unintegrated",
        certainty: "direct",
        relations: [],
        title: "Split-test foundation",
        body: "Stable project purpose.",
        semantic_sections: [],
        evidence_paths: ["README.md"],
        legacy_aliases: []
      }
    ];
    for (let index = 0; index < 6; index += 1) {
      candidates.push({
        id: `DES-SPLIT-${String(index + 1).padStart(3, "0")}`,
        type: "design",
        status: "implemented",
        authority: "candidate_unintegrated",
        certainty: "direct",
        relations: [
          { type: "depends_on", target: "FND-SPLIT-001" }
        ],
        title: `Independent design ${index + 1}`,
        body: `Independent lifecycle design ${index + 1}.\n${"bounded detail ".repeat(360)}`,
        semantic_sections: [],
        evidence_paths: ["README.md"],
        legacy_aliases: []
      });
    }
    const modelResult = {
      schema: "assistant.bootstrap-output/v1",
      project_summary: {
        purpose: "Split oversized owners",
        scope: "Synthetic activation",
        current_state: "Idle",
        current_authorization: "No execution authorization",
        next_safe_route: "Await direction"
      },
      candidate_nodes: candidates,
      coverage_groups: [],
      gaps: [],
      conflicts: []
    };
    await writeFile(
      path.join(
        target,
        ".assistant",
        "internal",
        "bootstrap",
        "model-result.json"
      ),
      `${JSON.stringify(modelResult, null, 2)}\n`,
      "utf8"
    );
    const completion = await finalizeInstalledProject(target, {
      initializationStatus: "bootstrap_incomplete",
      probeSandbox: false
    });
    assert.equal(completion.validation.valid, true);
    assert.ok(completion.activation.canonical_documents > 2);
    assert.ok(
      completion.validation.nodes.every((node) => node.bytes <= 24 * 1024)
    );
    const loaded = await loadCanonicalNodes(target);
    const ids = new Set(
      loaded.nodes.flatMap((node) =>
        node.metadata.records?.map((record) => record.id) ?? [node.metadata.id]
      )
    );
    for (const candidate of candidates) assert.ok(ids.has(candidate.id));
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("bootstrap resolution requires whole conflict confirmation and then activates", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "assistant-bootstrap-resolve-"));
  const target = path.join(tempRoot, "project");
  try {
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, "README.md"), "Legacy direction.\n", "utf8");
    await initializeProject(target);
    const bootstrapRoot = path.join(
      target,
      ".assistant",
      "internal",
      "bootstrap"
    );
    const base = {
      schema: "assistant.bootstrap-output/v1",
      project_summary: {
        purpose: "Resolve a legacy direction",
        scope: "Test scope",
        current_state: "Conflicting directions",
        current_authorization: "Bootstrap resolution only",
        next_safe_route: "Resolve the direction conflict"
      },
      candidate_nodes: [
        {
          id: "FND-RESOLVE-001",
          type: "foundation",
          status: "proposed",
          authority: "candidate_unintegrated",
          certainty: "direct",
          relations: [],
          title: "Candidate foundation",
          body: "Legacy direction.",
          semantic_sections: [],
          evidence_paths: ["README.md"],
          legacy_aliases: []
        }
      ],
      coverage_groups: [
        {
          selector_kind: "exact_path",
          selector: "README.md",
          disposition: "preserved",
          reason: "Project direction evidence"
        }
      ],
      gaps: [],
      conflicts: [
        {
          id: "CONFLICT-DIRECTION-001",
          material: true,
          concern: "scope",
          left: "Legacy direction",
          right: "Approved replacement",
          left_conditions: "Legacy approved project scope",
          right_conditions: "New proposed project scope",
          reconcilability: "unresolved_material",
          why_not_conditionable:
            "Only one scope can govern the active project at a time.",
          evidence_paths: ["README.md"],
          decision_needed: "Choose the active direction"
        }
      ]
    };
    await writeFile(
      path.join(bootstrapRoot, "model-result.json"),
      `${JSON.stringify(base, null, 2)}\n`,
      "utf8"
    );
    const statePath = path.join(bootstrapRoot, "state.json");
    const state = JSON.parse(await readFile(statePath, "utf8"));
    state.status = "awaiting_user_input";
    await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");

    const resolvedOutput = {
      ...base,
      project_summary: {
        ...base.project_summary,
        current_state: "Approved replacement direction",
        next_safe_route: "Await the first project instruction"
      },
      candidate_nodes: [
        {
          ...base.candidate_nodes[0],
          status: "active",
          authority: "canonical_user_approved",
          body: "Approved replacement direction."
        },
        {
          id: "DEC-BOOT-001",
          type: "decision",
          status: "accepted",
          authority: "canonical_user_approved",
          certainty: "direct",
          relations: [],
          title: "Replace the legacy direction",
          body: "The user approved the replacement during bootstrap.",
          semantic_sections: [],
          evidence_paths: ["README.md"],
          legacy_aliases: []
        }
      ],
      conflicts: []
    };
    const resolution = {
      schema: "assistant.bootstrap-resolution/v1",
      decisions: [
        {
          id: "CONFLICT-DIRECTION-001",
          kind: "conflict",
          decision: "Use the approved replacement direction",
          rationale: "Explicit user bootstrap decision",
          affected_candidate_ids: ["FND-RESOLVE-001", "DEC-BOOT-001"],
          canonical_decision_id: "DEC-BOOT-001"
        }
      ],
      resolved_output: resolvedOutput
    };

    await assert.rejects(
      resolveBootstrap(target, resolution, {
        confirmed: false,
        probeSandbox: false
      }),
      /explicit confirmation/
    );
    const result = await resolveBootstrap(target, resolution, {
      confirmed: true,
      probeSandbox: false
    });
    assert.equal(result.status, "committed");
    assert.equal(result.completion.initialization_status, "ready");
    assert.equal(result.completion.readiness, "ready");
    const validation = await validateProject(target);
    assert.equal(validation.valid, true);
    assert.match(
      await readFile(
        path.join(target, ".assistant", "knowledge", "decisions", "DECISIONS.md"),
        "utf8"
      ),
      /DEC-BOOT-001/
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("bootstrap hook durably defers the first request and claim completion is resumable", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "assistant-bootstrap-deferred-"));
  const target = path.join(tempRoot, "project");
  try {
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, "README.md"), "Existing project.\n", "utf8");
    await initializeProject(target);
    const statePath = path.join(
      target,
      ".assistant",
      "internal",
      "bootstrap",
      "state.json"
    );
    const state = JSON.parse(await readFile(statePath, "utf8"));
    state.status = "awaiting_user_input";
    await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");

    const firstPrompt = "원래 요청을 초기화 뒤 이어서 수행해줘.";
    const hook = await runHook(target, firstPrompt);
    const context = JSON.parse(hook.hookSpecificOutput.additionalContext);
    assert.equal(context.deferred_request.status, "pending");
    await runHook(target, "초기화 질문에 대한 두 번째 답변");
    const pending = await inspectDeferredRequest(target);
    assert.equal(pending.prompt, firstPrompt);
    assert.equal(pending.status, "pending");

    const claimed = await claimDeferredRequest(target);
    assert.equal(claimed.status, "in_progress");
    assert.equal(claimed.prompt, firstPrompt);
    const reclaimed = await claimDeferredRequest(target);
    assert.equal(reclaimed.prompt, firstPrompt);
    const completed = await completeDeferredRequest(target);
    assert.equal(completed.status, "completed");
    assert.equal("prompt" in completed, false);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("semantic bootstrap retry archives the prior attempt and restores resumable state", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "assistant-bootstrap-retry-"));
  const target = path.join(tempRoot, "project");
  try {
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, "README.md"), "Existing project.\n", "utf8");
    await initializeProject(target);
    const bootstrapRoot = path.join(
      target,
      ".assistant",
      "internal",
      "bootstrap"
    );
    await writeFile(
      path.join(bootstrapRoot, "model-result.json"),
      '{"schema":"assistant.bootstrap-output/v1"}\n',
      "utf8"
    );
    await mkdir(path.join(bootstrapRoot, "staging"), { recursive: true });
    await writeFile(path.join(bootstrapRoot, "staging", "old.md"), "old\n", "utf8");
    const statePath = path.join(bootstrapRoot, "state.json");
    const state = JSON.parse(await readFile(statePath, "utf8"));
    state.status = "awaiting_user_input";
    state.semantic_survey_complete = true;
    await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");

    const retry = await prepareBootstrapRetry(
      target,
      "contract version changed"
    );
    assert.equal(retry.status, "prepared");
    const after = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(after.status, "bootstrap_incomplete");
    assert.equal(after.semantic_survey_complete, false);
    assert.equal(
      await readFile(
        path.join(
          bootstrapRoot,
          "attempts",
          retry.attempt_id,
          "staging",
          "old.md"
        ),
        "utf8"
      ),
      "old\n"
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("existing Codex config is staged instead of overwritten", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "assistant-config-"));
  const target = path.join(tempRoot, "project");
  try {
    await mkdir(path.join(target, ".codex"), { recursive: true });
    const original = 'model = "user-choice"\n';
    await writeFile(
      path.join(target, ".codex", "config.toml"),
      original,
      "utf8"
    );
    const result = await initializeProject(target);
    assert.equal(result.changes.codex_config, "staged");
    assert.equal(
      await readFile(path.join(target, ".codex", "config.toml"), "utf8"),
      original
    );
    assert.match(
      await readFile(path.join(
        target,
        ".assistant",
        "internal",
        "pending",
        "assistant-config.toml"
      ), "utf8"),
      /assistant_project/
    );
    const pending = await readFile(
      path.join(
        target,
        ".assistant",
        "internal",
        "pending",
        "assistant-config.toml"
      ),
      "utf8"
    );
    assert.doesNotMatch(pending, /\{\{[A-Z_]+\}\}/);
    assert.equal((await inspectPendingMigrations(target)).pending.length, 1);
    await assert.rejects(
      completeCodexConfigMigration(target, { confirmed: true }),
      /does not contain the staged security contract/
    );
    await writeFile(
      path.join(target, ".codex", "config.toml"),
      `${original}\n${pending}`,
      "utf8"
    );
    const migration = await completeCodexConfigMigration(target, {
      confirmed: true
    });
    assert.equal(migration.status, "completed");
    assert.equal((await inspectPendingMigrations(target)).pending.length, 0);
    assert.equal(
      await readFile(
        path.join(
          target,
          ".assistant",
          "internal",
          "backup",
          ".codex",
          "config.toml"
        ),
        "utf8"
      ),
      original
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("bootstrap coverage validator accounts every inventory entry", () => {
  const inventory = {
    entries: [
      { path: "README.md", category: "document" },
      { path: "src/main.js", category: "code" },
      { path: "node_modules", category: "directory" }
    ]
  };
  const output = {
    schema: "assistant.bootstrap-output/v1",
    candidate_nodes: [],
    coverage_groups: [
      {
        selector_kind: "exact_path",
        selector: "README.md",
        disposition: "preserved",
        reason: "project description"
      },
      {
        selector_kind: "path_prefix",
        selector: "src",
        disposition: "consolidated",
        reason: "code observation"
      },
      {
        selector_kind: "inventory_category",
        selector: "directory",
        disposition: "nonsemantic_inventory_only",
        reason: "container path"
      }
    ]
  };
  assert.deepEqual(validateBootstrapOutput(output, inventory), []);
  output.coverage_groups.pop();
  assert.match(
    validateBootstrapOutput(output, inventory)[0],
    /coverage misses 1 paths/
  );
  const unsafeAuthorization = {
    schema: "assistant.bootstrap-output/v1",
    project_summary: {
      authorization_state: "active",
      authorized_work: [],
      blocked_work: [],
      authorization_basis_paths: []
    },
    candidate_nodes: [],
    coverage_groups: []
  };
  assert.ok(
    validateBootstrapOutput(unsafeAuthorization, { entries: [] }).some(
      (item) => /active bootstrap authorization requires/.test(item)
    )
  );
});

test("bootstrap research candidates require complete semantic sections and relation direction", () => {
  const section = (heading) => ({ heading, content: "Unknown — fixture." });
  const output = {
    schema: "assistant.bootstrap-output/v1",
    candidate_nodes: [
      {
        id: "RQ-BOOT-001",
        type: "question",
        certainty: "direct",
        relations: [],
        semantic_sections: RESEARCH_WORKFLOW_HEADINGS.question.map(section)
      },
      {
        id: "HYP-BOOT-001",
        type: "hypothesis",
        certainty: "direct",
        relations: [{ type: "tests", target: "RQ-BOOT-001" }],
        semantic_sections: RESEARCH_WORKFLOW_HEADINGS.hypothesis.map(section)
      },
      {
        id: "DESIGN-BOOT-001",
        type: "design",
        certainty: "direct",
        relations: [],
        semantic_sections: []
      },
      {
        id: "EVIDENCE-BOOT-001",
        type: "evidence",
        certainty: "direct",
        relations: [{ type: "derived_from", target: "DESIGN-BOOT-001" }],
        semantic_sections: RESEARCH_WORKFLOW_HEADINGS.evidence.map(section)
      }
    ],
    coverage_groups: []
  };
  let findings = validateBootstrapOutput(output, { entries: [] });
  assert.ok(findings.some((item) => /no valid hypothesis parent relation/.test(item)));
  output.candidate_nodes[1].relations = [
    { type: "depends_on", target: "RQ-BOOT-001" }
  ];
  findings = validateBootstrapOutput(output, { entries: [] });
  assert.deepEqual(findings, []);
});

test("bootstrap software candidates require lifecycle fields and forward relation direction", () => {
  const section = (heading) => ({ heading, content: "Unknown — fixture." });
  const candidates = [
    {
      id: "FND-SW-BOOT",
      type: "foundation",
      certainty: "direct",
      relations: [],
      semantic_sections: []
    },
    {
      id: "REQ-SW-BOOT",
      type: "requirement",
      certainty: "direct",
      relations: [{ type: "derived_from", target: "FND-SW-BOOT" }],
      semantic_sections: SOFTWARE_WORKFLOW_HEADINGS.requirement.map(section)
    },
    {
      id: "DESIGN-SW-BOOT",
      type: "design",
      certainty: "direct",
      relations: [{ type: "implements", target: "REQ-SW-BOOT" }],
      semantic_sections: SOFTWARE_WORKFLOW_HEADINGS.design.map(section)
    },
    {
      id: "TASK-SW-BOOT",
      type: "task",
      certainty: "direct",
      relations: [{ type: "implements", target: "DESIGN-SW-BOOT" }],
      semantic_sections: SOFTWARE_WORKFLOW_HEADINGS.task.map(section)
    },
    {
      id: "TEST-SW-BOOT",
      type: "test",
      certainty: "direct",
      relations: [{ type: "verifies", target: "TASK-SW-BOOT" }],
      semantic_sections: SOFTWARE_WORKFLOW_HEADINGS.test.map(section)
    },
    {
      id: "ISSUE-SW-BOOT",
      type: "issue",
      certainty: "direct",
      relations: [{ type: "challenges", target: "DESIGN-SW-BOOT" }],
      semantic_sections: SOFTWARE_WORKFLOW_HEADINGS.issue.map(section)
    },
    {
      id: "RELEASE-SW-BOOT",
      type: "release",
      certainty: "direct",
      relations: [{ type: "depends_on", target: "TEST-SW-BOOT" }],
      semantic_sections: SOFTWARE_WORKFLOW_HEADINGS.release.map(section)
    }
  ];
  const output = {
    schema: "assistant.bootstrap-output/v1",
    candidate_nodes: candidates,
    coverage_groups: []
  };
  assert.deepEqual(
    validateBootstrapOutput(output, { entries: [] }, {
      profile: "software"
    }),
    []
  );

  candidates[1].relations = [{ type: "verifies", target: "TEST-SW-BOOT" }];
  const reverseFindings = validateBootstrapOutput(
    output,
    { entries: [] },
    { profile: "software" }
  );
  assert.ok(
    reverseFindings.some((item) =>
      /REQ-SW-BOOT cannot use verifies as a requirement/.test(item)
    )
  );
  assert.ok(
    reverseFindings.some((item) =>
      /REQ-SW-BOOT has no valid requirement parent relation/.test(item)
    )
  );
});

test("bootstrap repair may fix structure but cannot rewrite semantic meaning", () => {
  const before = {
    project_summary: { purpose: "Stable meaning" },
    candidate_nodes: [
      {
        id: "NODE-REPAIR-001",
        type: "foundation",
        body: "Preserve this exactly.",
        relations: [{ type: "routes_to", target: "GAP-NOT-A-NODE" }]
      }
    ],
    gaps: [],
    conflicts: [],
    coverage_groups: []
  };
  const repaired = structuredClone(before);
  repaired.candidate_nodes[0].relations = [];
  assert.deepEqual(
    validateBootstrapRepair(
      before,
      repaired,
      ["NODE-REPAIR-001 targets missing candidate GAP-NOT-A-NODE"]
    ),
    []
  );
  repaired.candidate_nodes[0].body = "Rewritten meaning.";
  assert.match(
    validateBootstrapRepair(
      before,
      repaired,
      ["NODE-REPAIR-001 targets missing candidate GAP-NOT-A-NODE"]
    )[0],
    /semantic candidate content/
  );
});

test("deterministic bootstrap repair changes only relations proven by reciprocal structure", () => {
  const output = {
    candidate_nodes: [
      {
        id: "RQ-DET-001",
        type: "question",
        relations: []
      },
      {
        id: "HYP-DET-001",
        type: "hypothesis",
        relations: [{ type: "tests", target: "RQ-DET-001" }]
      },
      {
        id: "EXP-DET-001",
        type: "experiment",
        relations: [{ type: "tests", target: "HYP-DET-001" }]
      },
      {
        id: "EVD-DET-001",
        type: "evidence",
        relations: [{ type: "produces", target: "EXP-DET-002" }]
      },
      {
        id: "EXP-DET-002",
        type: "experiment",
        relations: [{ type: "depends_on", target: "EVD-DET-001" }]
      }
    ]
  };
  const repaired = repairDeterministicBootstrapRelations(output, [
    "HYP-DET-001 cannot use tests as a hypothesis"
  ]);
  assert.equal(repaired.changes.length, 1);
  assert.deepEqual(repaired.output.candidate_nodes[1].relations, [
    { type: "depends_on", target: "RQ-DET-001" }
  ]);
  assert.deepEqual(output.candidate_nodes[1].relations, [
    { type: "tests", target: "RQ-DET-001" }
  ]);

  const duplicateCounterpart = structuredClone(output);
  duplicateCounterpart.candidate_nodes[1].relations.unshift({
    type: "depends_on",
    target: "RQ-DET-001"
  });
  assert.deepEqual(
    repairDeterministicBootstrapRelations(duplicateCounterpart, [
      "HYP-DET-001 cannot use tests as a hypothesis"
    ]).output.candidate_nodes[1].relations,
    [{ type: "depends_on", target: "RQ-DET-001" }]
  );
  const duplicateOutput = structuredClone(output);
  duplicateOutput.candidate_nodes[2].relations.push({
    type: "tests",
    target: "HYP-DET-001"
  });
  assert.ok(
    validateBootstrapOutput(duplicateOutput, { entries: [] }).some((item) =>
      /duplicate relation tests -> HYP-DET-001/.test(item)
    )
  );

  const reciprocalExperiment = structuredClone(output);
  reciprocalExperiment.candidate_nodes[1].relations = [
    { type: "tests", target: "EXP-DET-001" }
  ];
  const reciprocalRepair = repairDeterministicBootstrapRelations(
    reciprocalExperiment,
    [
      "HYP-DET-001 cannot use tests as a hypothesis"
    ]
  );
  assert.equal(reciprocalRepair.changes.length, 1);
  assert.deepEqual(reciprocalRepair.output.candidate_nodes[1].relations, []);

  const counterCase = structuredClone(reciprocalExperiment);
  counterCase.candidate_nodes[2].relations = [];
  assert.equal(
    repairDeterministicBootstrapRelations(counterCase, [
      "HYP-DET-001 cannot use tests as a hypothesis"
    ]).changes.length,
    0
  );

  const evidenceRepair = repairDeterministicBootstrapRelations(output, [
    "EVD-DET-001 cannot use produces as a evidence"
  ]);
  assert.equal(evidenceRepair.changes.length, 1);
  assert.deepEqual(evidenceRepair.output.candidate_nodes[3].relations, [
    { type: "precedes", target: "EXP-DET-002" }
  ]);
  const evidenceCounterCase = structuredClone(output);
  evidenceCounterCase.candidate_nodes[4].relations = [];
  assert.equal(
    repairDeterministicBootstrapRelations(evidenceCounterCase, [
      "EVD-DET-001 cannot use produces as a evidence"
    ]).changes.length,
    0
  );
  assert.ok(
    validateBootstrapOutput(output, { entries: [] }).some((item) =>
      /EVD-DET-001 cannot use produces as a evidence/.test(item)
    )
  );
});

test("Codex discovery avoids blocked PowerShell shims", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "assistant-codex-path-"));
  const originalPath = process.env.PATH;
  try {
    if (process.platform === "win32") {
      await writeFile(path.join(tempRoot, "codex.ps1"), "exit 1\n", "utf8");
      await writeFile(path.join(tempRoot, "codex.exe"), "", "utf8");
    } else {
      await writeFile(path.join(tempRoot, "codex"), "", { mode: 0o755 });
    }
    process.env.PATH = tempRoot;
    const invocation = await discoverCodexInvocation();
    assert.notEqual(path.extname(invocation.command).toLowerCase(), ".ps1");
    if (process.platform === "win32") {
      assert.equal(path.extname(invocation.command).toLowerCase(), ".exe");
      assert.equal(invocation.kind, "native");
    } else {
      assert.equal(invocation.kind, "path");
    }
  } finally {
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("evidence packet includes text but suppresses secret candidate values", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "assistant-packet-"));
  try {
    await writeFile(path.join(tempRoot, "README.md"), "visible evidence\n", "utf8");
    await writeFile(path.join(tempRoot, ".env"), "TOKEN=must-not-leak\n", "utf8");
    await writeFile(
      path.join(tempRoot, "metrics.csv"),
      "condition,score\ncontrol,1\nexperiment,3\n",
      "utf8"
    );
    await writeFile(
      path.join(tempRoot, "binary.docx"),
      Buffer.from([0, 255, 1, 254])
    );
    await mkdir(path.join(tempRoot, "model_cache", "tokenizer"), {
      recursive: true
    });
    await writeFile(
      path.join(tempRoot, "model_cache", "tokenizer", "vocab.json"),
      '{"must_not":"inline_cache_vocabulary"}\n',
      "utf8"
    );
    const inventory = {
      summary: { paths: 5, files: 5 },
      entries: [
        {
          path: "README.md",
          kind: "file",
          category: "document",
          size: 17,
          sha256: "readme"
        },
        {
          path: ".env",
          kind: "file",
          category: "secret_candidate",
          size: 20,
          sha256: "secret"
        },
        {
          path: "metrics.csv",
          kind: "file",
          category: "data",
          size: 39,
          sha256: "metrics"
        },
        {
          path: "binary.docx",
          kind: "file",
          category: "document",
          size: 4,
          sha256: "binary"
        },
        {
          path: "model_cache/tokenizer/vocab.json",
          kind: "file",
          category: "config",
          size: 39,
          sha256: "cache"
        }
      ]
    };
    const result = await buildEvidencePacket(tempRoot, inventory);
    assert.match(result.packet, /visible evidence/);
    assert.doesNotMatch(result.packet, /must-not-leak/);
    assert.match(result.packet, /secret-candidate-value-suppressed/);
    assert.match(result.packet, /deterministic-tabular-summary/);
    assert.match(result.packet, /"min": 1/);
    assert.match(result.packet, /binary-or-unsupported-semantic-format/);
    assert.doesNotMatch(result.packet, /inline_cache_vocabulary/);
    assert.match(result.packet, /cached-dependency-or-model-artifact/);
    assert.equal(result.metrics.transformed_files, 1);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("evidence packet collapses high-fanout artifacts without starving core source", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "assistant-bulk-packet-"));
  try {
    await mkdir(path.join(tempRoot, "backend"), { recursive: true });
    await mkdir(path.join(tempRoot, "artifacts", "test-reports"), {
      recursive: true
    });
    await writeFile(path.join(tempRoot, "README.md"), "core project purpose\n", "utf8");
    await writeFile(
      path.join(tempRoot, "backend", "main.ts"),
      "export function startService() { return 'core-source'; }\n",
      "utf8"
    );
    const entries = [
      {
        path: "README.md",
        kind: "file",
        category: "document",
        size: 21,
        sha256: "readme"
      },
      {
        path: "backend/main.ts",
        kind: "file",
        category: "code",
        size: 56,
        sha256: "core"
      }
    ];
    for (let index = 0; index < 205; index += 1) {
      const name =
        index === 0
          ? "acceptance-summary.json"
          : `run-${String(index).padStart(3, "0")}.json`;
      const relative = `artifacts/test-reports/${name}`;
      const content = `{"bulk_payload":"bulk-${index}"}\n`;
      await writeFile(path.join(tempRoot, ...relative.split("/")), content, "utf8");
      entries.push({
        path: relative,
        kind: "file",
        category: "config",
        size: Buffer.byteLength(content),
        sha256: `bulk-${index}`
      });
    }
    const result = await buildEvidencePacket(tempRoot, {
      summary: { paths: entries.length, files: entries.length },
      entries
    });
    assert.equal(result.metrics.collapsed_prefixes, 1);
    assert.equal(result.metrics.summarized_paths, 205);
    assert.match(result.packet, /COLLAPSED PREFIX: artifacts\/test-reports/);
    assert.match(result.packet, /"selector": "artifacts\/test-reports\/"/);
    assert.match(result.packet, /core project purpose/);
    assert.match(result.packet, /core-source/);
    assert.match(result.packet, /acceptance-summary\.json/);
    assert.ok(
      (result.packet.match(/bulk_payload/gu) ?? []).length <
        entries.length - 2
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("explicit source priority budget prevents ordinary documents from starving integration", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "assistant-source-priority-"));
  try {
    await mkdir(path.join(tempRoot, "docs", "user", "bootstrap-source"), {
      recursive: true
    });
    const entries = [];
    for (let index = 0; index < 8; index += 1) {
      const relative = `docs/ordinary-${index}.md`;
      const content = `${`ordinary-${index} `.repeat(10_000)}\n`;
      await mkdir(path.dirname(path.join(tempRoot, relative)), {
        recursive: true
      });
      await writeFile(path.join(tempRoot, relative), content, "utf8");
      entries.push({
        path: relative,
        kind: "file",
        category: "document",
        size: Buffer.byteLength(content),
        sha256: `ordinary-${index}`
      });
    }
    const sourcePath =
      "docs/user/bootstrap-source/approved-plan.md";
    const sourceContent =
      "# Approved plan\n\nSOURCE_PRIORITY_SENTINEL\n\nExact current direction.\n";
    await writeFile(
      path.join(tempRoot, ...sourcePath.split("/")),
      sourceContent,
      "utf8"
    );
    entries.push({
      path: sourcePath,
      kind: "file",
      category: "document",
      size: Buffer.byteLength(sourceContent),
      sha256: "approved"
    });
    const result = await buildEvidencePacket(
      tempRoot,
      {
        summary: { paths: entries.length, files: entries.length },
        entries
      },
      { priorityPaths: [sourcePath] }
    );
    assert.match(result.packet, /SOURCE_PRIORITY_SENTINEL/);
    assert.equal(result.metrics.priority_files, 1);
    assert.equal(result.metrics.priority_omitted_files, 0);
    assert.equal(
      result.metrics.priority_included_bytes,
      Buffer.byteLength(sourceContent)
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("rejected bootstrap recovery preserves explicit source priority semantics", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "assistant-recovery-priority-"));
  const target = path.join(tempRoot, "project");
  const source = path.join(tempRoot, "approved-plan.md");
  try {
    await writeFile(
      source,
      "# Approved plan\n\nRECOVERY_PRIORITY_SENTINEL\n",
      "utf8"
    );
    await initializeProject(target, { sources: [source] });
    const bootstrapRoot = path.join(
      target,
      ".assistant",
      "internal",
      "bootstrap"
    );
    const inventory = JSON.parse(
      await readFile(path.join(bootstrapRoot, "inventory.json"), "utf8")
    );
    const importedPath = "docs/user/bootstrap-source/approved-plan.md";
    const output = {
      schema: "assistant.bootstrap-output/v1",
      project_summary: {
        purpose: "Recovery priority test",
        scope: "Explicit source",
        current_state: "Waiting",
        current_authorization: "None",
        next_safe_route: "Await direction"
      },
      candidate_nodes: [
        {
          id: "FND-RECOVERY-PRIORITY-001",
          type: "foundation",
          status: "active",
          authority: "candidate_unintegrated",
          certainty: "direct",
          relations: [],
          title: "Approved foundation",
          body: "RECOVERY_PRIORITY_SENTINEL",
          evidence_paths: [importedPath],
          legacy_aliases: []
        }
      ],
      coverage_groups: inventory.entries.map((entry) => ({
        selector_kind: "exact_path",
        selector: entry.path,
        disposition: "preserved",
        reason: "Recovery fixture coverage"
      })),
      gaps: [],
      conflicts: []
    };
    assert.deepEqual(validateBootstrapOutput(output, inventory), []);
    const rejectionId = "REJ-00000000-0000-0000-0000-000000000001";
    const rejectionRoot = path.join(
      bootstrapRoot,
      "rejected",
      rejectionId
    );
    await mkdir(rejectionRoot, { recursive: true });
    await writeFile(
      path.join(rejectionRoot, "model-result.json"),
      `${JSON.stringify(output, null, 2)}\n`,
      "utf8"
    );
    await writeFile(
      path.join(rejectionRoot, "rejection.json"),
      `${JSON.stringify({
        schema: "assistant.bootstrap-rejection/v1",
        id: rejectionId,
        label: "test fixture",
        findings: [],
        execution: { tokens_used: 123 },
        rejected_at: "2026-01-01T00:00:00.000Z"
      }, null, 2)}\n`,
      "utf8"
    );

    const recovered = await recoverRejectedBootstrap(target, rejectionId);
    assert.equal(recovered.evidence_packet.priority_files, 1);
    assert.equal(recovered.evidence_packet.priority_omitted_files, 0);
    assert.equal(recovered.recovered_from, rejectionId);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("prompt grant and gateway enforce exact restricted boundaries", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "assistant-gateway-"));
  const target = path.join(tempRoot, "project with spaces");
  try {
    await initializeBlankProject(target);
    const allowed = path.join(target, "docs", "user", "지정 자료.md");
    const sibling = path.join(target, "docs", "user", "other.md");
    await writeFile(allowed, "allowed content\n", "utf8");
    await writeFile(sibling, "must remain hidden\n", "utf8");

    const output = await runHook(target, `이 파일만 읽어: "${allowed}"`);
    const context = JSON.parse(
      output.hookSpecificOutput.additionalContext
    );
    assert.equal(context.grants.length, 1);
    const token = context.grants[0].token;

    const [allowedResponse, siblingResponse, snapshotResponse] =
      await callGateway(target, [
        {
          name: "source_read_file",
          arguments: { grant_token: token, path: allowed }
        },
        {
          name: "source_read_file",
          arguments: { grant_token: token, path: sibling }
        },
        {
          name: "source_snapshot",
          arguments: { grant_token: token, path: allowed }
        }
      ]);
    assert.match(allowedResponse.result.content[0].text, /allowed content/);
    assert.match(siblingResponse.error.message, /exact prompt boundary/);
    assert.match(
      snapshotResponse.result.content[0].text,
      /snapshot:sha256:/
    );

    const ledger = await readFile(
      path.join(
        target,
        ".assistant",
        "internal",
        "restricted",
        "grants.jsonl"
      ),
      "utf8"
    );
    assert.doesNotMatch(ledger, new RegExp(token));
    assert.match(ledger, /"prompt_hash":/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("first interactive prompt requests durable locale setup exactly until set", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "assistant-locale-"));
  const target = path.join(tempRoot, "project");
  try {
    await initializeBlankProject(target);
    const first = await runHook(target, "이 프로젝트를 시작하자");
    const context = JSON.parse(first.hookSpecificOutput.additionalContext);
    assert.equal(context.locale.status, "required");
    assert.match(context.instruction, /locale --set/);

    const result = await setProjectLocale(target, "ko");
    assert.equal(result.project_locale, "ko");
    assert.equal(await runHook(target, "계속 진행해"), null);
    await assert.rejects(
      setProjectLocale(target, "en"),
      /requires --confirm/
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("prompt hook and doctor expose unintegrated canonical edits", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "assistant-integrity-"));
  const target = path.join(tempRoot, "project");
  try {
    await initializeBlankProject(target);
    const policyPath = path.join(target, ".assistant", "POLICY.md");
    await writeFile(
      policyPath,
      `${await readFile(policyPath, "utf8")}\nUnreviewed manual meaning.\n`,
      "utf8"
    );
    const output = await runHook(target, "continue");
    const context = JSON.parse(output.hookSpecificOutput.additionalContext);
    assert.equal(context.integrity.status, "candidate_unintegrated");
    assert.ok(context.integrity.changed.includes(".assistant/POLICY.md"));
    const doctor = await doctorProject(target, { probeSandbox: false });
    assert.equal(doctor.status, "blocked");
    assert.equal(
      doctor.checks.find((item) => item.id === "canonical_validation").status,
      "awaiting_user_input"
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("directory grant covers descendants but not sibling directories", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "assistant-dirgrant-"));
  const target = path.join(tempRoot, "project");
  try {
    await initializeBlankProject(target);
    const granted = path.join(target, "docs", "user", "bundle");
    const outside = path.join(target, "docs", "user", "outside");
    await mkdir(granted, { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(granted, "one.txt"), "one\n", "utf8");
    await writeFile(path.join(outside, "two.txt"), "two\n", "utf8");

    const output = await runHook(target, `이 디렉토리 전체를 읽어: "${granted}"`);
    const token = JSON.parse(
      output.hookSpecificOutput.additionalContext
    ).grants[0].token;
    const [inventory, child, outsideResponse] = await callGateway(target, [
      {
        name: "source_inventory_directory",
        arguments: { grant_token: token, path: granted }
      },
      {
        name: "source_read_file",
        arguments: { grant_token: token, path: path.join(granted, "one.txt") }
      },
      {
        name: "source_read_file",
        arguments: { grant_token: token, path: path.join(outside, "two.txt") }
      }
    ]);
    assert.match(inventory.result.content[0].text, /one\.txt/);
    assert.match(child.result.content[0].text, /one/);
    assert.match(outsideResponse.error.message, /exact prompt boundary/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("source snapshot preserves binary bytes without exposing them as text", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "assistant-binary-source-"));
  const target = path.join(tempRoot, "project");
  try {
    await initializeBlankProject(target);
    const source = path.join(target, "docs", "user", "artifact.bin");
    await writeFile(source, Buffer.from([0, 1, 2, 255, 0, 17]));
    const output = await runHook(target, `이 파일을 보존해: "${source}"`);
    const token = JSON.parse(
      output.hookSpecificOutput.additionalContext
    ).grants[0].token;
    const [readResponse, snapshotResponse] = await callGateway(target, [
      {
        name: "source_read_file",
        arguments: { grant_token: token, path: source }
      },
      {
        name: "source_snapshot",
        arguments: { grant_token: token, path: source }
      }
    ]);
    assert.match(readResponse.error.message, /binary file/);
    assert.match(
      snapshotResponse.result.content[0].text,
      /snapshot:sha256:[0-9a-f]{64}/
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("requested report creation requires current prompt intent and never overwrites", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "assistant-report-"));
  const target = path.join(tempRoot, "project");
  try {
    await initializeBlankProject(target);
    const output = await runHook(target, "현재 상태 보고서를 작성해줘.");
    const context = JSON.parse(output.hookSpecificOutput.additionalContext);
    const grant = context.grants.find((item) =>
      item.operations.includes("report_write_new")
    );
    assert.ok(grant);

    const call = {
      name: "report_write_new",
      arguments: {
        grant_token: grant.token,
        relative_path: "status.md",
        content: "# 상태\n",
        work_id: "WORK-TEST",
        report_kind: "requested"
      }
    };
    const [created] = await callGateway(target, [call]);
    const [duplicate] = await callGateway(target, [call]);
    const [missingGrant] = await callGateway(target, [
      {
        ...call,
        arguments: {
          ...call.arguments,
          relative_path: "without-grant.md",
          grant_token: ""
        }
      }
    ]);
    assert.match(created.result.content[0].text, /status\.md/);
    assert.match(duplicate.result.content[0].text, /"idempotent": true/);
    assert.match(missingGrant.error.message, /grant token/u);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("ongoing research records require semantic fields and typed parent relations", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "assistant-research-schema-"));
  const target = path.join(tempRoot, "project");
  const agendaPath = path.join(
    target,
    ".assistant",
    "knowledge",
    "research",
    "AGENDA.md"
  );
  const fields = (names) =>
    names.map((name) => `### ${name}\n\nUnknown — test fixture.`).join("\n\n");
  try {
    await initializeBlankProject(target);
    const metadata = {
      schema: "assistant.node/v1",
      id: "COL-RESEARCH-AGENDA",
      type: "collection",
      collection_kind: "research_agenda",
      status: "active",
      authority: "canonical_agent",
      relations: [
        { type: "contains", target: "RQ-001" },
        { type: "contains", target: "HYP-001" }
      ],
      records: [
        {
          id: "RQ-001",
          type: "question",
          status: "active",
          authority: "canonical_agent",
          origin: "ongoing",
          workflow_schema: "research.question/v1",
          relations: []
        },
        {
          id: "HYP-001",
          type: "hypothesis",
          status: "proposed",
          authority: "canonical_agent",
          origin: "ongoing",
          workflow_schema: "research.hypothesis/v1",
          relations: []
        }
      ],
      verified_at: new Date().toISOString()
    };
    const body = `# Research agenda

<!-- assistant-record:start RQ-001 -->
## RQ-001: Question

${fields([
  "Question",
  "Why it matters",
  "Related theory",
  "Prior work",
  "Evidence needed",
  "Related hypotheses",
  "Experiments or milestones",
  "Current partial answer",
  "Open scope"
])}
<!-- assistant-record:end RQ-001 -->

<!-- assistant-record:start HYP-001 -->
## HYP-001: Hypothesis

### Statement

Only one field.
<!-- assistant-record:end HYP-001 -->
`;
    await mkdir(path.dirname(agendaPath), { recursive: true });
    await writeFile(
      agendaPath,
      serializeNodeDocument(metadata, body),
      "utf8"
    );
    let validation = await validateProject(target);
    assert.equal(validation.valid, false);
    assert.ok(
      validation.findings.some(
        (item) => item.code === "RESEARCH_REQUIRED_FIELD"
      )
    );
    assert.ok(
      validation.findings.some((item) => item.code === "INDEX_STALE")
    );

    metadata.records[1].relations = [
      { type: "depends_on", target: "RQ-001" }
    ];
    const completeBody = body.replace(
      "### Statement\n\nOnly one field.",
      fields([
        "Statement",
        "Rationale",
        "Mechanism basis",
        "Published or local evidence",
        "Competing explanations",
        "Required controls",
        "Decisive test",
        "Falsification or stop condition",
        "Current disposition",
        "Allowed claim",
        "Prohibited overclaim"
      ])
    );
    await writeFile(
      agendaPath,
      serializeNodeDocument(metadata, completeBody),
      "utf8"
    );
    await refreshIndex(target);
    validation = await validateProject(target);
    assert.equal(validation.valid, true);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("ongoing software lifecycle validates and exact release routing closes through verification", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "assistant-software-schema-"));
  const target = path.join(tempRoot, "project");
  const fields = (names) =>
    names.map((name) => `### ${name}\n\nUnknown — test fixture.`).join("\n\n");
  const writeNode = async (relative, metadata, body) => {
    const absolute = path.join(target, ...relative.split("/"));
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(
      absolute,
      serializeNodeDocument(metadata, `# ${metadata.id}\n\n${body}\n`),
      "utf8"
    );
  };
  const metadata = (id, type, relations = []) => ({
    schema: "assistant.node/v1",
    id,
    type,
    status: "active",
    authority: "canonical_agent",
    origin: "ongoing",
    ...(SOFTWARE_WORKFLOW_HEADINGS[type]
      ? { workflow_schema: `software.${type}/v1` }
      : {}),
    relations,
    verified_at: new Date().toISOString()
  });
  try {
    await initializeBlankProject(target);
    const manifestPath = path.join(target, ".assistant", "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.profile = "software";
    await writeFile(
      manifestPath,
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8"
    );

    await writeNode(
      ".assistant/knowledge/FOUNDATION.md",
      metadata("FND-SW-001", "foundation"),
      "A bounded software product foundation."
    );
    await writeNode(
      ".assistant/knowledge/software/requirements/REQ-SW-001.md",
      metadata("REQ-SW-001", "requirement", [
        { type: "derived_from", target: "FND-SW-001" }
      ]),
      fields(SOFTWARE_WORKFLOW_HEADINGS.requirement)
    );
    await writeNode(
      ".assistant/knowledge/software/design/DESIGN-SW-001.md",
      metadata("DESIGN-SW-001", "design", [
        { type: "implements", target: "REQ-SW-001" }
      ]),
      fields(SOFTWARE_WORKFLOW_HEADINGS.design)
    );
    await writeNode(
      ".assistant/knowledge/software/tasks/TASK-SW-001.md",
      metadata("TASK-SW-001", "task", [
        { type: "implements", target: "DESIGN-SW-001" }
      ]),
      fields(SOFTWARE_WORKFLOW_HEADINGS.task)
    );
    await writeNode(
      ".assistant/knowledge/software/tests/TEST-SW-001.md",
      metadata("TEST-SW-001", "test", [
        { type: "verifies", target: "TASK-SW-001" }
      ]),
      fields(SOFTWARE_WORKFLOW_HEADINGS.test)
    );
    await writeNode(
      ".assistant/knowledge/work/issues/ISSUE-SW-001.md",
      metadata("ISSUE-SW-001", "issue", [
        { type: "challenges", target: "DESIGN-SW-001" }
      ]),
      fields(SOFTWARE_WORKFLOW_HEADINGS.issue)
    );
    await writeNode(
      ".assistant/knowledge/software/releases/RELEASE-SW-001.md",
      metadata("RELEASE-SW-001", "release", [
        { type: "depends_on", target: "TEST-SW-001" }
      ]),
      fields(SOFTWARE_WORKFLOW_HEADINGS.release)
    );
    await refreshIndex(target);
    await refreshValidatedHashes(target, "software_schema_fixture");

    let validation = await validateProject(target);
    assert.equal(validation.valid, true);
    const loaded = await loadCanonicalNodes(target);
    const route = routeTask(loaded.nodes, "software_release", {
      entityIds: ["RELEASE-SW-001"]
    });
    assert.equal(route.status, "routed");
    const routedIds = new Set(
      route.required.flatMap((item) => item.entity_ids ?? [item.id])
    );
    for (const id of [
      "RELEASE-SW-001",
      "TEST-SW-001",
      "TASK-SW-001",
      "DESIGN-SW-001",
      "REQ-SW-001",
      "FND-SW-001"
    ]) {
      assert.equal(routedIds.has(id), true, `missing routed dependency ${id}`);
    }

    const testPath = path.join(
      target,
      ".assistant",
      "knowledge",
      "software",
      "tests",
      "TEST-SW-001.md"
    );
    await writeFile(
      testPath,
      (await readFile(testPath, "utf8")).replace(
        /### Disposition\s+Unknown — test fixture\.\s*/u,
        ""
      ),
      "utf8"
    );
    validation = await validateProject(target);
    assert.equal(validation.valid, false);
    assert.ok(
      validation.findings.some(
        (item) => item.code === "SOFTWARE_REQUIRED_FIELD"
      )
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("structure maintenance promotes and deliberately reconsolidates without changing IDs", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "assistant-structure-"));
  const target = path.join(tempRoot, "project");
  const agendaPath = path.join(
    target,
    ".assistant",
    "knowledge",
    "research",
    "AGENDA.md"
  );
  const questionFields = (prefix = "") =>
    [
      "Question",
      "Why it matters",
      "Related theory",
      "Prior work",
      "Evidence needed",
      "Related hypotheses",
      "Experiments or milestones",
      "Current partial answer",
      "Open scope"
    ].map((name, index) =>
      `### ${name}\n\n${index === 0 ? prefix : "Unknown — fixture."}`
    ).join("\n\n");
  try {
    await initializeBlankProject(target);
    const records = ["RQ-LARGE", "RQ-SMALL"].map((id) => ({
      id,
      type: "question",
      status: "active",
      authority: "canonical_agent",
      origin: "ongoing",
      workflow_schema: "research.question/v1",
      relations: []
    }));
    const metadata = {
      schema: "assistant.node/v1",
      id: "COL-RESEARCH-AGENDA",
      type: "collection",
      collection_kind: "research_agenda",
      status: "active",
      authority: "canonical_agent",
      relations: records.map((record) => ({
        type: "contains",
        target: record.id
      })),
      records,
      verified_at: new Date().toISOString()
    };
    const body = `# Research agenda

<!-- assistant-record:start RQ-LARGE -->
## RQ-LARGE: Large

${questionFields("x".repeat(7_000))}
<!-- assistant-record:end RQ-LARGE -->

<!-- assistant-record:start RQ-SMALL -->
## RQ-SMALL: Small

${questionFields("Small question.")}
<!-- assistant-record:end RQ-SMALL -->
`;
    await mkdir(path.dirname(agendaPath), { recursive: true });
    await writeFile(agendaPath, serializeNodeDocument(metadata, body), "utf8");

    let plan = await inspectStructure(target);
    assert.ok(plan.actions.some((item) => item.action === "promote"));
    let result = await maintainStructure(target);
    assert.equal(result.validation.valid, true);
    const promotedPath = path.join(
      target,
      ".assistant",
      "knowledge",
      "research",
      "questions",
      "RQ-LARGE.md"
    );
    let promoted = parseNodeDocument(await readFile(promotedPath, "utf8"));
    assert.equal(promoted.metadata.id, "RQ-LARGE");
    const collection = parseNodeDocument(await readFile(agendaPath, "utf8"));
    assert.deepEqual(
      collection.metadata.records.map((record) => record.id),
      ["RQ-SMALL"]
    );

    promoted.metadata.lifecycle_completed = true;
    promoted.metadata.consolidation_candidate = true;
    promoted.body = `## RQ-LARGE: Closed\n\n${questionFields("Closed question.")}\n`;
    await writeFile(
      promotedPath,
      serializeNodeDocument(promoted.metadata, promoted.body),
      "utf8"
    );
    plan = await inspectStructure(target);
    assert.ok(plan.actions.some((item) => item.action === "consolidate"));
    result = await maintainStructure(target);
    assert.equal(result.validation.valid, true);
    assert.equal(
      await readFile(promotedPath, "utf8").then(() => true, () => false),
      false
    );
    const reconsolidated = parseNodeDocument(await readFile(agendaPath, "utf8"));
    assert.ok(
      reconsolidated.metadata.records.some(
        (record) => record.id === "RQ-LARGE"
      )
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("terminal report requires validated terminal episode and retries idempotently", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "assistant-terminal-"));
  const target = path.join(tempRoot, "project");
  try {
    await initializeBlankProject(target);
    const workPath = path.join(
      target,
      ".assistant",
      "knowledge",
      "work",
      "ACTIVE.md"
    );
    const workMetadata = {
      schema: "assistant.node/v1",
      id: "COL-ACTIVE-OPERATIONS",
      type: "collection",
      collection_kind: "operations",
      status: "active",
      authority: "canonical_agent",
      relations: [{ type: "contains", target: "WORK-001" }],
      records: [
        {
          id: "WORK-001",
          type: "work",
          status: "completed",
          authority: "canonical_user_approved",
          relations: []
        }
      ],
      verified_at: new Date().toISOString()
    };
    await mkdir(path.dirname(workPath), { recursive: true });
    await writeFile(
      workPath,
      serializeNodeDocument(
        workMetadata,
        "# Active operations\n\n## WORK-001\n\nCompleted.\n"
      ),
      "utf8"
    );
    const currentPath = path.join(target, ".assistant", "CURRENT.md");
    const current = parseNodeDocument(await readFile(currentPath, "utf8"));
    current.metadata.activity_status = "terminal";
    current.metadata.active_work_id = "WORK-001";
    current.metadata.authorization = "completed";
    current.metadata.relations = [
      { type: "routes_to", target: "WORK-001" }
    ];
    await writeFile(
      currentPath,
      serializeNodeDocument(current.metadata, "# Current state\n\nTerminal.\n"),
      "utf8"
    );
    const manifestPath = path.join(target, ".assistant", "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.activity_status = "terminal";
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await refreshIndex(target);
    await refreshValidatedHashes(target, "test_terminal_fixture");

    const event = await authorizeTerminalEpisode(target, {
      workId: "WORK-001",
      episodeId: "EP-001",
      locale: "ko"
    });
    assert.equal(event.event, "authorized");

    const call = {
      name: "report_write_new",
      arguments: {
        relative_path: "WORK-001-EP-001.md",
        content: "# 작업 보고서\n",
        work_id: "WORK-001",
        episode_id: "EP-001",
        report_kind: "terminal"
      }
    };
    const [first] = await callGateway(target, [call]);
    const [retry] = await callGateway(target, [call]);
    assert.match(first.result.content[0].text, /"idempotent": false/);
    assert.match(retry.result.content[0].text, /"idempotent": true/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("material conflict transaction leaves all active owners unchanged until confirmation", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "assistant-transaction-"));
  const target = path.join(tempRoot, "project");
  try {
    await initializeBlankProject(target);
    const currentPath = path.join(target, ".assistant", "CURRENT.md");
    const before = await readFile(currentPath, "utf8");
    const current = parseNodeDocument(before);
    const after = serializeNodeDocument(
      current.metadata,
      "# Current state\n\nConfirmed integrated direction.\n"
    );
    await assert.rejects(
      stageCanonicalUpdate(target, {
        type: "source_integration",
        writes: [{ path: ".assistant/CURRENT.md", content: after }],
        source_snapshot_ids: [],
        coverage: []
      }),
      /immutable snapshot identity/
    );
    const staged = await stageCanonicalUpdate(target, {
      id: "TXN-CONFLICT-001",
      type: "source_integration",
      authority: "current_user_instruction",
      source_snapshot_ids: [`snapshot:sha256:${"a".repeat(64)}`],
      coverage: [
        {
          section: "Approved direction",
          disposition: "preserved",
          canonical_owner_ids: ["CUR-001"]
        }
      ],
      writes: [
        { path: ".assistant/CURRENT.md", content: after }
      ],
      conflicts: [
        {
          id: "CONFLICT-001",
          material: true,
          concern: "current plan"
        }
      ]
    });
    assert.equal(staged.status, "awaiting_confirmation");
    assert.equal(await readFile(currentPath, "utf8"), before);
    await assert.rejects(
      commitCanonicalUpdate(target, staged.id),
      /whole-transaction confirmation/
    );
    assert.equal(await readFile(currentPath, "utf8"), before);
    const committed = await commitCanonicalUpdate(target, staged.id, {
      confirmed: true
    });
    assert.equal(committed.status, "committed");
    assert.equal(await readFile(currentPath, "utf8"), after);

    const foundation = serializeNodeDocument(
      {
        schema: "assistant.node/v1",
        id: "FND-TXN-001",
        type: "foundation",
        status: "active",
        authority: "canonical_agent",
        relations: [],
        verified_at: new Date().toISOString()
      },
      "# Foundation\n\nA newly routed durable owner.\n"
    );
    const projectionTransaction = await stageCanonicalUpdate(target, {
      id: "TXN-PROJECTION-001",
      writes: [
        {
          path: ".assistant/knowledge/foundation/FOUNDATION.md",
          content: foundation
        }
      ]
    });
    await commitCanonicalUpdate(target, projectionTransaction.id);
    assert.match(
      await readFile(path.join(target, ".assistant", "INDEX.md"), "utf8"),
      /FND-TXN-001/
    );

    await assert.rejects(
      stageCanonicalUpdate(target, {
        writes: [
          {
            path: ".assistant/CURRENT.md",
            content: after.replace(
              "Confirmed integrated direction.",
              "See docs/user/live-plan.md."
            )
          }
        ]
      }),
      /forbidden live source/
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("installed runtime validates itself and doctor separates unprobed sandbox", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "assistant-doctor-"));
  const target = path.join(tempRoot, "project");
  try {
    await initializeBlankProject(target);
    const doctor = await doctorProject(target, { probeSandbox: false });
    assert.equal(doctor.status, "ready");
    assert.equal(
      doctor.checks.find((item) => item.id === "direct_restricted_deny").status,
      "not_probed"
    );
    const launcher = path.join(
      target,
      ".assistant",
      "system",
      "assistant.cmd"
    );
    const local = await import("node:child_process").then(({ spawnSync }) =>
      spawnSync("cmd.exe", ["/d", "/c", launcher, "validate"], {
        cwd: target,
        encoding: "utf8",
        windowsHide: true
      })
    );
    assert.equal(local.status, 0, local.stderr);
    assert.equal(JSON.parse(local.stdout).valid, true);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
