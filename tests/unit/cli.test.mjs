import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
