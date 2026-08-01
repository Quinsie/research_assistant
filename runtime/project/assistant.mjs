#!/usr/bin/env node
import path from "node:path";
import { readFile } from "node:fs/promises";
import {
  persistBootstrapSelection,
  runSemanticBootstrap
} from "../lib/bootstrap.mjs";
import { resolveBootstrap } from "../lib/bootstrap-resolution.mjs";
import {
  claimDeferredRequest,
  completeDeferredRequest,
  inspectDeferredRequest
} from "../lib/deferred.mjs";
import { doctorProject } from "../lib/doctor.mjs";
import { authorizeTerminalEpisode } from "../lib/episode.mjs";
import { finalizeInstalledProject } from "../lib/initialization.mjs";
import { setProjectLocale } from "../lib/locale.mjs";
import {
  completeAgentsControlPlaneMigration,
  completeCodexConfigMigration,
  inspectPendingMigrations,
  replacePendingSkillMigration
} from "../lib/migration.mjs";
import { resolvePolicy } from "../lib/policy.mjs";
import { routeTask } from "../lib/router.mjs";
import { inspectStructure, maintainStructure } from "../lib/structure.mjs";
import {
  commitCanonicalUpdate,
  stageCanonicalUpdate
} from "../lib/transaction.mjs";
import { loadCanonicalNodes, validateProject } from "../lib/validator.mjs";

function parse(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const item = rest[index];
    if (item === "-p") {
      options.profile = rest[index + 1];
      index += 1;
      continue;
    }
    if (!item.startsWith("--")) continue;
    const next = rest[index + 1];
    if (next === undefined || next.startsWith("--")) {
      options[item.slice(2)] = true;
    } else {
      options[item.slice(2)] = next;
      index += 1;
    }
  }
  return { command, options };
}

function shellTarget(target) {
  return /\s/u.test(target) ? `"${target}"` : target;
}

function humanResult(value) {
  if (value.schema === "assistant.migration-status/v1") {
    if (value.pending.length === 0) {
      return "No system migration is pending. Assistant initialization may continue.";
    }
    const lines = [
      `Assistant initialization is paused for ${value.pending.length} system migration decision(s).`
    ];
    for (const item of value.pending) {
      lines.push(`- ${item.kind}: ${item.action}`);
    }
    const selection = value.selection?.profile
      ? `Codex profile '${value.selection.profile}'`
      : `model '${value.selection?.model ?? "gpt-5.6-sol"}' with ` +
        `'${value.selection?.effort ?? "high"}' reasoning effort`;
    lines.push(`Recommended for the remaining initialization: ${selection}.`);
    lines.push(
      "Open interactive Codex in this project root and ask it to continue " +
      "Assistant initialization; it will explain only the decisions you must make."
    );
    lines.push("Use --json only when a machine-readable payload is required.");
    return lines.join("\n");
  }
  if (value.schema === "assistant.init-result/v1") {
    const completion = value.completion ?? {};
    const semantic = value.semantic ?? {};
    const status = completion.initialization_status ?? value.initialization_status;
    const lines = [`Initialization status: ${status}.`];
    if (semantic.schema) {
      lines.push(
        `Semantic result: ${semantic.candidate_nodes ?? 0} candidates, ` +
        `${semantic.gaps ?? 0} gaps, ${semantic.conflicts ?? 0} conflicts, ` +
        `${semantic.tokens_used ?? "unknown"} tokens.`
      );
    }
    if (completion.readiness === "system_migration_required") {
      lines.push(
        "Canonical activation is paused until repository-native rules are reconciled."
      );
      lines.push(`Change directory to ${shellTarget(value.target)} and open interactive Codex.`);
      lines.push(
        'Send: "Continue Assistant initialization. Review the pending system migration, ' +
        'ask only the necessary questions, then resume with the persisted model settings."'
      );
    } else if (completion.readiness === "bootstrap_decision_required") {
      lines.push(
        "The semantic survey is staged. Resolve the reported project decisions in " +
        "interactive Codex before relying on Assistant canonical context."
      );
    } else if (completion.next) {
      lines.push(`Next: ${completion.next}`);
    }
    return lines.join("\n");
  }
  if (value.schema === "assistant.validation/v1") {
    return value.valid
      ? `Validation passed (${value.summary?.nodes ?? 0} nodes).`
      : `Validation failed (${value.summary?.errors ?? "unknown"} errors). Use --json for details.`;
  }
  const lines = [
    `${value.schema ?? "assistant result"}: ${
      value.status ?? (value.valid === true ? "passed" : "completed")
    }.`
  ];
  if (typeof value.next === "string") lines.push(`Next: ${value.next}`);
  lines.push("Use --json for the complete machine payload.");
  return lines.join("\n");
}

