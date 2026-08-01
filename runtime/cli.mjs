#!/usr/bin/env node
import path from "node:path";
import { activateBootstrap } from "./lib/activation.mjs";
import { authorizeTerminalEpisode } from "./lib/episode.mjs";
import { doctorProject } from "./lib/doctor.mjs";
import {
  persistBootstrapSelection,
  recoverRejectedBootstrap,
  runSemanticBootstrap
} from "./lib/bootstrap.mjs";
import { prepareBootstrapRetry } from "./lib/bootstrap-retry.mjs";
import { pathExists, readUtf8 } from "./lib/files.mjs";
import { initializeProject } from "./lib/installer.mjs";
import { finalizeInstalledProject } from "./lib/initialization.mjs";
import {
  exportAssistant,
  purgeAssistant,
  uninstallAssistant
} from "./lib/lifecycle.mjs";
import { updateAssistant } from "./lib/updater.mjs";
import { loadCanonicalNodes, validateProject } from "./lib/validator.mjs";
import { resolvePolicy } from "./lib/policy.mjs";
import { preflightInitialization } from "./lib/preflight.mjs";
import { setProjectLocale } from "./lib/locale.mjs";
import {
  completeAgentsControlPlaneMigration,
  completeCodexConfigMigration,
  inspectPendingMigrations,
  markPendingMigrationRequired,
  replacePendingSkillMigration
} from "./lib/migration.mjs";
import { routeTask } from "./lib/router.mjs";
import { inspectStructure, maintainStructure } from "./lib/structure.mjs";
import {
  commitCanonicalUpdate,
  stageCanonicalUpdate
} from "./lib/transaction.mjs";

function parseArguments(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index];
    if (value === "-p") {
      const next = rest[index + 1];
      if (next === undefined || next.startsWith("-")) {
        throw new Error("missing value for -p");
      }
      options.profile = next;
      index += 1;
      continue;
    }
    if (!value.startsWith("--")) {
      (options._ ??= []).push(value);
      continue;
    }
    const key = value.slice(2);
    const next = rest[index + 1];
    if (next === undefined || next.startsWith("--")) {
      options[key] = true;
    } else {
      if (key === "source") {
        (options.source ??= []).push(next);
      } else {
        options[key] = next;
      }
      index += 1;
    }
  }
  return { command, options };
}

function requireOption(options, name) {
  const value = options[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`missing --${name}`);
  }
  return value;
}

let jsonOutput = false;
let activeCommand = null;
let activeTarget = null;

function shellTarget(target) {
  return /\s/u.test(target) ? `"${target}"` : target;
}

