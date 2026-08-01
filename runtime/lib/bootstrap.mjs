import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  repairDeterministicBootstrapRelations,
  validateBootstrapOutput,
  validateBootstrapRepair
} from "./bootstrap-contract.mjs";
import { discoverCodexInvocation } from "./codex.mjs";
import { buildEvidencePacket } from "./evidence-packet.mjs";
import { pathExists, writeUtf8 } from "./files.mjs";
import { parseNodeDocument, serializeNodeDocument } from "./meta.mjs";

const runtimeDirectory = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(runtimeDirectory, "..", "..");
const promptPath = path.join(
  packageRoot,
  "runtime",
  "prompts",
  "bootstrap-existing-v1.md"
);
const schemaPath = path.join(
  packageRoot,
  "runtime",
  "schemas",
  "bootstrap-output.schema.json"
);

export { discoverCodexInvocation, validateBootstrapOutput };

async function stageBootstrapOutput(
  target,
  output,
  invocation,
  packetMetrics,
  runMetrics
) {
  const root = path.resolve(target);
  const bootstrapRoot = path.join(root, ".assistant", "internal", "bootstrap");
  const stagingRoot = path.join(bootstrapRoot, "staging");
  await mkdir(stagingRoot, { recursive: true });
  await writeUtf8(
    path.join(bootstrapRoot, "model-result.json"),
    `${JSON.stringify(output, null, 2)}\n`
  );

  for (const node of output.candidate_nodes) {
    const metadata = {
      schema: "assistant.node/v1",
      id: node.id,
      type: node.type,
      status: node.status,
      authority: "candidate_unintegrated",
      relations: node.relations,
      verified_at: new Date().toISOString(),
      evidence_paths: node.evidence_paths,
      legacy_aliases: node.legacy_aliases,
      certainty: node.certainty
    };
    const semanticBody = (node.semantic_sections ?? [])
      .map((section) => `### ${section.heading}\n\n${section.content.trim()}`)
      .join("\n\n");
    const body = `# ${node.title}\n\n${semanticBody || node.body.trim()}\n`;
    await writeUtf8(
      path.join(stagingRoot, `${node.id}.md`),
      serializeNodeDocument(metadata, body)
    );
  }

  await writeUtf8(
    path.join(bootstrapRoot, "run.json"),
    `${JSON.stringify({
      schema: "assistant.bootstrap-run/v1",
      prompt_version: "bootstrap-existing-v1",
      output_schema: "assistant.bootstrap-output/v1",
      invocation_kind: invocation.kind,
      evidence_packet: packetMetrics,
      execution: runMetrics,
      completed_at: new Date().toISOString()
    }, null, 2)}\n`
  );
}

async function preserveRejectedBootstrap(
  target,
  output,
  findings,
  runMetrics,
  label
) {
  const rejectionId = `REJ-${randomUUID()}`;
  const destination = path.join(
    path.resolve(target),
    ".assistant",
    "internal",
    "bootstrap",
    "rejected",
    rejectionId
  );
  await mkdir(destination, { recursive: true });
  await writeFile(
    path.join(destination, "model-result.json"),
    `${JSON.stringify(output, null, 2)}\n`,
    "utf8"
  );
  await writeFile(
    path.join(destination, "rejection.json"),
    `${JSON.stringify({
      schema: "assistant.bootstrap-rejection/v1",
      id: rejectionId,
      label,
      findings,
      execution: runMetrics,
      rejected_at: new Date().toISOString()
    }, null, 2)}\n`,
    "utf8"
  );
  return rejectionId;
}