function printResult(value, jsonOutput) {
  process.stdout.write(
    jsonOutput
      ? `${JSON.stringify(value, null, 2)}\n`
      : `${humanResult(value)}\n`
  );
}

function progressReporter() {
  const started = Date.now();
  return ({ phase, message, elapsed_seconds: elapsed }) => {
    const seconds = elapsed ?? Math.round((Date.now() - started) / 1000);
    process.stderr.write(`[assistant] ${phase} (${seconds}s): ${message}\n`);
  };
}

async function runInstalledInit(target, options) {
  if (options.profile && (options.model || options.effort)) {
    throw new Error("--profile is mutually exclusive with --model and --effort");
  }
  const selection = await persistBootstrapSelection(target, {
    profile: options.profile,
    model: options.model,
    effort: options.effort
  });
  const migrations = await inspectPendingMigrations(target);
  if (migrations.pending.length > 0) {
    return {
      schema: "assistant.init-result/v1",
      target,
      mode: "existing-resume",
      initialization_status: "awaiting_user_input",
      selection,
      completion: {
        schema: "assistant.initialization-completion/v1",
        initialization_status: "awaiting_user_input",
        readiness: "system_migration_required",
        migrations
      }
    };
  }
  const statePath = path.join(
    target,
    ".assistant",
    "internal",
    "bootstrap",
    "state.json"
  );
  const state = JSON.parse(await readFile(statePath, "utf8"));
  if (state.closed_book_validated === true) {
    return {
      schema: "assistant.init-result/v1",
      target,
      mode: "existing-resume",
      initialization_status: state.status,
      completion: {
        schema: "assistant.initialization-completion/v1",
        initialization_status: state.status,
        readiness: state.status,
        next: "Assistant initialization is complete; continue normal project work"
      }
    };
  }
  if (state.semantic_survey_complete === true) {
    const completion = state.status === "awaiting_user_input"
      ? {
          schema: "assistant.initialization-completion/v1",
          initialization_status: "awaiting_user_input",
          readiness: "bootstrap_decision_required"
        }
      : await finalizeInstalledProject(target, {
          initializationStatus: state.status
        });
    return {
      schema: "assistant.init-result/v1",
      target,
      mode: "existing-resume",
      initialization_status: state.status,
      completion
    };
  }
  const semantic = await runSemanticBootstrap(target, {
    ...selection,
    timeoutSeconds: options["timeout-seconds"],
    onProgress: progressReporter()
  });
  const completion = semantic.status === "awaiting_user_input"
    ? {
        schema: "assistant.initialization-completion/v1",
        initialization_status: "awaiting_user_input",
        readiness: "bootstrap_decision_required"
      }
    : await finalizeInstalledProject(target, {
        initializationStatus: semantic.status
      });
  return {
    schema: "assistant.init-result/v1",
    target,
    mode: "existing-resume",
    initialization_status: semantic.status,
    semantic,
    completion
  };
}

