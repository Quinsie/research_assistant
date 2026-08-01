import path from "node:path";
import { appendFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import {
  appendGrant,
  normalizeProjectRoot,
  resolveExistingBoundary,
  sha256,
  zoneForPath
} from "./restricted-common.mjs";
import { inspectValidatedHashes } from "../lib/integrity.mjs";
import { checkAvailableUpdate } from "../lib/version-check.mjs";

function debug(message) {
  const destination = process.env.ASSISTANT_HOOK_DEBUG_PATH;
  if (destination) {
    appendFileSync(destination, `${new Date().toISOString()} ${message}\n`, "utf8");
  }
}

async function readStdin() {
  return new Promise((resolve, reject) => {
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      debug(`stdin chunk ${Buffer.byteLength(chunk, "utf8")} bytes`);
      input += chunk;
      if (Buffer.byteLength(input, "utf8") > 128 * 1024) {
        reject(new Error("prompt hook input is too large"));
        return;
      }
      try {
        const parsed = JSON.parse(input.trim());
        process.stdin.destroy();
        debug("parsed hook input");
        resolve(parsed);
      } catch {
        // A command-hook JSON object can arrive in more than one chunk.
      }
    });
    process.stdin.on("end", () => {
      try {
        resolve(JSON.parse(input.trim()));
      } catch (error) {
        reject(error);
      }
    });
    process.stdin.on("error", reject);
  });
}

function stripTrailingPunctuation(value) {
  return value.replace(/[),.;:!?。，、；：！？]+$/u, "");
}

