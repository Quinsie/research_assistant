import { spawn } from "node:child_process";
import { cp, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scenarioRoot = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(scenarioRoot, "..", "..", "..");
const targetRoot = path.join(
  await mkdtemp(path.join(os.tmpdir(), "assistant-semantic-bootstrap-")),
  "project"
);

await cp(scenarioRoot, targetRoot, {
  recursive: true,
  filter: (source) => !source.endsWith("run-bootstrap.mjs")
});

const outputPath = path.join(path.dirname(targetRoot), "runner-output.json");
const launcher = path.join(packageRoot, "assistant.cmd");
const child = spawn(
  "cmd.exe",
  ["/d", "/c", launcher, "init", "--target", targetRoot],
  {
    cwd: packageRoot,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  }
);

let stdout = "";
let stderr = "";
child.stdout.on("data", (chunk) => {
  stdout += chunk;
});
child.stderr.on("data", (chunk) => {
  stderr += chunk;
});

const exitCode = await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", resolve);
});

const record = {
  schema: "assistant.scenario-run/v1",
  scenario: "existing_minimal",
  target: targetRoot,
  exit_code: exitCode,
  stdout,
  stderr,
  completed_at: new Date().toISOString()
};
await writeFile(outputPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ outputPath, targetRoot, exitCode })}\n`);
process.exitCode = exitCode ?? 1;