async function updatePersistentBootstrapStatus(target, output) {
  const root = path.resolve(target);
  const critical = output.gaps.filter(
    (gap) => gap.blocking_level === "initialization"
  );
  const materialConflicts = output.conflicts.filter((conflict) => conflict.material);
  const status =
    critical.length > 0 || materialConflicts.length > 0
      ? "awaiting_user_input"
      : "bootstrap_incomplete";

  const manifestPath = path.join(root, ".assistant", "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.initialization_status = status;
  manifest.activity_status = status === "awaiting_user_input" ? "blocked" : "paused";
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  const currentPath = path.join(root, ".assistant", "CURRENT.md");
  const current = parseNodeDocument(
    await readFile(currentPath, "utf8"),
    currentPath
  );
  current.metadata.initialization_status = status;
  current.metadata.activity_status = manifest.activity_status;
  current.metadata.active_work_id = "BOOTSTRAP-EXISTING";
  current.metadata.authorization =
    status === "awaiting_user_input" ? "blocked" : "active";
  current.metadata.verified_at = new Date().toISOString();
  const criticalIds = critical.map((gap) => gap.id);
  const conflictIds = materialConflicts.map((conflict) => conflict.id);
  const currentBody = `# Current state

- Initialization: \`${status}\`
- Activity: \`${manifest.activity_status}\`
- Active work: \`BOOTSTRAP-EXISTING\`
- Current authorization: canonical staging and bootstrap resolution only
- Blocked or unauthorized work: normal project work before activation
- Critical gap IDs: ${criticalIds.length > 0 ? criticalIds.map((id) => `\`${id}\``).join(", ") : "none"}
- Material conflict IDs: ${conflictIds.length > 0 ? conflictIds.map((id) => `\`${id}\``).join(", ") : "none"}
- Candidate route: \`.assistant/internal/bootstrap/staging/\`
- Last verified: \`${current.metadata.verified_at}\`

The semantic survey is staged but not active canonical knowledge. Resolve the
listed critical decisions, then resume validation and closed-book activation.
`;
  await writeFile(
    currentPath,
    serializeNodeDocument(current.metadata, currentBody),
    "utf8"
  );

  const statePath = path.join(
    root,
    ".assistant",
    "internal",
    "bootstrap",
    "state.json"
  );
  const state = JSON.parse(await readFile(statePath, "utf8"));
  state.phase = status === "awaiting_user_input" ? "bootstrapping" : "validating";
  state.status = status;
  state.semantic_survey_complete = true;
  state.closed_book_validated = false;
  state.critical_gap_ids = critical.map((gap) => gap.id);
  state.material_conflict_ids = materialConflicts.map((conflict) => conflict.id);
  state.updated_at = new Date().toISOString();
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  return status;
}

function spawnCodex(invocation, args, cwd, stdinContent) {
  return new Promise((resolve, reject) => {
    const child = spawn(invocation.command, [...invocation.prefixArgs, ...args], {
      cwd,
      stdio: ["pipe", "ignore", "pipe"],
      windowsHide: true
    });
    let stderr = "";
    let settled = false;
    const timeoutMs = 7 * 60 * 1000;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    const terminateTree = () =>
      new Promise((done) => {
        if (!child.pid) {
          done();
          return;
        }
        if (process.platform === "win32") {
          const killer = spawn(
            "taskkill.exe",
            ["/PID", String(child.pid), "/T", "/F"],
            { windowsHide: true, stdio: "ignore" }
          );
          killer.once("error", () => done());
          killer.once("close", () => done());
        } else {
          child.kill("SIGTERM");
          setTimeout(() => {
            if (child.exitCode === null) child.kill("SIGKILL");
            done();
          }, 2_000);
        }
      });
    const timer = setTimeout(async () => {
      await terminateTree();
      finish(
        reject,
        new Error(
          `codex exec timed out after ${timeoutMs}ms; bootstrap remains resumable`
        )
      );
    }, timeoutMs);
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (stderr.length > 1_000_000) {
        stderr = stderr.slice(-1_000_000);
      }
    });
    child.once("error", (error) => finish(reject, error));
    child.once("exit", (code, signal) => {
      const tokenMatch = stderr.match(/tokens used\s*\r?\n([\d,]+)/i);
      const metrics = {
        exit_code: code,
        signal: signal ?? null,
        tokens_used: tokenMatch
          ? Number.parseInt(tokenMatch[1].replaceAll(",", ""), 10)
          : null
      };
      if (code === 0) finish(resolve, metrics);
      else {
        const tail = stderr.split(/\r?\n/).slice(-20).join("\n");
        finish(
          reject,
          new Error(
            `codex exec failed with code=${code} signal=${signal ?? "none"}\n${tail}`
          )
        );
      }
    });
    child.stdin.end(stdinContent);
  });
}

