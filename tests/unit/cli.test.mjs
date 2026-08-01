import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(testDirectory, "..", "..");
const launcher = path.join(packageRoot, "assistant.cmd");

function runLauncher(args) {
  const result = spawnSync("cmd.exe", ["/d", "/c", launcher, ...args], {
    cwd: packageRoot,
    encoding: "utf8",
    windowsHide: true
  });
  assert.equal(
    result.status,
    0,
    `command failed: ${args.join(" ")}\nstdout=${result.stdout}\nstderr=${result.stderr}`
  );
  return JSON.parse(result.stdout);
}

test("Windows cmd launcher supports init, validate, route, and policy", async () => {
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
