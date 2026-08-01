import { randomUUID } from "node:crypto";
import {
  cp,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import { validateBootstrapOutput } from "./bootstrap-contract.mjs";
import { finalizeInstalledProject } from "./initialization.mjs";
import { pathExists, writeUtf8 } from "./files.mjs";
import { serializeNodeDocument } from "./meta.mjs";

function requiredBlockers(output) {
  return [
    ...(output.gaps ?? [])
      .filter((gap) => gap.blocking_level === "initialization")
      .map((gap) => ({ id: gap.id, kind: "gap" })),
    ...(output.conflicts ?? [])
      .filter((conflict) => conflict.material)
      .map((conflict) => ({ id: conflict.id, kind: "conflict" }))
  ];
}

function candidateMap(output) {
  return new Map((output.candidate_nodes ?? []).map((node) => [node.id, node]));
}

function changedCandidateIds(before, after) {
  const left = candidateMap(before);
  const right = candidateMap(after);
  const ids = new Set([...left.keys(), ...right.keys()]);
  return [...ids].filter(
    (id) => JSON.stringify(left.get(id)) !== JSON.stringify(right.get(id))
  );
}

function validateResolutionPackage(
  resolution,
  original,
  inventory,
  confirmed,
  profile
) {
  const findings = [];
  if (resolution?.schema !== "assistant.bootstrap-resolution/v1") {
    findings.push("invalid bootstrap resolution schema");
  }
  if (!Array.isArray(resolution?.decisions)) {
    findings.push("decisions must be an array");
  }
  if (!resolution?.resolved_output) {
    findings.push("resolved_output is missing");
    return findings;
  }
  findings.push(
    ...validateBootstrapOutput(resolution.resolved_output, inventory, {
      profile
    })
  );

  const blockers = requiredBlockers(original);
  const blockerKey = (item) => `${item.kind}:${item.id}`;
  const required = new Set(blockers.map(blockerKey));
  const provided = new Set();
  const affected = new Set();
  const resolvedNodes = candidateMap(resolution.resolved_output);
  for (const decision of resolution.decisions ?? []) {
    if (
      !decision ||
      !["gap", "conflict"].includes(decision.kind) ||
      typeof decision.id !== "string" ||
      typeof decision.decision !== "string" ||
      decision.decision.trim().length === 0 ||
      typeof decision.rationale !== "string" ||
      decision.rationale.trim().length === 0 ||
      !Array.isArray(decision.affected_candidate_ids)
    ) {
      findings.push("each resolution decision requires kind, id, decision, rationale, and affected_candidate_ids");
      continue;
    }
    provided.add(blockerKey(decision));
    for (const id of decision.affected_candidate_ids) affected.add(id);
    if (decision.kind === "conflict") {
      if (!confirmed) {
        findings.push("material conflict resolution requires explicit confirmation");
      }
      const canonicalDecision = resolvedNodes.get(
        decision.canonical_decision_id
      );
      if (
        !canonicalDecision ||
        canonicalDecision.type !== "decision" ||
        canonicalDecision.authority !== "canonical_user_approved"
      ) {
        findings.push(
          `${decision.id} requires a canonical_user_approved decision candidate`
        );
      }
    }
  }
  for (const key of required) {
    if (!provided.has(key)) findings.push(`missing resolution for ${key}`);
  }
  for (const key of provided) {
    if (!required.has(key)) findings.push(`resolution does not match an active blocker: ${key}`);
  }
  for (const id of changedCandidateIds(original, resolution.resolved_output)) {
    if (!affected.has(id)) {
      findings.push(`changed candidate ${id} is not declared by a resolution decision`);
    }
  }
  if (requiredBlockers(resolution.resolved_output).length > 0) {
    findings.push("resolved output still contains initialization blockers");
  }
  return findings;
}

async function writeStaging(stagingRoot, output) {
  await mkdir(stagingRoot, { recursive: true });
  const timestamp = new Date().toISOString();
  for (const node of output.candidate_nodes) {
    const metadata = {
      schema: "assistant.node/v1",
      id: node.id,
      type: node.type,
      status: node.status,
      authority: "candidate_unintegrated",
      relations: node.relations,
      verified_at: timestamp,
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
}

export async function resolveBootstrap(target, resolution, options = {}) {
  const root = path.resolve(target);
  const bootstrapRoot = path.join(
    root,
    ".assistant",
    "internal",
    "bootstrap"
  );
  const statePath = path.join(bootstrapRoot, "state.json");
  const state = JSON.parse(await readFile(statePath, "utf8"));
  if (state.status !== "awaiting_user_input") {
    throw new Error(`bootstrap resolution requires awaiting_user_input, found ${state.status}`);
  }

  const original = JSON.parse(
    await readFile(path.join(bootstrapRoot, "model-result.json"), "utf8")
  );
  const inventory = JSON.parse(
    await readFile(path.join(bootstrapRoot, "inventory.json"), "utf8")
  );
  const manifest = JSON.parse(
    await readFile(path.join(root, ".assistant", "manifest.json"), "utf8")
  );
  const findings = validateResolutionPackage(
    resolution,
    original,
    inventory,
    options.confirmed === true,
    manifest.profile ?? "research"
  );
  if (findings.length > 0) {
    throw new Error(`bootstrap resolution rejected: ${findings.join("; ")}`);
  }

  const transactionId = `TXN-${randomUUID()}`;
  const transactionRoot = path.join(
    root,
    ".assistant",
    "internal",
    "transactions",
    transactionId
  );
  const backupRoot = path.join(transactionRoot, "backup");
  const stagedRoot = path.join(bootstrapRoot, `staging-${transactionId}`);
  await mkdir(backupRoot, { recursive: true });
  await cp(bootstrapRoot, path.join(backupRoot, "bootstrap"), {
    recursive: true
  });
  await cp(
    path.join(root, ".assistant", "CURRENT.md"),
    path.join(backupRoot, "CURRENT.md")
  );
  await cp(
    path.join(root, ".assistant", "manifest.json"),
    path.join(backupRoot, "manifest.json")
  );

  try {
    await writeStaging(stagedRoot, resolution.resolved_output);
    const activeStaging = path.join(bootstrapRoot, "staging");
    await rm(activeStaging, { recursive: true, force: true });
    await rename(stagedRoot, activeStaging);
    await writeFile(
      path.join(bootstrapRoot, "model-result.json"),
      `${JSON.stringify(resolution.resolved_output, null, 2)}\n`,
      "utf8"
    );
    await writeUtf8(
      path.join(bootstrapRoot, "resolution.json"),
      `${JSON.stringify({
        ...resolution,
        confirmed: options.confirmed === true,
        resolved_at: new Date().toISOString()
      }, null, 2)}\n`
    );

    const completion = await finalizeInstalledProject(root, {
      initializationStatus: "bootstrap_incomplete",
      probeSandbox: options.probeSandbox
    });
    await writeUtf8(
      path.join(transactionRoot, "record.json"),
      `${JSON.stringify({
        schema: "assistant.transaction/v1",
        id: transactionId,
        type: "bootstrap_resolution",
        status: "committed",
        decisions: resolution.decisions,
        completion: {
          initialization_status: completion.initialization_status,
          readiness: completion.readiness
        },
        committed_at: new Date().toISOString()
      }, null, 2)}\n`
    );
    return {
      schema: "assistant.bootstrap-resolution-result/v1",
      status: "committed",
      transaction_id: transactionId,
      completion
    };
  } catch (error) {
    await rm(bootstrapRoot, { recursive: true, force: true });
    await cp(path.join(backupRoot, "bootstrap"), bootstrapRoot, {
      recursive: true
    });
    await cp(
      path.join(backupRoot, "CURRENT.md"),
      path.join(root, ".assistant", "CURRENT.md"),
      { force: true }
    );
    await cp(
      path.join(backupRoot, "manifest.json"),
      path.join(root, ".assistant", "manifest.json"),
      { force: true }
    );
    if (await pathExists(stagedRoot)) {
      await rm(stagedRoot, { recursive: true, force: true });
    }
    await writeUtf8(
      path.join(transactionRoot, "record.json"),
      `${JSON.stringify({
        schema: "assistant.transaction/v1",
        id: transactionId,
        type: "bootstrap_resolution",
        status: "rolled_back",
        error: error.message,
        rolled_back_at: new Date().toISOString()
      }, null, 2)}\n`
    );
    throw error;
  }
}