async function main() {
  const { command, options } = parse(process.argv.slice(2));
  const target = path.resolve(options.target || process.cwd());
  const jsonOutput = options.json === true;
  if (command === "init") {
    printResult(await runInstalledInit(target, options), jsonOutput);
    return;
  }
  if (command === "validate") {
    const result = await validateProject(target);
    printResult(result, jsonOutput);
    if (!result.valid) process.exitCode = 2;
    return;
  }
  if (command === "bootstrap-resolve") {
    if (!options.input) throw new Error("bootstrap-resolve requires --input");
    const resolution = JSON.parse(
      await readFile(path.resolve(options.input), "utf8")
    );
    printResult(
      await resolveBootstrap(target, resolution, {
        confirmed: options.confirm === true
      }),
      jsonOutput
    );
    return;
  }
  if (command === "bootstrap-deferred") {
    const result = options.claim
      ? await claimDeferredRequest(target)
      : options.complete
        ? await completeDeferredRequest(target)
        : await inspectDeferredRequest(target);
    printResult(result, jsonOutput);
    return;
  }
  if (command === "route") {
    if (!options.task) throw new Error("route requires --task");
    const loaded = await loadCanonicalNodes(target);
    if (loaded.findings.some((item) => item.severity === "error")) {
      throw new Error(JSON.stringify(loaded.findings));
    }
    const entityIds =
      typeof options.entity === "string"
        ? options.entity.split(",").map((item) => item.trim()).filter(Boolean)
        : [];
    printResult(routeTask(loaded.nodes, options.task, { entityIds }), jsonOutput);
    return;
  }
  if (command === "policy") {
    if (!options["side-effect"]) throw new Error("policy requires --side-effect");
    const content = await readFile(path.join(target, ".assistant", "POLICY.md"), "utf8");
    const manifest = JSON.parse(
      await readFile(path.join(target, ".assistant", "manifest.json"), "utf8")
    );
    printResult(
      resolvePolicy(content, options["side-effect"], null, {
        profile: manifest.profile
      }),
      jsonOutput
    );
    return;
  }
  if (command === "structure") {
    printResult(
      options.apply
        ? await maintainStructure(target)
        : await inspectStructure(target),
      jsonOutput
    );
    return;
  }
  if (command === "episode") {
    if (!options["work-id"] || !options["episode-id"]) {
      throw new Error("episode requires --work-id and --episode-id");
    }
    printResult(
      await authorizeTerminalEpisode(target, {
        workId: options["work-id"],
        episodeId: options["episode-id"],
        locale: options.locale
      }),
      jsonOutput
    );
    return;
  }
  if (command === "locale") {
    if (!options.set) throw new Error("locale requires --set <BCP-47-tag>");
    printResult(
      await setProjectLocale(target, options.set, {
        confirmed: options.confirm === true
      }),
      jsonOutput
    );
    return;
  }
  if (command === "migration") {
    let result = options["complete-agents"]
      ? await completeAgentsControlPlaneMigration(target, {
          confirmed: options.confirm === true
        })
      : options["complete-codex-config"]
        ? await completeCodexConfigMigration(target, {
            confirmed: options.confirm === true
          })
        : typeof options["replace-skill"] === "string"
          ? await replacePendingSkillMigration(target, options["replace-skill"], {
              confirmed: options.confirm === true
            })
          : await inspectPendingMigrations(target);
    if (
      result.schema === "assistant.migration-status/v1" &&
      result.pending.length > 0
    ) {
      const selectionPath = path.join(
        target,
        ".assistant",
        "internal",
        "bootstrap",
        "selection.json"
      );
      try {
        result = {
          ...result,
          selection: JSON.parse(await readFile(selectionPath, "utf8")).selection
        };
      } catch {
        result = {
          ...result,
          selection: {
            profile: null,
            model: "gpt-5.6-sol",
            effort: "high"
          }
        };
      }
    }
    printResult(result, jsonOutput);
    return;
  }
  if (command === "transaction-stage") {
    if (!options.input) throw new Error("transaction-stage requires --input");
    const specification = JSON.parse(
      await readFile(path.resolve(options.input), "utf8")
    );
    printResult(await stageCanonicalUpdate(target, specification), jsonOutput);
    return;
  }
  if (command === "transaction-commit") {
    if (!options.id) throw new Error("transaction-commit requires --id");
    printResult(
      await commitCanonicalUpdate(target, options.id, {
        confirmed: options.confirm === true
      }),
      jsonOutput
    );
    return;
  }
  if (command === "doctor") {
    printResult(await doctorProject(target), jsonOutput);
    return;
  }
  process.stdout.write(
    "Usage: assistant init [--profile <name> | --model <id> --effort <level>] | " +
    "validate | bootstrap-resolve --input <json> [--confirm] | " +
    "bootstrap-deferred [--claim | --complete] | route --task <type> " +
    "[--entity <ids>] | policy --side-effect <class> | " +
    "locale --set <tag> [--confirm] | migration [--complete-agents --confirm | " +
    "--complete-codex-config --confirm | --replace-skill <name> --confirm] | " +
    "structure [--apply]\n"
  );
}

main().catch((error) => {
  process.stderr.write(`assistant: ${error.message}\n`);
  if (process.argv[2] === "init") {
    const targetIndex = process.argv.indexOf("--target");
    const target = path.resolve(
      targetIndex >= 0 ? process.argv[targetIndex + 1] : process.cwd()
    );
    const installed = path.join(
      target,
      ".assistant",
      "system",
      process.platform === "win32" ? "assistant.cmd" : "assistant"
    );
    const command = process.platform === "win32"
      ? `& ${shellTarget(installed)} init --target ${shellTarget(target)}`
      : `${shellTarget(installed)} init --target ${shellTarget(target)}`;
    process.stderr.write(
      "Assistant initialization remains incomplete; ordinary project work is not blocked.\n" +
      `Continue the persisted attempt with: ${command}\n`
    );
  }
  process.exitCode = 1;
});