function humanResult(value) {
  if (value.schema === "assistant.lifecycle-preview/v1") {
    const label = value.operation === "purge" ? "Purge" : "Uninstall";
    const lines = [
      `${label} ${value.status} for ${value.target}.`,
      `Remove: ${value.remove.join(", ") || "nothing"}.`,
      `Preserve: ${value.preserve.join(", ")}.`
    ];
    if (value.conflicts.length) lines.push(`Conflicts: ${value.conflicts.join("; ")}.`);
    if (value.status === "preview" && value.conflicts.length === 0) {
      lines.push(
        `No changes made. Run: assistant ${value.operation} --target ${shellTarget(value.target)} --confirm`
      );
    }
    return lines.join("\n");
  }
  if (value.schema === "assistant.export-result/v1") {
    return `Assistant state exported to ${value.output} (${value.files} files).`;
  }
  if (value.schema === "assistant.model-confirmation/v1") {
    return [
      "Initialization has not changed the project.",
      value.notice,
      `Evidence packet: about ${value.packet_bytes ?? "unknown"} bytes; token cost cannot be predicted reliably.`,
      `Continue with: ${value.resume_command}`
    ].join("\n");
  }
  if (value.schema === "assistant.init-result/v1") {
    const completion = value.completion ?? {};
    const semantic = value.semantic ?? {};
    const status = completion.initialization_status ?? value.initialization_status;
    const lines = [
      `Initialization status: ${status}.`,
      `Mode: ${value.mode ?? "unknown"}.`
    ];
    if (semantic.schema) {
      lines.push(
        `Semantic result: ${semantic.candidate_nodes ?? 0} canonical candidates, ` +
        `${semantic.gaps ?? 0} gaps, ${semantic.conflicts ?? 0} conflicts, ` +
        `${semantic.tokens_used ?? "unknown"} tokens.`
      );
    }
    if (completion.readiness) lines.push(`Readiness: ${completion.readiness}.`);
    if (completion.readiness === "system_migration_required") {
      const selection = value.selection?.profile
        ? `Codex profile '${value.selection.profile}'`
        : `model '${value.selection?.model ?? "gpt-5.6-sol"}' with ` +
          `'${value.selection?.effort ?? "high"}' reasoning effort`;
      lines.push(
        "The assistant bootstrap is installed, but canonical activation is paused " +
        "until repository-native rules are reconciled."
      );
      lines.push(`Recommended for this initialization task: ${selection}.`);
      lines.push(`1. Change directory to: ${shellTarget(value.target)}`);
      lines.push("2. Open interactive Codex in that project root.");
      lines.push(
        '3. Send: "Continue Assistant initialization. Review the pending system ' +
        'migration, explain only the decisions I must make, apply my answers, and ' +
        'then resume initialization with the persisted model settings."'
      );
      lines.push(
        "Normal project work is not blocked; only reliance on Assistant-managed " +
        "canonical context is paused."
      );
    } else if (completion.next) {
      lines.push(`Next: ${completion.next}`);
    }
    return lines.join("\n");
  }
  if (value.schema === "assistant.validation/v1") {
    return value.valid
      ? `Validation passed (${value.summary?.nodes ?? 0} nodes).`
      : `Validation failed: ${value.summary?.errors ?? value.findings?.length ?? "unknown"} errors.`;
  }
  const lines = [
    `${value.schema ?? "assistant result"}: ${
      value.status ?? (value.valid === true ? "passed" : "completed")
    }.`
  ];
  if (Array.isArray(value.required)) {
    lines.push(`Required routes: ${value.required.length}.`);
  }
  if (Array.isArray(value.findings)) {
    lines.push(`Findings: ${value.findings.length}.`);
  }
  if (Array.isArray(value.conflicts)) {
    lines.push(`Conflicts: ${value.conflicts.length}.`);
  }
  if (typeof value.next === "string") lines.push(`Next: ${value.next}`);
  lines.push("Use --json for the complete machine payload.");
  return lines.join("\n");
}

function printJson(value) {
  process.stdout.write(
    jsonOutput ? `${JSON.stringify(value, null, 2)}\n` : `${humanResult(value)}\n`
  );
}

function progressReporter() {
  const started = Date.now();
  const remaining = {
    preflight: "install, evidence packet, semantic analysis, validation/finalization",
    install: "evidence packet, semantic analysis, validation/finalization",
    evidence_packet: "semantic analysis, validation/finalization",
    model_analysis: "validation/finalization (contract repair only if needed)",
    model_repair: "validation/finalization",
    semantic_complete: "validation/finalization",
    validation: "none"
  };
  return ({ phase, message, elapsed_seconds: elapsed, remaining: explicit }) => {
    const seconds = elapsed ?? Math.round((Date.now() - started) / 1000);
    const next = explicit ?? remaining[phase];
    const suffix = next ? `; remaining: ${next}` : "";
    process.stderr.write(`[assistant] ${phase} (${seconds}s): ${message}${suffix}\n`);
  };
}

