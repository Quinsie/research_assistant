#!/usr/bin/env node
import path from "node:path";
import { activateBootstrap } from "./lib/activation.mjs";
import { authorizeTerminalEpisode } from "./lib/episode.mjs";
import { doctorProject } from "./lib/doctor.mjs";
import {
  recoverRejectedBootstrap,
  runSemanticBootstrap
} from "./lib/bootstrap.mjs";
import { prepareBootstrapRetry } from "./lib/bootstrap-retry.mjs";
import { pathExists, readUtf8 } from "./lib/files.mjs";
import { initializeProject } from "./lib/installer.mjs";
import { finalizeInstalledProject } from "./lib/initialization.mjs";
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

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
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
        "open Codex in the project root; initialization questions take precedence over normal work"
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

async function main() {
  const { command, options } = parseArguments(process.argv.slice(2));
  if (!command || command === "help" || options.help) {
    process.stdout.write(
      "Usage:\n" +
      "  assistant init --target <path>\n" +
      "    [--profile <name> | -p <name> | --model <id> --effort <level>]\n" +
      "    [--source <path>] [--yes | --allow-large-project]\n" +
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
      const semantic = await runSemanticBootstrap(target, {
        profile: options.profile,
        model: options.model,
        effort: options.effort
      });
      printJson(await completeSemanticRun(target, resumed, semantic));
      return;
    }
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
    const initialized = await initializeProject(target, {
      sources: options.source ?? []
    });
    if (options["deterministic-only"]) {
      printJson({ ...initialized, preflight });
      return;
    }
    if (initialized.mode === "blank") {
      const completion = await finalizeInstalledProject(target, {
        initializationStatus: initialized.initialization_status
      });
      printJson({ ...initialized, preflight, completion });
      return;
    }
    const semantic = await runSemanticBootstrap(target, {
      profile: options.profile,
      model: options.model,
      effort: options.effort
    });
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
    const semantic = await runSemanticBootstrap(target, {
      profile: options.profile,
      model: options.model,
      effort: options.effort
    });
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

main().catch((error) => {
  process.stderr.write(`assistant: ${error.message}\n`);
  process.exitCode = 1;
});