export async function runSemanticBootstrap(target, options = {}) {
  const root = path.resolve(target);
  const manifest = JSON.parse(
    await readFile(path.join(root, ".assistant", "manifest.json"), "utf8")
  );
  const semanticProfile = manifest.profile ?? "research";
  const inventoryPath = path.join(
    root,
    ".assistant",
    "internal",
    "bootstrap",
    "inventory.json"
  );
  if (!(await pathExists(inventoryPath))) {
    throw new Error("deterministic bootstrap inventory is missing");
  }
  const inventory = JSON.parse(await readFile(inventoryPath, "utf8"));
  const sourceAuthorityPath = path.join(
    root,
    ".assistant",
    "internal",
    "bootstrap",
    "source-authority.json"
  );
  const sourceAuthority = (await pathExists(sourceAuthorityPath))
    ? JSON.parse(await readFile(sourceAuthorityPath, "utf8"))
    : null;
  const evidence = await buildEvidencePacket(root, inventory, {
    priorityPaths: sourceAuthority?.imported_paths ?? []
  });
  if (evidence.metrics.priority_omitted_files > 0) {
    throw new Error(
      "explicit initialization source exceeds the loss-aware bootstrap priority budget; " +
      "source chunking is required before activation"
    );
  }
  const invocation = await discoverCodexInvocation();
  const modelWorkspace = await mkdtemp(
    path.join(os.tmpdir(), "assistant-bootstrap-model-")
  );
  const outputPath = path.join(modelWorkspace, `model-output-${randomUUID()}.json`);
  let prompt = await readFile(promptPath, "utf8");
  if (sourceAuthority) {
    prompt += `\n\n## Runner-provided current instruction\n\n`;
    prompt +=
      "The user explicitly supplied the following exact paths to initialize canonical project knowledge. ";
    prompt +=
      "Treat source-grounded, non-conflicting project intent in them as current user-approved input. ";
    prompt +=
      "Do not ask whether these sources are intended for initialization. Existing-project material conflicts still require confirmation, and this does not authorize implementation or execution.\n\n";
    prompt +=
      "The explicit `--target` project root is the current authoritative root and outranks paths written inside a source. ";
    prompt +=
      "Treat source-internal absolute repository paths as environment references to map or verify, not as a material conflict with the selected target, unless the source meaning cannot be re-rooted without changing its approved scope.\n\n";
    for (const importedPath of sourceAuthority.imported_paths) {
      prompt += `- \`${importedPath}\`\n`;
    }
  }

  const args = [
    "--ask-for-approval",
    "never",
    "exec",
    "-C",
    modelWorkspace,
    "--sandbox",
    "read-only",
    "--skip-git-repo-check",
    "--ephemeral",
    "--output-schema",
    schemaPath,
    "--output-last-message",
    outputPath
  ];

  if (options.profile) {
    args.push("--profile", options.profile);
  } else {
    args.push("--model", options.model ?? "gpt-5.6-sol");
    args.push(
      "--config",
      `model_reasoning_effort="${options.effort ?? "high"}"`
    );
  }
  args.push(prompt);

  try {
    const initialRunMetrics = await spawnCodex(
      invocation,
      args,
      modelWorkspace,
      evidence.packet
    );
    let output = JSON.parse(await readFile(outputPath, "utf8"));
    let findings = validateBootstrapOutput(output, inventory, {
      profile: semanticProfile
    });
    let repairRunMetrics = null;
    let rejectedOutputId = null;
    if (findings.length > 0) {
      rejectedOutputId = await preserveRejectedBootstrap(
        root,
        output,
        findings,
        initialRunMetrics,
        "initial"
      );
      const deterministic = repairDeterministicBootstrapRelations(
        output,
        findings
      );
      if (deterministic.changes.length > 0) {
        const deterministicFindings = validateBootstrapOutput(
          deterministic.output,
          inventory,
          { profile: semanticProfile }
        );
        const deterministicRepairFindings = validateBootstrapRepair(
          output,
          deterministic.output,
          findings
        );
        if (
          deterministicFindings.length === 0 &&
          deterministicRepairFindings.length === 0
        ) {
          output = deterministic.output;
          findings = [];
          repairRunMetrics = {
            kind: "deterministic_relation_repair",
            tokens_used: 0,
            changes: deterministic.changes
          };
        }
      }
    }
    if (findings.length > 0) {
      const repairOutputPath = path.join(
        modelWorkspace,
        `model-repair-${randomUUID()}.json`
      );
      const repairArgs = [...args];
      repairArgs[repairArgs.indexOf(outputPath)] = repairOutputPath;
      repairArgs[repairArgs.length - 1] = `# Bootstrap contract repair

Return a complete object conforming to the supplied output schema.

Repair only the listed deterministic contract violations in the rejected
output supplied on stdin. Preserve all source-grounded semantic content,
candidate IDs, conditions, numeric values, coverage, gaps, and conflicts unless
the finding directly requires a structural change. Do not invent evidence.
Relations may target candidate node IDs only; gap and conflict IDs are not
canonical nodes. Remove or redirect an invalid relation only when the rejected
output itself establishes the correct candidate target.
`;
      repairRunMetrics = await spawnCodex(
        invocation,
        repairArgs,
        modelWorkspace,
        `${JSON.stringify({
          schema: "assistant.bootstrap-repair-input/v1",
          findings,
          rejected_output: output
        })}\n`
      );
      output = JSON.parse(await readFile(repairOutputPath, "utf8"));
      findings = [
        ...validateBootstrapOutput(output, inventory, {
          profile: semanticProfile
        }),
        ...validateBootstrapRepair(
          JSON.parse(
            await readFile(
              path.join(
                root,
                ".assistant",
                "internal",
                "bootstrap",
                "rejected",
                rejectedOutputId,
                "model-result.json"
              ),
              "utf8"
            )
          ),
          output,
          findings
        )
      ];
      if (findings.length > 0) {
        await preserveRejectedBootstrap(
          root,
          output,
          findings,
          repairRunMetrics,
          "repair"
        );
        throw new Error(
          `bootstrap repair validation failed: ${findings.join("; ")}`
        );
      }
    }
    const runMetrics = {
      tokens_used:
        (initialRunMetrics.tokens_used ?? 0) +
        (repairRunMetrics?.tokens_used ?? 0),
      initial: initialRunMetrics,
      repair: repairRunMetrics,
      rejected_output_id: rejectedOutputId
    };

    await stageBootstrapOutput(
      root,
      output,
      invocation,
      evidence.metrics,
      runMetrics
    );
    const status = await updatePersistentBootstrapStatus(root, output);
    return {
      schema: "assistant.semantic-bootstrap-result/v1",
      target: root,
      status,
      gaps: output.gaps.length,
      critical_gaps: output.gaps.filter(
        (gap) => gap.blocking_level === "initialization"
      ).length,
      conflicts: output.conflicts.length,
      material_conflicts: output.conflicts.filter((conflict) => conflict.material).length,
      candidate_nodes: output.candidate_nodes.length,
      tokens_used: runMetrics.tokens_used,
      evidence_packet: evidence.metrics
    };
  } finally {
    await rm(modelWorkspace, { recursive: true, force: true });
  }
}

