#!/usr/bin/env node
import path from "node:path";
import { readFile } from "node:fs/promises";
import { authorizeTerminalEpisode } from "../lib/episode.mjs";
import { resolveBootstrap } from "../lib/bootstrap-resolution.mjs";
import {
  claimDeferredRequest,
  completeDeferredRequest,
  inspectDeferredRequest
} from "../lib/deferred.mjs";
import { doctorProject } from "../lib/doctor.mjs";
import { resolvePolicy } from "../lib/policy.mjs";
import { routeTask } from "../lib/router.mjs";
import { loadCanonicalNodes, validateProject } from "../lib/validator.mjs";
import { inspectStructure, maintainStructure } from "../lib/structure.mjs";
import { setProjectLocale } from "../lib/locale.mjs";
import {
  completeAgentsControlPlaneMigration,
  completeCodexConfigMigration,
  inspectPendingMigrations,
  replacePendingSkillMigration
} from "../lib/migration.mjs";
import {
  commitCanonicalUpdate,
  stageCanonicalUpdate
} from "../lib/transaction.mjs";

function parse(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const item = rest[index];
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

async function main() {
  const { command, options } = parse(process.argv.slice(2));
  const target = path.resolve(options.target || process.cwd());
  if (command === "validate") {
    const result = await validateProject(target);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.valid) process.exitCode = 2;
    return;
  }
  if (command === "bootstrap-resolve") {
    if (!options.input) {
      throw new Error("bootstrap-resolve requires --input");
    }
    const resolution = JSON.parse(
      await readFile(path.resolve(options.input), "utf8")
    );
    const result = await resolveBootstrap(target, resolution, {
      confirmed: options.confirm === true
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (command === "bootstrap-deferred") {
    const result = options.claim
      ? await claimDeferredRequest(target)
      : options.complete
        ? await completeDeferredRequest(target)
        : await inspectDeferredRequest(target);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
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
    process.stdout.write(
      `${JSON.stringify(routeTask(loaded.nodes, options.task, { entityIds }), null, 2)}\n`
    );
    return;
  }
  if (command === "policy") {
    if (!options["side-effect"]) throw new Error("policy requires --side-effect");
    const content = await readFile(path.join(target, ".assistant", "POLICY.md"), "utf8");
    const manifest = JSON.parse(
      await readFile(path.join(target, ".assistant", "manifest.json"), "utf8")
    );
    process.stdout.write(
      `${JSON.stringify(
        resolvePolicy(content, options["side-effect"], null, {
          profile: manifest.profile
        }),
        null,
        2
      )}\n`
    );
    return;
  }
  if (command === "structure") {
    const result = options.apply
      ? await maintainStructure(target)
      : await inspectStructure(target);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (command === "episode") {
    if (!options["work-id"] || !options["episode-id"]) {
      throw new Error("episode requires --work-id and --episode-id");
    }
    const result = await authorizeTerminalEpisode(target, {
      workId: options["work-id"],
      episodeId: options["episode-id"],
      locale: options.locale
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (command === "locale") {
    if (!options.set) throw new Error("locale requires --set <BCP-47-tag>");
    const result = await setProjectLocale(target, options.set, {
      confirmed: options.confirm === true
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (command === "migration") {
    const result = options["complete-agents"]
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
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (command === "transaction-stage") {
    if (!options.input) throw new Error("transaction-stage requires --input");
    const specification = JSON.parse(
      await readFile(path.resolve(options.input), "utf8")
    );
    const result = await stageCanonicalUpdate(target, specification);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (command === "transaction-commit") {
    if (!options.id) throw new Error("transaction-commit requires --id");
    const result = await commitCanonicalUpdate(target, options.id, {
      confirmed: options.confirm === true
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (command === "doctor") {
    const result = await doctorProject(target);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  process.stdout.write(
    "Usage: assistant validate | bootstrap-resolve --input <json> [--confirm] | " +
    "bootstrap-deferred [--claim | --complete] | " +
    "route --task <type> [--entity <ids>] | " +
    "policy --side-effect <class> | locale --set <tag> [--confirm] | " +
    "migration [--complete-codex-config --confirm | --replace-skill <name> --confirm] | " +
    "structure [--apply]\n"
  );
}

main().catch((error) => {
  process.stderr.write(`assistant: ${error.message}\n`);
  process.exitCode = 1;
});
