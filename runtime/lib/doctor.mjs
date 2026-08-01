import { spawn } from "node:child_process";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { discoverCodexInvocation } from "./codex.mjs";
import { pathExists } from "./files.mjs";
import { validateProject } from "./validator.mjs";
import {
  inspectWindowsRestrictedAcls,
  WINDOWS_RESTRICTED_CANARY
} from "./windows-acl.mjs";

function check(id, status, detail) {
  return { id, status, detail };
}

function run(invocation, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      invocation.command,
      [...invocation.prefixArgs, ...args],
      { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

export async function requiredSecurityFragments(root) {
  const boundariesPath = path.join(
    root,
    ".assistant",
    "internal",
    "restricted",
    "boundaries.json"
  );
  const boundaries = (await pathExists(boundariesPath))
    ? JSON.parse(await readFile(boundariesPath, "utf8")).boundaries ?? []
    : [];
  return [
    "[permissions.assistant_project]",
    "\"docs\" = \"deny\"",
    "\".assistant/vault\" = \"deny\"",
    "\".assistant/internal/restricted\" = \"deny\"",
    "[[hooks.UserPromptSubmit]]",
    "[mcp_servers.assistant_restricted]",
    ...boundaries.map(
      (boundary) => `${JSON.stringify(boundary.relative)} = "deny"`
    )
  ];
}

export async function doctorProject(target, options = {}) {
  const root = path.resolve(target);
  const checks = [];
  const validation = await validateProject(root);
  checks.push(
    check(
      "canonical_validation",
      !validation.valid
        ? "fail"
        : validation.findings.some((item) =>
            ["CANONICAL_UNINTEGRATED_EDIT", "INTEGRITY_LEDGER_MISSING"].includes(
              item.code
            )
          )
          ? "awaiting_user_input"
          : "pass",
      validation.summary
    )
  );

  const activeConfig = path.join(root, ".codex", "config.toml");
  const pendingConfig = path.join(
    root,
    ".assistant",
    "internal",
    "pending",
    "assistant-config.toml"
  );
  if (await pathExists(pendingConfig)) {
    checks.push(
      check(
        "active_security_config",
        "awaiting_user_input",
        "assistant Codex config is staged and not active"
      )
    );
  } else if (!(await pathExists(activeConfig))) {
    checks.push(check("active_security_config", "fail", "missing .codex/config.toml"));
  } else {
    const config = await readFile(activeConfig, "utf8");
    const required = await requiredSecurityFragments(root);
    const missing = required.filter((fragment) => !config.includes(fragment));
    checks.push(
      check(
        "active_security_config",
        missing.length === 0 ? "pass" : "fail",
        missing.length === 0 ? "required profile, hook, and gateway are configured" : { missing }
      )
    );
  }

  const pendingRoot = path.join(
    root,
    ".assistant",
    "internal",
    "pending"
  );
  if (await pathExists(pendingRoot)) {
    const entries = await readdir(pendingRoot);
    if (entries.length > 0) {
      checks.push(
        check(
          "system_migrations",
          "awaiting_user_input",
          { pending_entries: entries }
        )
      );
    }
  }

  const runtimePaths = [
    ".assistant/system/assistant",
    ".assistant/system/runtime/gateway.mjs",
    ".assistant/system/runtime/user-prompt-submit.mjs",
    ".assistant/system/runtime/assistant.mjs",
    ".assistant/system/lib/validator.mjs",
    `.assistant/system/${validation.manifest?.profile ?? "research"}-schema.md`,
    `.agents/skills/assistant-${validation.manifest?.profile ?? "research"}-workflow/SKILL.md`
  ];
  const missingRuntime = [];
  for (const relative of runtimePaths) {
    if (!(await pathExists(path.join(root, ...relative.split("/"))))) {
      missingRuntime.push(relative);
    }
  }
  checks.push(
    check(
      "installed_runtime",
      missingRuntime.length === 0 ? "pass" : "fail",
      missingRuntime.length === 0
        ? `runtime and ${validation.manifest?.profile ?? "research"} skill are installed`
        : { missingRuntime }
    )
  );

  if (process.platform === "win32") {
    const acl = await inspectWindowsRestrictedAcls(root);
    checks.push(
      check(
        "windows_restricted_acl",
        acl.status === "enforced" ? "pass" : "fail",
        acl.status === "enforced"
          ? {
              boundaries: acl.boundaries.length,
              sandbox_group_sid: acl.sandbox_group_sid
            }
          : acl.findings
      )
    );
    const hidden = await run(
      { command: "attrib.exe", prefixArgs: [] },
      [path.join(root, ".assistant")],
      root
    );
    const hiddenPresent =
      hidden.code === 0 &&
      /^\s*[^\r\n]*H[^\r\n]*\.assistant\s*$/imu.test(hidden.stdout);
    checks.push(
      check(
        "assistant_hidden_attribute",
        hiddenPresent ? "pass" : "fail",
        hiddenPresent
          ? "Windows hidden attribute is set on .assistant"
          : hidden.code === 0
            ? "Windows hidden attribute is missing from .assistant"
          : hidden.stderr.slice(-1_000)
      )
    );
  } else {
    checks.push(
      check(
        "assistant_hidden_attribute",
        "not_applicable",
        "dot-directory visibility is native on this platform"
      )
    );
  }

  if (options.probeSandbox !== false) {
    try {
      const invocation = await discoverCodexInvocation();
      const common = ["sandbox", "-C", root, "-P", "assistant_project"];
      const publicProbe = process.platform === "win32"
        ? await run(
            invocation,
            [...common, "cmd.exe", "/d", "/c", "type", ".assistant\\manifest.json"],
            root
          )
        : await run(
            invocation,
            [...common, "--", "/bin/cat", ".assistant/manifest.json"],
            root
          );
      const restrictedProbe = process.platform === "win32"
        ? await run(
            invocation,
            [
              ...common,
              "cmd.exe",
              "/d",
              "/c",
              "type",
              WINDOWS_RESTRICTED_CANARY.replaceAll("/", "\\")
            ],
            root
          )
        : await run(
            invocation,
            [...common, "--", "/bin/cat", WINDOWS_RESTRICTED_CANARY],
            root
          );
      const restrictedWriteProbe = process.platform === "win32"
        ? await run(
            invocation,
            [
              ...common,
              "cmd.exe",
              "/d",
              "/c",
              `echo direct write bypass>${WINDOWS_RESTRICTED_CANARY.replaceAll("/", "\\")}`
            ],
            root
          )
        : await run(
            invocation,
            [
              ...common,
              "--",
              "/bin/sh",
              "-c",
              "printf 'direct write bypass\\n' > \"$1\"",
              "assistant-doctor",
              path.join(root, ...WINDOWS_RESTRICTED_CANARY.split("/"))
            ],
            root
          );
      await writeFile(
        path.join(root, ...WINDOWS_RESTRICTED_CANARY.split("/")),
        "assistant restricted read denial canary\n",
        "utf8"
      );
      const combined =
        `${publicProbe.stderr}\n${restrictedProbe.stderr}\n`
        + restrictedWriteProbe.stderr;
      if (/default_permissions requires a `?\[permissions\]`? table/iu.test(combined)) {
        checks.push(
          check(
            "direct_restricted_deny",
            "awaiting_user_input",
            "project-local Codex config is not active; trust the project/config layer and rerun doctor"
          )
        );
      } else if (/elevated Windows sandbox backend/iu.test(combined)) {
        checks.push(
          check(
            "direct_restricted_deny",
            "environment_blocked",
            "current native Windows backend is not elevated"
          )
        );
      } else if (
        publicProbe.code === 0 &&
        restrictedProbe.code !== 0 &&
        restrictedWriteProbe.code !== 0
      ) {
        checks.push(
          check(
            "direct_restricted_deny",
            "pass",
            "public canary readable and restricted direct read/write denied"
          )
        );
      } else if (
        restrictedProbe.code === 0 ||
        restrictedWriteProbe.code === 0
      ) {
        checks.push(
          check(
            "direct_restricted_deny",
            "fail",
            restrictedProbe.code === 0
              ? "restricted canary was directly readable"
              : "restricted canary was directly writable"
          )
        );
      } else {
        checks.push(
          check(
            "direct_restricted_deny",
            "fail",
            {
              public_exit: publicProbe.code,
              restricted_read_exit: restrictedProbe.code,
              restricted_write_exit: restrictedWriteProbe.code,
              stderr: combined.slice(-2_000)
            }
          )
        );
      }
    } catch (error) {
      checks.push(check("direct_restricted_deny", "fail", error.message));
    }
  } else {
    checks.push(
      check("direct_restricted_deny", "not_probed", "sandbox probe disabled")
    );
  }

  const hardFailure = checks.some((item) => item.status === "fail");
  const blocked = checks.some((item) =>
    ["environment_blocked", "awaiting_user_input"].includes(item.status)
  );
  return {
    schema: "assistant.doctor/v1",
    target: root,
    status: hardFailure ? "failed" : blocked ? "blocked" : "ready",
    checks
  };
}