export function extractRestrictedCandidates(prompt, projectRoot) {
  const candidates = new Set();
  const patterns = [
    /"([^"\r\n]+)"/gu,
    /'([^'\r\n]+)'/gu,
    /(?:[A-Za-z]:[\\/][^\r\n"'<>|?*]+|(?:\.{0,2}[\\/])?(?:docs|\.assistant[\\/]vault)(?:[\\/][^\s"'<>|?*]+)*)/gu,
    /(?:\.{0,2}[\\/])?[^\s"'<>|?*]+[\\/][^\s"'<>|?*]+/gu
  ];
  for (const pattern of patterns) {
    for (const match of prompt.matchAll(pattern)) {
      const raw = stripTrailingPunctuation(match[1] ?? match[0]).trim();
      if (!raw) continue;
      const absolute = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(projectRoot, raw);
      if (zoneForPath(projectRoot, absolute)) candidates.add(absolute);
    }
  }
  return [...candidates];
}

async function captureDeferredRequest(projectRoot, input) {
  const bootstrapRoot = path.join(
    projectRoot,
    ".assistant",
    "internal",
    "bootstrap"
  );
  const statePath = path.join(bootstrapRoot, "state.json");
  let state;
  try {
    state = JSON.parse(await readFile(statePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  if (state.status !== "awaiting_user_input") return null;

  const location = path.join(bootstrapRoot, "deferred-request.json");
  try {
    return JSON.parse(await readFile(location, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const prompt = String(input.prompt || "");
  const record = {
    schema: "assistant.deferred-request/v1",
    id: `DEFERRED-${sha256(prompt).slice(0, 16)}`,
    status: "pending",
    prompt,
    prompt_hash: sha256(prompt),
    session_id: String(input.session_id || ""),
    turn_id: String(input.turn_id || ""),
    captured_at: new Date().toISOString()
  };
  await mkdir(bootstrapRoot, { recursive: true });
  await writeFile(location, `${JSON.stringify(record, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
  return record;
}

async function localeSetup(projectRoot) {
  try {
    const manifest = JSON.parse(
      await readFile(
        path.join(projectRoot, ".assistant", "manifest.json"),
        "utf8"
      )
    );
    const localeCommand = process.platform === "win32"
      ? ".assistant\\system\\assistant.cmd locale --set <BCP-47-tag>"
      : ".assistant/system/assistant locale --set <BCP-47-tag>";
    return manifest.project_locale
      ? null
      : {
          status: "required",
          instruction:
            "Infer the language of this first interactive user prompt and run " +
            `\`${localeCommand}\` ` +
            "before creating any user-facing report. Do not ask merely to choose a language."
        };
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function main() {
  debug(`started argv=${JSON.stringify(process.argv)}`);
  const input = await readStdin();
  if (input.hook_event_name !== "UserPromptSubmit") return;
  const projectRoot = normalizeProjectRoot(input.cwd || process.cwd());
  const deferred = await captureDeferredRequest(projectRoot, input);
  const locale = await localeSetup(projectRoot);
  const update = await checkAvailableUpdate(projectRoot, {
    sessionId: String(input.session_id || "") || null
  }).catch(() => null);
  let integrity;
  try {
    integrity = await inspectValidatedHashes(projectRoot);
  } catch (error) {
    integrity = { status: "invalid", error: error.message };
  }
  if (integrity.status === "clean") integrity = null;
  const candidates = extractRestrictedCandidates(String(input.prompt || ""), projectRoot);
  const grants = [];
  const rejected = [];
  for (const candidate of candidates) {
    try {
      const boundary = await resolveExistingBoundary(projectRoot, candidate);
      const grant = await appendGrant(projectRoot, input, boundary);
      grants.push({
        grant_id: grant.record.grant_id,
        token: grant.token,
        path: grant.record.boundary,
        boundary_kind: grant.record.boundary_kind,
        operations: grant.record.operations
      });
    } catch (error) {
      rejected.push({ path: candidate, reason: error.message });
    }
  }
  if (
    /(report|보고서)/iu.test(String(input.prompt || "")) &&
    /(create|write|generate|prepare|작성|생성|만들|준비)/iu.test(
      String(input.prompt || "")
    )
  ) {
    const reportRoot = path.join(projectRoot, "docs", "report");
    try {
      const boundary = await resolveExistingBoundary(projectRoot, reportRoot);
      const grant = await appendGrant(
        projectRoot,
        input,
        boundary,
        ["report_write_new"]
      );
      grants.push({
        grant_id: grant.record.grant_id,
        token: grant.token,
        path: grant.record.boundary,
        boundary_kind: grant.record.boundary_kind,
        operations: grant.record.operations
      });
    } catch (error) {
      rejected.push({ path: reportRoot, reason: error.message });
    }
  }
  if (
    grants.length === 0 &&
    rejected.length === 0 &&
    deferred === null &&
    locale === null &&
    integrity === null
    && update === null
  ) return;
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: JSON.stringify({
        schema: "assistant.prompt-grants/v1",
        instruction:
          "Use only assistant_restricted MCP tools for these exact boundaries. " +
          "A grant permits access, not canonical integration or authority. " +
          (deferred
            ? "Assistant canonical bootstrap is incomplete. Explain that this pauses only assistant-managed canonical reliance, not the project or its people. Resolve the listed blockers, then claim and resume the captured request. If the user explicitly chooses to work without assistant context, do not present assistant lifecycle state as project authority."
            : "") +
          (locale ? ` ${locale.instruction}` : ""),
        update,
        ...(update
          ? {
              update_instruction:
                `Mention once, briefly: Assistant ${update.available_version} is available. Updating is optional and never automatic; download that release and run its assistant update --target command.`
            }
          : {}),
        grants,
        rejected,
        deferred_request: deferred
          ? { id: deferred.id, status: deferred.status }
          : null,
        locale,
        integrity,
        ...(integrity
          ? {
              integrity_instruction:
                "Canonical integrity is not clean. Treat the listed files as candidate_unintegrated; review authority and use a canonical transaction before relying on or extending the changed meaning."
            }
          : {})
      })
    }
  }));
}

main().catch((error) => {
  debug(`failed ${error.stack || error.message}`);
  process.stderr.write(`assistant restricted hook: ${error.message}\n`);
  process.exitCode = 1;
});
