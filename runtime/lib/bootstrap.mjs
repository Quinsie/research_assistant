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
import {
  buildDiscoveryPacket,
  buildEvidencePacket
} from "./evidence-packet.mjs";
import { pathExists, writeUtf8 } from "./files.mjs";
import { parseNodeDocument, serializeNodeDocument } from "./meta.mjs";

const runtimeDirectory = path.dirname(fileURLToPath(import.meta.url));
const runtimeRoot = path.resolve(runtimeDirectory, "..");
const promptPath = path.join(
  runtimeRoot,
  "prompts",
  "bootstrap-existing-v1.md"
);
const schemaPath = path.join(
  runtimeRoot,
  "schemas",
  "bootstrap-output.schema.json"
);
const discoveryPromptPath = path.join(
  runtimeRoot,
  "prompts",
  "bootstrap-discovery-v1.md"
);
const discoverySchemaPath = path.join(
  runtimeRoot,
  "schemas",
  "bootstrap-discovery.schema.json"
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
- Assistant operation not yet authorized: canonical execution based on this incomplete survey
- Critical gap IDs: ${criticalIds.length > 0 ? criticalIds.map((id) => `\`${id}\``).join(", ") : "none"}
- Material conflict IDs: ${conflictIds.length > 0 ? conflictIds.map((id) => `\`${id}\``).join(", ") : "none"}
- Candidate route: \`.assistant/internal/bootstrap/staging/\`
- Last verified: \`${current.metadata.verified_at}\`

The semantic survey is staged but not active canonical knowledge. Resolve the
listed critical decisions, then resume validation and closed-book activation.
Human and non-assistant project work remain unaffected.
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

export function spawnCodex(invocation, args, cwd, stdinContent, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(invocation.command, [...invocation.prefixArgs, ...args], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    let stdoutBuffer = "";
    let stderr = "";
    let usage = null;
    let threadId = null;
    let settled = false;
    const startedAt = Date.now();
    const timeoutMs =
      Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
        ? options.timeoutMs
        : null;
    const onInterrupt = async () => {
      await terminateTree();
      finish(
        reject,
        executionError(
          "Codex analysis was interrupted",
          { interrupted: true }
        )
      );
    };
    const executionMetrics = (extra = {}) => ({
      thread_id: threadId,
      usage,
      elapsed_seconds: Math.round((Date.now() - startedAt) / 1000),
      ...extra
    });
    const executionError = (message, extra = {}) => {
      const error = new Error(message);
      error.execution = executionMetrics(extra);
      return error;
    };
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      clearInterval(heartbeat);
      process.off("SIGINT", onInterrupt);
      process.off("SIGTERM", onInterrupt);
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
    const timer = timeoutMs
      ? setTimeout(async () => {
          await terminateTree();
          finish(
            reject,
            executionError(
              `codex exec timed out after the user-configured ${timeoutMs}ms limit`,
              { timed_out: true }
            )
          );
        }, timeoutMs)
      : null;
    process.once("SIGINT", onInterrupt);
    process.once("SIGTERM", onInterrupt);
    const heartbeat = setInterval(() => {
      options.onProgress?.({
        phase: options.phase ?? "model_analysis",
        message: "Codex semantic analysis is still running",
        elapsed_seconds: Math.round((Date.now() - startedAt) / 1000)
      });
    }, 15_000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk;
      const lines = stdoutBuffer.split(/\r?\n/u);
      stdoutBuffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          if (event.type === "thread.started" && event.thread_id) {
            threadId = event.thread_id;
            options.onEvent?.(event);
          } else if (event.type === "turn.completed" && event.usage) {
            usage = event.usage;
            options.onEvent?.(event);
          } else if (event.type === "turn.failed" || event.type === "error") {
            options.onEvent?.(event);
            options.onProgress?.({
              phase: options.phase ?? "model_analysis",
              message: event.error?.message ?? event.message ?? event.type
            });
          }
        } catch {
          // Codex JSONL is authoritative; retain non-JSON text only for diagnostics.
          stderr += `${line}\n`;
        }
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (stderr.length > 1_000_000) {
        stderr = stderr.slice(-1_000_000);
      }
    });
    child.once("error", (error) => finish(reject, error));
    child.once("exit", (code, signal) => {
      if (stdoutBuffer.trim()) {
        try {
          const event = JSON.parse(stdoutBuffer);
          if (event.type === "turn.completed" && event.usage) usage = event.usage;
        } catch {
          stderr += `${stdoutBuffer}\n`;
        }
      }
      const tokenMatch = stderr.match(/tokens used\s*\r?\n([\d,]+)/i);
      const structuredTokens = usage
        ? (usage.total_tokens ??
          (Number(usage.input_tokens ?? 0) + Number(usage.output_tokens ?? 0)))
        : null;
      const metrics = {
        thread_id: threadId,
        exit_code: code,
        signal: signal ?? null,
        tokens_used: structuredTokens ?? (tokenMatch
          ? Number.parseInt(tokenMatch[1].replaceAll(",", ""), 10)
          : null),
        usage
      };
      if (code === 0) finish(resolve, metrics);
      else {
        const tail = stderr.split(/\r?\n/).slice(-20).join("\n");
        finish(
          reject,
          executionError(
            `codex exec failed with code=${code} signal=${signal ?? "none"}\n${tail}`,
            { exit_code: code, signal: signal ?? null }
          )
        );
      }
    });
    child.stdin.end(stdinContent);
  });
}

function selectionFromOptions(options = {}) {
  return options.profile
    ? { profile: options.profile, model: null, effort: null }
    : {
        profile: null,
        model: options.model ?? "gpt-5.6-sol",
        effort: options.effort ?? "high"
      };
}

function sameSelection(left, right) {
  return left.profile === right.profile &&
    left.model === right.model &&
    left.effort === right.effort;
}

export async function persistBootstrapSelection(target, options = {}) {
  const root = path.resolve(target);
  const selectionPath = path.join(
    root,
    ".assistant",
    "internal",
    "bootstrap",
    "selection.json"
  );
  const requested = selectionFromOptions(options);
  if (await pathExists(selectionPath)) {
    const stored = JSON.parse(await readFile(selectionPath, "utf8"));
    const explicit = Boolean(options.profile || options.model || options.effort);
    if (explicit && !sameSelection(stored.selection, requested)) {
      throw new Error(
        "bootstrap model selection differs from the persisted initialization " +
        "selection; use an explicit semantic restart with a durable reason"
      );
    }
    return stored.selection;
  }
  await writeUtf8(
    selectionPath,
    `${JSON.stringify({
      schema: "assistant.bootstrap-selection/v1",
      selection: requested,
      selected_at: new Date().toISOString(),
      immutable_during_attempt: true
    }, null, 2)}\n`
  );
  return requested;
}

function validateDiscovery(discovery, packet, inventory) {
  if (
    discovery?.schema !== "assistant.bootstrap-discovery/v1" ||
    !Array.isArray(discovery.boundaries) ||
    !Array.isArray(discovery.uncertainties)
  ) {
    throw new Error("invalid bootstrap discovery output");
  }
  const orientationPaths = new Set(packet.metrics.included_paths);
  const inventoryPaths = inventory.entries.map((entry) => entry.path);
  const accepted = [];
  for (const boundary of discovery.boundaries) {
    const normalized = String(boundary.path ?? "")
      .replaceAll("\\", "/")
      .replace(/^\.\/+/u, "")
      .replace(/\/+$/u, "");
    if (!["metadata_only", "exclude"].includes(boundary.access)) {
      throw new Error(`invalid discovery access for ${normalized}`);
    }
    if (!orientationPaths.has(boundary.evidence_path)) {
      throw new Error(
        `discovery boundary ${normalized} cites uninspected evidence ${boundary.evidence_path}`
      );
    }
    if (
      typeof boundary.evidence !== "string" ||
      !packet.packet.includes(boundary.evidence)
    ) {
      throw new Error(
        `discovery boundary ${normalized} lacks an exact inspected evidence excerpt`
      );
    }
    if (
      !inventoryPaths.some(
        (candidate) =>
          candidate === normalized || candidate.startsWith(`${normalized}/`)
      )
    ) {
      throw new Error(`discovery boundary does not exist: ${normalized}`);
    }
    if (boundary.certainty === "explicit") {
      accepted.push({ ...boundary, path: normalized });
    }
  }
  return accepted;
}

function modelArgs(selection) {
  return selection.profile
    ? ["--profile", selection.profile]
    : [
        "--model",
        selection.model,
        "--config",
        `model_reasoning_effort="${selection.effort}"`
      ];
}

async function readExecution(executionPath) {
  return (await pathExists(executionPath))
    ? JSON.parse(await readFile(executionPath, "utf8"))
    : null;
}

async function writeExecution(executionPath, execution) {
  execution.updated_at = new Date().toISOString();
  await writeUtf8(executionPath, `${JSON.stringify(execution, null, 2)}\n`);
}

async function runBootstrapTurn({
  invocation,
  selection,
  execution,
  executionPath,
  stage,
  schema,
  output,
  prompt,
  stdin,
  onProgress,
  timeoutMs
}) {
  const isResume =
    execution.thread_id &&
    execution.phase === stage &&
    ["interrupted", "failed", "running"].includes(execution.status);
  const args = [
    "--ask-for-approval",
    "never",
    "exec",
    "--json",
    "-C",
    execution.workspace,
    "--sandbox",
    "read-only",
    "--skip-git-repo-check",
    "--output-schema",
    schema,
    "--output-last-message",
    output,
    ...modelArgs(selection)
  ];
  if (isResume) {
    args.push(
      "resume",
      execution.thread_id,
      `Resume the interrupted ${stage} phase. Complete the same contract using the exact packet on stdin. Do not change model or reasoning effort.`
    );
  } else if (execution.thread_id) {
    args.push("resume", execution.thread_id, prompt);
  } else {
    args.push(prompt);
  }
  execution.phase = stage;
  execution.status = "running";
  execution.output_path = output;
  execution.resume_kind = isResume ? "codex_exec_resume" : "new_turn";
  await writeExecution(executionPath, execution);
  let eventWrites = Promise.resolve();
  try {
    const metrics = await spawnCodex(
      invocation,
      args,
      execution.workspace,
      stdin,
      {
        onProgress,
        phase: stage,
        timeoutMs,
        onEvent: (event) => {
          if (event.type === "thread.started" && event.thread_id) {
            execution.thread_id = event.thread_id;
            eventWrites = eventWrites.then(() =>
              writeExecution(executionPath, execution)
            );
          }
        }
      }
    );
    await eventWrites;
    execution.thread_id = metrics.thread_id ?? execution.thread_id;
    execution.status = "completed";
    execution.metrics ??= {};
    execution.metrics[stage] = {
      ...metrics,
      resume_kind: isResume ? "codex_exec_resume" : "new_turn"
    };
    await writeExecution(executionPath, execution);
    return metrics;
  } catch (error) {
    await eventWrites;
    execution.thread_id = error.execution?.thread_id ?? execution.thread_id;
    execution.status = error.execution?.interrupted ? "interrupted" : "failed";
    execution.failure = {
      message: error.message,
      resumable: Boolean(execution.thread_id && await pathExists(execution.workspace)),
      execution: error.execution ?? null,
      failed_at: new Date().toISOString()
    };
    await writeExecution(executionPath, execution);
    const suffix = execution.failure.resumable
      ? ` Resume with the installed assistant init command; Codex session ${execution.thread_id} is preserved.`
      : " No durable Codex session was captured; use an explicit semantic restart.";
    throw new Error(`${error.message}.${suffix}`);
  }
}

export async function runSemanticBootstrap(target, options = {}) {
  const root = path.resolve(target);
  const bootstrapRoot = path.join(root, ".assistant", "internal", "bootstrap");
  const manifest = JSON.parse(
    await readFile(path.join(root, ".assistant", "manifest.json"), "utf8")
  );
  const semanticProfile = manifest.profile ?? "research";
  const inventoryPath = path.join(bootstrapRoot, "inventory.json");
  if (!(await pathExists(inventoryPath))) {
    throw new Error("deterministic bootstrap inventory is missing");
  }
  const inventory = JSON.parse(await readFile(inventoryPath, "utf8"));
  const sourceAuthorityPath = path.join(bootstrapRoot, "source-authority.json");
  const sourceAuthority = (await pathExists(sourceAuthorityPath))
    ? JSON.parse(await readFile(sourceAuthorityPath, "utf8"))
    : null;
  const selection = await persistBootstrapSelection(root, options);
  const invocation = await discoverCodexInvocation();
  const executionPath = path.join(bootstrapRoot, "execution.json");
  let execution = await readExecution(executionPath);
  if (!execution) {
    execution = {
      schema: "assistant.bootstrap-execution/v1",
      attempt_id: `ATT-${randomUUID()}`,
      selection,
      workspace: await mkdtemp(
        path.join(os.tmpdir(), "assistant-bootstrap-model-")
      ),
      thread_id: null,
      phase: "discovery",
      status: "pending",
      created_at: new Date().toISOString(),
      metrics: {}
    };
    await writeExecution(executionPath, execution);
  } else if (!sameSelection(execution.selection, selection)) {
    throw new Error("persisted bootstrap execution selection mismatch");
  } else if (!(await pathExists(execution.workspace))) {
    throw new Error(
      "persisted Codex workspace is missing; resume is impossible. " +
      "Use an explicit semantic restart with a durable reason"
    );
  }
  const timeoutMs = options.timeoutSeconds
    ? Number(options.timeoutSeconds) * 1000
    : null;

  const discoveryPacket = await buildDiscoveryPacket(root, inventory);
  const discoveryPacketPath = path.join(bootstrapRoot, "discovery-packet.txt");
  await writeUtf8(discoveryPacketPath, discoveryPacket.packet);
  const discoveryOutputPath = path.join(execution.workspace, "discovery-output.json");
  let discovery;
  if (
    execution.phase === "discovery" &&
    execution.status !== "completed"
  ) {
    options.onProgress?.({
      phase: "discovery",
      message: "Checking discoverable project-wide content boundaries"
    });
    await runBootstrapTurn({
      invocation,
      selection,
      execution,
      executionPath,
      stage: "discovery",
      schema: discoverySchemaPath,
      output: discoveryOutputPath,
      prompt: await readFile(discoveryPromptPath, "utf8"),
      stdin: discoveryPacket.packet,
      onProgress: options.onProgress,
      timeoutMs
    });
  }
  discovery = JSON.parse(await readFile(discoveryOutputPath, "utf8"));
  const boundaries = validateDiscovery(discovery, discoveryPacket, inventory);
  await writeUtf8(
    path.join(bootstrapRoot, "discovery.json"),
    `${JSON.stringify({
      ...discovery,
      accepted_boundaries: boundaries,
      packet: discoveryPacket.metrics
    }, null, 2)}\n`
  );

  const evidence = await buildEvidencePacket(root, inventory, {
    priorityPaths: sourceAuthority?.imported_paths ?? [],
    boundaries
  });
  await writeUtf8(path.join(bootstrapRoot, "evidence-packet.txt"), evidence.packet);
  options.onProgress?.({
    phase: "evidence_packet",
    message:
      `Prepared ${evidence.metrics.packet_bytes} byte bounded evidence packet ` +
      `after ${boundaries.length} explicit content boundaries`
  });
  if (evidence.metrics.priority_omitted_files > 0) {
    throw new Error(
      "explicit initialization source exceeds the loss-aware bootstrap priority budget; " +
      "source chunking is required before activation"
    );
  }

  const outputPath = path.join(execution.workspace, "model-output.json");
  let prompt = await readFile(promptPath, "utf8");
  if (sourceAuthority) {
    prompt += `\n\n## Runner-provided current instruction\n\n`;
    prompt +=
      "The user explicitly supplied the following exact paths to initialize canonical project knowledge. " +
      "Treat source-grounded, non-conflicting project intent in them as current user-approved input. " +
      "Do not ask whether these sources are intended for initialization. Existing-project material conflicts still require confirmation, and this does not authorize implementation or execution.\n\n" +
      "The explicit `--target` project root is the current authoritative root and outranks paths written inside a source. " +
      "Treat source-internal absolute repository paths as environment references to map or verify, not as a material conflict with the selected target, unless the source meaning cannot be re-rooted without changing its approved scope.\n\n";
    for (const importedPath of sourceAuthority.imported_paths) {
      prompt += `- \`${importedPath}\`\n`;
    }
  }
  prompt += `\n\n## Discovery boundary result\n\n`;
  prompt +=
    "The runner applied only explicit, evidence-cited boundaries from the bounded orientation phase. " +
    "Do not claim content inspection for metadata-only entries. Uncertainties remain gaps, not inferred permissions.\n\n";
  prompt += `${JSON.stringify({ boundaries, uncertainties: discovery.uncertainties })}\n`;

  options.onProgress?.({
    phase: "model_analysis",
    message: execution.phase === "model_analysis" && execution.status !== "completed"
      ? "Resuming the preserved Codex semantic analysis session"
      : "Started Codex semantic analysis in the persisted discovery session"
  });
  const semanticAlreadyCompleted =
    ["model_analysis", "model_repair"].includes(execution.phase) &&
    await pathExists(outputPath);
  const initialRunMetrics = semanticAlreadyCompleted
    ? execution.metrics.model_analysis
    : await runBootstrapTurn({
        invocation,
        selection,
        execution,
        executionPath,
        stage: "model_analysis",
        schema: schemaPath,
        output: outputPath,
        prompt,
        stdin: evidence.packet,
        onProgress: options.onProgress,
        timeoutMs
      });
  let output = JSON.parse(await readFile(outputPath, "utf8"));
  let findings = validateBootstrapOutput(output, inventory, {
    profile: semanticProfile
  });
  let repairRunMetrics = null;
  let rejectedOutputId = execution.rejected_output_id ?? null;
  if (findings.length > 0) {
    if (!rejectedOutputId) {
      rejectedOutputId = await preserveRejectedBootstrap(
        root,
        output,
        findings,
        initialRunMetrics,
        "initial"
      );
      execution.rejected_output_id = rejectedOutputId;
      await writeExecution(executionPath, execution);
    }
    const deterministic = repairDeterministicBootstrapRelations(output, findings);
    if (deterministic.changes.length > 0) {
      const deterministicFindings = validateBootstrapOutput(
        deterministic.output,
        inventory,
        { profile: semanticProfile }
      );
      const repairFindings = validateBootstrapRepair(
        output,
        deterministic.output,
        findings
      );
      if (deterministicFindings.length === 0 && repairFindings.length === 0) {
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
    const rejectedOutput = structuredClone(output);
    const repairOutputPath = path.join(execution.workspace, "model-repair.json");
    const repairPrompt = `# Bootstrap contract repair

Return a complete object conforming to the supplied output schema. Repair only
the listed deterministic contract violations in the rejected output supplied
on stdin. Preserve all source-grounded semantic content, candidate IDs,
conditions, numeric values, coverage, gaps, and conflicts unless the finding
directly requires a structural change. Do not invent evidence.`;
    repairRunMetrics =
      execution.phase === "model_repair" &&
      execution.status === "completed" &&
      await pathExists(repairOutputPath)
        ? execution.metrics.model_repair
        : await runBootstrapTurn({
            invocation,
            selection,
            execution,
            executionPath,
            stage: "model_repair",
            schema: schemaPath,
            output: repairOutputPath,
            prompt: repairPrompt,
            stdin: `${JSON.stringify({
              schema: "assistant.bootstrap-repair-input/v1",
              findings,
              rejected_output: rejectedOutput
            })}\n`,
            onProgress: options.onProgress,
            timeoutMs
          });
    output = JSON.parse(await readFile(repairOutputPath, "utf8"));
    const repairedFindings = [
      ...validateBootstrapOutput(output, inventory, {
        profile: semanticProfile
      }),
      ...validateBootstrapRepair(rejectedOutput, output, findings)
    ];
    if (repairedFindings.length > 0) {
      await preserveRejectedBootstrap(
        root,
        output,
        repairedFindings,
        repairRunMetrics,
        "repair"
      );
      throw new Error(
        `bootstrap repair validation failed: ${repairedFindings.join("; ")}`
      );
    }
  }
  const runMetrics = {
    tokens_used:
      (initialRunMetrics.tokens_used ?? 0) +
      (repairRunMetrics?.tokens_used ?? 0),
    discovery: execution.metrics.discovery ?? null,
    initial: initialRunMetrics,
    repair: repairRunMetrics,
    rejected_output_id: rejectedOutputId,
    session_id: execution.thread_id,
    selection
  };
  await stageBootstrapOutput(
    root,
    output,
    invocation,
    evidence.metrics,
    runMetrics
  );
  const status = await updatePersistentBootstrapStatus(root, output);
  execution.phase = "staged";
  execution.status = "completed";
  execution.staged_at = new Date().toISOString();
  await writeExecution(executionPath, execution);
  await rm(execution.workspace, { recursive: true, force: true });
  execution.workspace_removed = true;
  await writeExecution(executionPath, execution);
  options.onProgress?.({
    phase: "semantic_complete",
    message: `Semantic survey completed with ${runMetrics.tokens_used ?? "unknown"} tokens`
  });
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
    resumed: Object.values(execution.metrics).some(
      (metric) => metric?.resume_kind === "codex_exec_resume"
    ),
    evidence_packet: evidence.metrics,
    discovery: {
      boundaries: boundaries.length,
      uncertainties: discovery.uncertainties.length
    }
  };
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
