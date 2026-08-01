import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(testDirectory, "..", "..");
const windows = process.platform === "win32";
const launcher = path.join(packageRoot, windows ? "assistant.cmd" : "assistant");

function runLauncher(args) {
  const effectiveArgs = args.includes("--json") ? args : [...args, "--json"];
  const result = spawnSync(
    windows ? "cmd.exe" : launcher,
    windows ? ["/d", "/c", launcher, ...effectiveArgs] : effectiveArgs,
    {
    cwd: packageRoot,
    encoding: "utf8",
    windowsHide: true
    }
  );
  assert.equal(
    result.status,
    0,
    `command failed: ${effectiveArgs.join(" ")}\nstdout=${result.stdout}\nstderr=${result.stderr}`
  );
  return JSON.parse(result.stdout);
}

test("platform launcher supports init, validate, route, and policy", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "assistant-cli-"));
  const target = path.join(tempRoot, "project with spaces");
  try {
    const initialized = runLauncher(["init", "--target", target]);
    assert.equal(initialized.initialization_status, "ready");

    const validation = runLauncher(["validate", "--target", target]);
    assert.equal(validation.valid, true);

    const route = runLauncher([
      "route",
      "--target",
      target,
      "--task",
      "status"
    ]);
    assert.equal(route.status, "routed");
    assert.equal(route.required[0].id, "CUR-001");

    const policy = runLauncher([
      "policy",
      "--target",
      target,
      "--side-effect",
      "git_push"
    ]);
    assert.equal(policy.status, "resolved");
    assert.equal(policy.effective, "explicit_user_instruction");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("human output is default and existing-project model cost requires acknowledgement", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "assistant-cli-human-"));
  const blank = path.join(tempRoot, "blank");
  const existing = path.join(tempRoot, "existing");
  try {
    const human = spawnSync(
      windows ? "cmd.exe" : launcher,
      windows
        ? ["/d", "/c", launcher, "init", "--target", blank]
        : ["init", "--target", blank],
      { cwd: packageRoot, encoding: "utf8", windowsHide: true }
    );
    assert.equal(human.status, 0, human.stderr);
    assert.match(human.stdout, /Initialization status: ready/);
    assert.doesNotMatch(human.stdout, /^\s*\{/u);

    await writeFile(existing, "project content\n", "utf8");
    const confirmation = spawnSync(
      windows ? "cmd.exe" : launcher,
      windows
        ? [
            "/d", "/c", launcher, "init", "--target", tempRoot,
            "--model", "custom-model", "--json"
          ]
        : [
            "init", "--target", tempRoot, "--model", "custom-model", "--json"
          ],
      { cwd: packageRoot, encoding: "utf8", windowsHide: true }
    );
    assert.equal(confirmation.status, 3, confirmation.stderr);
    const payload = JSON.parse(confirmation.stdout);
    assert.equal(payload.status, "confirmation_required");
    assert.equal(payload.model, "custom-model");
    assert.equal(payload.effort, "high");
    assert.equal(
      await import("node:fs/promises").then(({ stat }) =>
        stat(path.join(tempRoot, ".assistant")).then(() => true, () => false)
      ),
      false
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("existing-project migration stops before model work and installed CLI gives a human handoff", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "assistant-cli-migration-"));
  const target = path.join(tempRoot, "legacy project");
  try {
    await mkdir(path.join(target, "docs", "agent"), { recursive: true });
    await writeFile(
      path.join(target, "AGENTS.md"),
      "# Existing repository rules\n\nRead docs/agent/INDEX.md before work.\n",
      "utf8"
    );
    await writeFile(
      path.join(target, "docs", "agent", "INDEX.md"),
      "# Legacy index\n",
      "utf8"
    );
    const initialized = runLauncher([
      "init",
      "--target",
      target,
      "--yes"
    ]);
    assert.equal(initialized.completion.readiness, "system_migration_required");
    assert.equal(initialized.selection.model, "gpt-5.6-sol");
    assert.equal(initialized.selection.effort, "high");
    const executionExists = await import("node:fs/promises").then(({ stat }) =>
      stat(
        path.join(
          target,
          ".assistant",
          "internal",
          "bootstrap",
          "execution.json"
        )
      ).then(() => true, () => false)
    );
    assert.equal(executionExists, false);

    const installed = path.join(
      target,
      ".assistant",
      "system",
      windows ? "assistant.cmd" : "assistant"
    );
    const status = spawnSync(
      windows ? process.execPath : installed,
      windows
        ? [
            path.join(target, ".assistant", "system", "runtime", "assistant.mjs"),
            "migration",
            "--target",
            target
          ]
        : ["migration", "--target", target],
      { cwd: target, encoding: "utf8", windowsHide: true }
    );
    assert.equal(status.status, 0, status.stderr);
    assert.doesNotMatch(status.stdout, /^\s*\{/u);
    assert.match(status.stdout, /interactive Codex/i);
    assert.match(status.stdout, /system migration decision/i);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("installed init owns the complete persisted discovery and semantic continuation", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "assistant-installed-init-"));
  const target = path.join(tempRoot, "existing project");
  const bin = path.join(tempRoot, "bin");
  const log = path.join(tempRoot, "codex-args.log");
  try {
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, "README.md"), "# Existing project\n", "utf8");
    const deterministic = runLauncher([
      "init",
      "--target",
      target,
      "--deterministic-only"
    ]);
    assert.equal(deterministic.initialization_status, "bootstrap_incomplete");

    const fakeSource = [
      "import { appendFileSync, writeFileSync } from 'node:fs';",
      "const args = process.argv.slice(2);",
      "appendFileSync(process.env.ASSISTANT_FAKE_LOG, JSON.stringify(args) + '\\n');",
      "const value = (name) => args[args.indexOf(name) + 1];",
      "const schema = value('--output-schema');",
      "const output = value('--output-last-message');",
      "process.stdin.resume();",
      "process.stdin.on('end', () => {",
      "  process.stdout.write(JSON.stringify({type:'thread.started',thread_id:'installed-thread-001'}) + '\\n');",
      "  const payload = schema.includes('bootstrap-discovery')",
      "    ? {schema:'assistant.bootstrap-discovery/v1',boundaries:[],uncertainties:[]}",
      "    : {schema:'assistant.bootstrap-output/v1',project_summary:{purpose:null,scope:null,current_state:'Observed existing project',current_authorization:null,authorization_state:'not_authorized',authorized_work:[],blocked_work:['Unspecified work'],authorization_basis_paths:[],next_safe_route:'Ask the user for direction'},candidate_nodes:[],coverage_groups:[{selector_kind:'exact_path',selector:'README.md',disposition:'preserved',reason:'Root orientation document accounted for'}],gaps:[],conflicts:[]};",
      "  writeFileSync(output, JSON.stringify(payload));",
      "  process.stdout.write(JSON.stringify({type:'turn.completed',usage:{input_tokens:10,output_tokens:5}}) + '\\n');",
      "});"
    ].join("\n");
    if (windows) {
      const script = path.join(
        bin,
        "node_modules",
        "@openai",
        "codex",
        "bin",
        "codex.js"
      );
      await mkdir(path.dirname(script), { recursive: true });
      await writeFile(path.join(bin, "codex.cmd"), "@exit /b 0\r\n", "utf8");
      await writeFile(script, fakeSource, "utf8");
    } else {
      const script = path.join(bin, "fake-codex.mjs");
      await mkdir(bin, { recursive: true });
      await writeFile(script, fakeSource, "utf8");
      await writeFile(
        path.join(bin, "codex"),
        `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`,
        { encoding: "utf8", mode: 0o755 }
      );
    }
    const installedRuntime = path.join(
      target,
      ".assistant",
      "system",
      "runtime",
      "assistant.mjs"
    );
    const result = spawnSync(
      process.execPath,
      [installedRuntime, "init", "--target", target, "--json"],
      {
        cwd: target,
        encoding: "utf8",
        windowsHide: true,
        env: {
          ...process.env,
          PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
          ASSISTANT_FAKE_LOG: log
        }
      }
    );
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.completion.initialization_status, "ready");
    assert.equal(payload.completion.validation.valid, true);
    const invocations = (await import("node:fs/promises").then(({ readFile }) =>
      readFile(log, "utf8")
    ))
      .trim()
      .split(/\r?\n/u)
      .map((line) => JSON.parse(line));
    const bootstrapInvocations = invocations.filter((args) =>
      args.some(
        (value) =>
          typeof value === "string" &&
          /bootstrap-(?:discovery|output)\.schema\.json$/u.test(value)
      )
    );
    assert.equal(bootstrapInvocations.length, 2);
    assert.equal(bootstrapInvocations[0].includes("--ephemeral"), false);
    assert.equal(bootstrapInvocations[1].includes("resume"), true);
    assert.ok(
      bootstrapInvocations.every((args) =>
        args.includes("gpt-5.6-sol") &&
        args.includes('model_reasoning_effort="high"')
      )
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