function modelConfirmation(target, options, preflight = null) {
  const profile = typeof options.profile === "string" ? options.profile : null;
  const model = profile ? null : (options.model ?? "gpt-5.6-sol");
  const effort = profile ? null : (options.effort ?? "high");
  const selection = profile
    ? `Codex profile '${profile}'`
    : `model '${model}' with '${effort}' reasoning effort`;
  const forwarded = process.argv.slice(2).filter((item) => item !== "--yes");
  return {
    schema: "assistant.model-confirmation/v1",
    status: "confirmation_required",
    target,
    profile,
    model,
    effort,
    packet_bytes:
      preflight?.project?.projected_packet?.packet_bytes ?? null,
    notice:
      `For initialization quality, the assistant will use ${selection}. ` +
      "Existing-project bounded discovery and semantic analysis may consume " +
      "substantial tokens. " +
      "--yes confirms this cost notice only; it does not relax the read-only sandbox.",
    resume_command: `assistant ${forwarded.map((item) =>
      /\s/u.test(item) ? `"${item}"` : item
    ).join(" ")} --yes`
  };
}

async function bootstrapState(target) {
  const statePath = path.join(
    target,
    ".assistant",
    "internal",
    "bootstrap",
    "state.json"
  );
  if (!(await pathExists(statePath))) return null;
  return JSON.parse(await readUtf8(statePath));
}

function awaitingCompletion(initialized, semantic, preflight = null) {
  return {
    ...initialized,
    ...(preflight ? { preflight } : {}),
    semantic,
    completion: {
      schema: "assistant.initialization-completion/v1",
      initialization_status: "awaiting_user_input",
      readiness: "bootstrap_decision_required",
      next:
        "open Codex in the project root; resolve initialization before relying on assistant canonical context"
    }
  };
}

async function completeSemanticRun(target, initialized, semantic, preflight = null) {
  const migrations = await inspectPendingMigrations(target);
  if (migrations.pending.length > 0) {
    await markPendingMigrationRequired(target, migrations);
    return {
      ...initialized,
      ...(preflight ? { preflight } : {}),
      semantic,
      completion: {
        schema: "assistant.initialization-completion/v1",
        initialization_status: "awaiting_user_input",
        readiness: "system_migration_required",
        migrations,
        next:
          "resolve each staged system migration, then rerun assistant init for the same target"
      }
    };
  }
  if (semantic.status === "awaiting_user_input") {
    return awaitingCompletion(initialized, semantic, preflight);
  }
  const completion = await finalizeInstalledProject(target, {
    initializationStatus: semantic.status
  });
  return {
    ...initialized,
    ...(preflight ? { preflight } : {}),
    semantic,
    completion
  };
}

async function pendingMigrationCompletion(
  target,
  initialized,
  selection,
  preflight = null
) {
  const migrations = await inspectPendingMigrations(target);
  if (migrations.pending.length === 0) return null;
  await markPendingMigrationRequired(target, migrations);
  return {
    ...initialized,
    ...(preflight ? { preflight } : {}),
    selection,
    completion: {
      schema: "assistant.initialization-completion/v1",
      initialization_status: "awaiting_user_input",
      readiness: "system_migration_required",
      migrations,
      next:
        "open interactive Codex in the target project root and resolve the pending system migration before semantic analysis"
    }
  };
}

