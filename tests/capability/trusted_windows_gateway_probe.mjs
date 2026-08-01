import { spawn } from "node:child_process";
import path from "node:path";

const [targetInput, sourceInput] = process.argv.slice(2);
if (!targetInput || !sourceInput) {
  throw new Error("usage: node trusted_windows_gateway_probe.mjs <target> <source>");
}

const target = path.resolve(targetInput);
const source = path.resolve(sourceInput);

function runHook() {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [path.join(
        target,
        ".assistant",
        "system",
        "runtime",
        "user-prompt-submit.mjs"
      )],
      {
        cwd: target,
        env: { ...process.env, ASSISTANT_PROJECT_ROOT: target },
        stdio: ["pipe", "pipe", "pipe"]
      }
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr || `hook exited ${code}`));
        return;
      }
      resolve(JSON.parse(stdout));
    });
    child.stdin.end(JSON.stringify({
      session_id: "trusted-windows-probe",
      turn_id: "exact-source-read",
      cwd: target,
      hook_event_name: "UserPromptSubmit",
      model: "probe",
      permission_mode: "default",
      prompt: `Read exactly this file for validation: "${source}"`
    }));
  });
}

function callGateway(grantToken) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [path.join(
        target,
        ".assistant",
        "system",
        "runtime",
        "gateway.mjs"
      )],
      {
        cwd: target,
        env: { ...process.env, ASSISTANT_PROJECT_ROOT: target },
        stdio: ["pipe", "pipe", "pipe"]
      }
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0 && !stdout) {
        reject(new Error(stderr || `gateway exited ${code}`));
        return;
      }
      const line = stdout.trim().split(/\r?\n/u).find(Boolean);
      resolve(JSON.parse(line));
    });
    child.stdin.end(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "source_read_file",
        arguments: {
          grant_token: grantToken,
          path: source
        }
      }
    })}\n`);
  });
}

const hook = await runHook();
const context = JSON.parse(hook.hookSpecificOutput.additionalContext);
if (!Array.isArray(context.grants) || context.grants.length !== 1) {
  throw new Error("hook did not issue exactly one grant");
}
const response = await callGateway(context.grants[0].token);
const text = response?.result?.content?.[0]?.text;
if (typeof text !== "string") {
  throw new Error(response?.error?.message ?? "gateway returned no text");
}

process.stdout.write(`${JSON.stringify({
  schema: "assistant.trusted-windows-gateway-probe/v1",
  grant_count: context.grants.length,
  gateway_read: "pass",
  source_path: source,
  content_bytes: Buffer.byteLength(text, "utf8"),
  content_sha_visible: /assistant restricted user source canary/u.test(text)
})}\n`);