export async function recoverRejectedBootstrap(target, rejectionId) {
  const root = path.resolve(target);
  const manifest = JSON.parse(
    await readFile(path.join(root, ".assistant", "manifest.json"), "utf8")
  );
  const semanticProfile = manifest.profile ?? "research";
  if (!/^REJ-[0-9a-f-]+$/u.test(rejectionId)) {
    throw new Error("invalid bootstrap rejection ID");
  }
  const bootstrapRoot = path.join(
    root,
    ".assistant",
    "internal",
    "bootstrap"
  );
  const rejectionRoot = path.join(
    bootstrapRoot,
    "rejected",
    rejectionId
  );
  const rejection = JSON.parse(
    await readFile(path.join(rejectionRoot, "rejection.json"), "utf8")
  );
  if (
    (rejection.findings ?? []).some((item) =>
      /repair changed/iu.test(item)
    )
  ) {
    throw new Error("cannot recover a repair that changed semantic meaning");
  }
  let output = JSON.parse(
    await readFile(path.join(rejectionRoot, "model-result.json"), "utf8")
  );
  const inventory = JSON.parse(
    await readFile(path.join(bootstrapRoot, "inventory.json"), "utf8")
  );
  let findings = validateBootstrapOutput(output, inventory, {
    profile: semanticProfile
  });
  const deterministic = repairDeterministicBootstrapRelations(output, findings);
  if (deterministic.changes.length > 0) {
    const repairedFindings = validateBootstrapOutput(
      deterministic.output,
      inventory,
      { profile: semanticProfile }
    );
    const repairContract = validateBootstrapRepair(
      output,
      deterministic.output,
      findings
    );
    if (repairedFindings.length === 0 && repairContract.length === 0) {
      output = deterministic.output;
      findings = [];
    }
  }
  if (findings.length > 0) {
    throw new Error(
      `rejected output is still invalid: ${findings.join("; ")}`
    );
  }
  const sourceAuthorityPath = path.join(
    bootstrapRoot,
    "source-authority.json"
  );
  const sourceAuthority = (await pathExists(sourceAuthorityPath))
    ? JSON.parse(await readFile(sourceAuthorityPath, "utf8"))
    : null;
  const evidence = await buildEvidencePacket(root, inventory, {
    priorityPaths: sourceAuthority?.imported_paths ?? []
  });
  if (evidence.metrics.priority_omitted_files > 0) {
    throw new Error(
      "cannot recover bootstrap without the complete explicit source priority packet"
    );
  }
  const runMetrics = {
    tokens_used: rejection.execution?.tokens_used ?? null,
    recovered_from: rejectionId,
    original_execution: rejection.execution ?? null,
    deterministic_relation_repairs: deterministic.changes
  };
  await stageBootstrapOutput(
    root,
    output,
    { kind: "recovered-rejected-output" },
    evidence.metrics,
    runMetrics
  );
  const status = await updatePersistentBootstrapStatus(root, output);
  return {
    schema: "assistant.semantic-bootstrap-result/v1",
    target: root,
    status,
    gaps: output.gaps.length,
    critical_gaps: output.gaps.filter(
      (gap) => gap.blocking_level === "initialization"
    ).length,
    conflicts: output.conflicts.length,
    material_conflicts: output.conflicts.filter(
      (conflict) => conflict.material
    ).length,
    candidate_nodes: output.candidate_nodes.length,
    tokens_used: runMetrics.tokens_used,
    evidence_packet: evidence.metrics,
    recovered_from: rejectionId
  };
}