async function main() {
  const { command, options } = parseArguments(process.argv.slice(2));
  activeCommand = command;
  jsonOutput = options.json === true;
  if (!command || command === "help" || command === "--help" || options.help) {
    process.stdout.write(
      "Usage:\n" +
      "  assistant init --target <path>\n" +
      "    [--profile <name> | -p <name> | --model <id> --effort <level>]\n" +
      "    [--source <path>] [--yes | --allow-large-project]\n" +
      "    [--json]\n" +
      "  assistant uninstall --target <path> [--confirm] [--json]\n" +
      "  assistant export --target <path> --output <path> [--json]\n" +
      "  assistant purge --target <path> [--confirm] [--json]\n" +
      "  assistant update --target <path> [--json]\n" +
      "  assistant bootstrap --target <path>\n" +
      "  assistant bootstrap-recover --target <path> --rejected <id>\n" +
      "  assistant activate --target <path>\n" +
      "  assistant validate --target <path>\n" +
      "  assistant route --target <path> --task <task-type>\n" +
      "  assistant policy --target <path> --side-effect <class>\n"
      + "  assistant structure --target <path> [--apply]\n"
      + "  assistant episode --target <path> --work-id <id> --episode-id <id>\n"
      + "  assistant locale --target <path> --set <BCP-47-tag> [--confirm]\n"
      + "  assistant migration --target <path> [--complete-agents --confirm | --complete-codex-config --confirm | --replace-skill <name> --confirm]\n"
      + "  assistant transaction-stage --target <path> --input <json>\n"
      + "  assistant transaction-commit --target <path> --id <id> [--confirm]\n"
      + "  assistant doctor --target <path>\n"
    );
    return;
  }

  const target = path.resolve(requireOption(options, "target"));
  activeTarget = target;
  const progress = progressReporter();
  if (command === "init") {
    if (
      options.profile &&
      (options.model || options.effort)
    ) {
      throw new Error("--profile is mutually exclusive with --model and --effort");
    }
    const priorState = await bootstrapState(target);
    if (priorState) {
      if ((options.source ?? []).length > 0) {
        throw new Error("cannot add --source while resuming an installed bootstrap");
      }
      const resumed = {
        schema: "assistant.init-result/v1",
        target,
        mode: "existing-resume",
        initialization_status: priorState.status
      };
      const selection = await persistBootstrapSelection(target, {
        profile: options.profile,
        model: options.model,
        effort: options.effort
      });
      const migration = await pendingMigrationCompletion(
        target,
        resumed,
        selection
      );
      if (migration) {
        printJson(migration);
        return;
      }
      if (options["restart-semantic"] === true) {
        const retry = await prepareBootstrapRetry(
          target,
          typeof options.reason === "string"
            ? options.reason
            : "explicit semantic bootstrap retry"
        );
        resumed.retry = retry;
        Object.assign(priorState, await bootstrapState(target));
      }
      if (priorState.closed_book_validated === true) {
        throw new Error("target is already initialized and closed-book validated");
      }
      if (
        priorState.semantic_survey_complete === true &&
        priorState.status === "awaiting_user_input"
      ) {
        printJson(
          awaitingCompletion(resumed, {
            schema: "assistant.semantic-bootstrap-result/v1",
            target,
            status: "awaiting_user_input",
            critical_gaps: priorState.critical_gap_ids?.length ?? 0,
            material_conflicts:
              priorState.material_conflict_ids?.length ?? 0
          })
        );
        return;
      }
      if (priorState.semantic_survey_complete === true) {
        const completion = await finalizeInstalledProject(target, {
          initializationStatus: "bootstrap_incomplete"
        });
        printJson({ ...resumed, completion });
        return;
      }
      if (options.yes !== true) {
        printJson(modelConfirmation(target, options));
        process.exitCode = 3;
        return;
      }
      const semantic = await runSemanticBootstrap(target, {
        profile: options.profile,
        model: options.model,
        effort: options.effort,
        onProgress: progress,
        timeoutSeconds: options["timeout-seconds"]
      });
      progress({ phase: "validation", message: "Validating and finalizing assistant state" });
      printJson(await completeSemanticRun(target, resumed, semantic));
      return;
    }
    progress({
      phase: "preflight",
      message: "Inspecting project without modification",
      remaining: options["deterministic-only"] === true
        ? "install, validation/finalization"
        : "cost confirmation, install, evidence packet, semantic analysis, validation/finalization"
    });
    const preflight = await preflightInitialization(target, {
      sources: options.source ?? []
    });
    if (preflight.status === "unsupported_source_size") {
      printJson({
        schema: "assistant.init-result/v1",
        target,
        initialization_status: "not_started",
        readiness: "source_reduction_required",
        preflight
      });
      process.exitCode = 4;
      return;
    }
    if (
      preflight.status === "confirmation_required" &&
      options["allow-large-project"] !== true &&
      options.yes !== true
    ) {
      printJson({
        schema: "assistant.init-result/v1",
        target,
        initialization_status: "not_started",
        readiness: "size_confirmation_required",
        preflight
      });
      process.exitCode = 3;
      return;
    }
    const existingProject = preflight.project?.paths > 0;
    if (
      existingProject &&
      options["deterministic-only"] !== true &&
      options.yes !== true
    ) {
      printJson(modelConfirmation(target, options, preflight));
      process.exitCode = 3;
      return;
    }
    progress({
      phase: "install",
      message: "Installing local assistant bootstrap assets",
      remaining: existingProject && options["deterministic-only"] !== true
        ? "evidence packet, semantic analysis, validation/finalization"
        : "validation/finalization"
    });
    const initialized = await initializeProject(target, {
      sources: options.source ?? []
    });
    if (options["deterministic-only"]) {
      printJson({ ...initialized, preflight });
      return;
    }
    if (initialized.mode === "blank") {
      progress({ phase: "validation", message: "Validating and finalizing blank assistant state" });
      const completion = await finalizeInstalledProject(target, {
        initializationStatus: initialized.initialization_status
      });
      printJson({ ...initialized, preflight, completion });
      return;
    }
    const selection = await persistBootstrapSelection(target, {
      profile: options.profile,
      model: options.model,
      effort: options.effort
    });
    const migration = await pendingMigrationCompletion(
      target,
      initialized,
      selection,
      preflight
    );
    if (migration) {
      printJson(migration);
      return;
    }
    const semantic = await runSemanticBootstrap(target, {
      profile: options.profile,
      model: options.model,
      effort: options.effort,
      onProgress: progress,
      timeoutSeconds: options["timeout-seconds"]
    });
    progress({ phase: "validation", message: "Validating and finalizing assistant state" });
    if (semantic.status === "awaiting_user_input") {
      printJson(await completeSemanticRun(target, initialized, semantic, preflight));
      return;
    }
    printJson(await completeSemanticRun(target, initialized, semantic, preflight));
    return;
  }
  if (command === "bootstrap") {
    if (
      options.profile &&
      (options.model || options.effort)
    ) {
      throw new Error("--profile is mutually exclusive with --model and --effort");
    }
    if (options.restart === true) {
      await prepareBootstrapRetry(
        target,
        typeof options.reason === "string"
          ? options.reason
          : "explicit semantic bootstrap retry"
      );
    }
    if (options.yes !== true) {
      printJson(modelConfirmation(target, options));
      process.exitCode = 3;
      return;
    }
    const semantic = await runSemanticBootstrap(target, {
      profile: options.profile,
      model: options.model,
      effort: options.effort,
      onProgress: progress,
      timeoutSeconds: options["timeout-seconds"]
    });
    progress({ phase: "validation", message: "Validating and finalizing assistant state" });
    printJson(
      await completeSemanticRun(
        target,
        {
          schema: "assistant.init-result/v1",
          target,
          mode: "existing-resume",
          initialization_status: semantic.status
        },
        semantic
      )
    );
    return;
  }
  if (command === "bootstrap-recover") {
    const semantic = await recoverRejectedBootstrap(
      target,
      requireOption(options, "rejected")
    );
    printJson(
      await completeSemanticRun(
        target,
        {
          schema: "assistant.init-result/v1",
          target,
          mode: "existing-recovery",
          initialization_status: semantic.status
        },
        semantic
      )
    );
    return;
  }
  if (command === "uninstall") {
    printJson(await uninstallAssistant(target, {
      confirmed: options.confirm === true
    }));
    return;
  }
  if (command === "export") {
    printJson(
      await exportAssistant(target, path.resolve(requireOption(options, "output")))
    );
    return;
  }
  if (command === "purge") {
    printJson(await purgeAssistant(target, {
      confirmed: options.confirm === true
    }));
    return;
  }
  if (command === "update") {
    printJson(await updateAssistant(target, { force: options.force === true }));
    return;
  }
  if (command === "activate") {
    printJson(await activateBootstrap(target));
    return;
  }
  if (command === "validate") {
    const result = await validateProject(target);
    printJson(result);
    if (!result.valid) process.exitCode = 2;
    return;
  }
  if (command === "route") {
    const taskType = requireOption(options, "task");
    const loaded = await loadCanonicalNodes(target);
    if (loaded.findings.some((item) => item.severity === "error")) {
      printJson({ status: "invalid", findings: loaded.findings });
      process.exitCode = 2;
      return;
    }
    const entityIds =
      typeof options.entity === "string"
        ? options.entity.split(",").map((item) => item.trim()).filter(Boolean)
        : [];
    printJson(routeTask(loaded.nodes, taskType, { entityIds }));
    return;
  }
  if (command === "policy") {
    const sideEffect = requireOption(options, "side-effect");
    const policyPath = path.join(target, ".assistant", "POLICY.md");
    const manifest = JSON.parse(
      await readUtf8(path.join(target, ".assistant", "manifest.json"))
    );
    printJson(
      resolvePolicy(await readUtf8(policyPath), sideEffect, null, {
        profile: manifest.profile
      })
    );
    return;
  }
  if (command === "structure") {
    printJson(
      options.apply
        ? await maintainStructure(target)
        : await inspectStructure(target)
    );
    return;
  }
  if (command === "episode") {
    printJson(
      await authorizeTerminalEpisode(target, {
        workId: requireOption(options, "work-id"),
        episodeId: requireOption(options, "episode-id"),
        locale: options.locale
      })
    );
    return;
  }
  if (command === "locale") {
    printJson(
      await setProjectLocale(target, requireOption(options, "set"), {
        confirmed: options.confirm === true
      })
    );
    return;
  }
  if (command === "migration") {
    printJson(
      options["complete-agents"] === true
        ? await completeAgentsControlPlaneMigration(target, {
            confirmed: options.confirm === true
          })
        : options["complete-codex-config"] === true
        ? await completeCodexConfigMigration(target, {
            confirmed: options.confirm === true
          })
        : typeof options["replace-skill"] === "string"
          ? await replacePendingSkillMigration(
              target,
              options["replace-skill"],
              { confirmed: options.confirm === true }
            )
        : await inspectPendingMigrations(target)
    );
    return;
  }
  if (command === "transaction-stage") {
    const input = JSON.parse(
      await readUtf8(path.resolve(requireOption(options, "input")))
    );
    printJson(await stageCanonicalUpdate(target, input));
    return;
  }
  if (command === "transaction-commit") {
    printJson(
      await commitCanonicalUpdate(
        target,
        requireOption(options, "id"),
        { confirmed: options.confirm === true }
      )
    );
    return;
  }
  if (command === "doctor") {
    printJson(await doctorProject(target));
    return;
  }
  throw new Error(`unknown command: ${command}`);
}

main().catch(async (error) => {
  process.stderr.write(`assistant: ${error.message}\n`);
  if (
    activeTarget &&
    ["init", "bootstrap", "bootstrap-recover"].includes(activeCommand)
  ) {
    const installed = path.join(
      activeTarget,
      ".assistant",
      "system",
      process.platform === "win32" ? "assistant.cmd" : "assistant"
    );
    if (await pathExists(installed)) {
      const command = process.platform === "win32"
        ? `& ${shellTarget(installed)} init --target ${shellTarget(activeTarget)}`
        : `${shellTarget(installed)} init --target ${shellTarget(activeTarget)}`;
      process.stderr.write(
        "Assistant initialization is incomplete; ordinary project work is not blocked.\n" +
        `Continue the persisted attempt with: ${command}\n`
      );
    } else {
      process.stderr.write(
        "Initialization did not install a resumable target runtime. Correct the " +
        "reported cause, then rerun the original init command.\n"
      );
    }
  }
  process.exitCode = 1;
});
