import { stat } from "node:fs/promises";
import path from "node:path";
import {
  buildEvidencePacket,
  buildSemanticEvidenceBatches
} from "./evidence-packet.mjs";
import { pathExists } from "./files.mjs";
import { inventoryProject } from "./inventory.mjs";

const DEFAULT_LIMITS = Object.freeze({
  paths: 2_000,
  semanticFiles: 1_000,
  packetBytes: 768 * 1024,
  sourceBytes: 512 * 1024
});

function semanticMetrics(inventory) {
  const semanticCategories = new Set(["document", "code", "config", "data"]);
  const entries = inventory.entries.filter(
    (entry) => entry.kind === "file" && semanticCategories.has(entry.category)
  );
  return {
    files: entries.length,
    bytes: entries.reduce((total, entry) => total + entry.size, 0)
  };
}

async function inspectSource(sourceInput) {
  const source = path.resolve(sourceInput);
  if (!(await pathExists(source))) {
    throw new Error(`initialization source does not exist: ${source}`);
  }
  const info = await stat(source);
  if (info.isFile()) {
    return { path: source, files: 1, paths: 1, bytes: info.size };
  }
  if (!info.isDirectory()) {
    return { path: source, files: 0, paths: 1, bytes: 0 };
  }
  const inventory = await inventoryProject(source, { hashLimitBytes: 0 });
  return {
    path: source,
    files: inventory.summary.files,
    paths: inventory.summary.paths,
    bytes: inventory.summary.total_bytes
  };
}

export async function preflightInitialization(target, options = {}) {
  const root = path.resolve(target);
  const limits = { ...DEFAULT_LIMITS, ...(options.limits ?? {}) };
  const inventory = await pathExists(root)
    ? await inventoryProject(root, { hashLimitBytes: 0 })
    : {
        summary: { paths: 0, files: 0, total_bytes: 0, categories: {} },
        entries: []
      };
  const semantic = semanticMetrics(inventory);
  const packet = await buildEvidencePacket(root, inventory);
  const semanticEvidence = await buildSemanticEvidenceBatches(root, inventory);
  const sources = [];
  for (const source of options.sources ?? []) {
    sources.push(await inspectSource(source));
  }
  const sourceBytes = sources.reduce((total, source) => total + source.bytes, 0);
  const reasons = [];
  const blockingReasons = [];
  if (inventory.summary.paths > limits.paths) {
    reasons.push({
      metric: "project_paths",
      actual: inventory.summary.paths,
      limit: limits.paths
    });
  }
  if (semantic.files > limits.semanticFiles) {
    reasons.push({
      metric: "semantic_candidate_files",
      actual: semantic.files,
      limit: limits.semanticFiles
    });
  }
  if (packet.metrics.packet_bytes > limits.packetBytes) {
    reasons.push({
      metric: "projected_packet_bytes",
      actual: packet.metrics.packet_bytes,
      limit: limits.packetBytes
    });
  }
  if (semanticEvidence.metrics.batch_bytes > limits.packetBytes) {
    reasons.push({
      metric: "semantic_batch_bytes",
      actual: semanticEvidence.metrics.batch_bytes,
      limit: limits.packetBytes
    });
  }
  if (sourceBytes > limits.sourceBytes) {
    blockingReasons.push({
      metric: "explicit_source_bytes",
      actual: sourceBytes,
      limit: limits.sourceBytes,
      resolution:
        "select a smaller exact source set or split the source into bounded integration episodes"
    });
  }
  return {
    schema: "assistant.init-preflight/v1",
    target: root,
    status:
      blockingReasons.length > 0
        ? "unsupported_source_size"
        : reasons.length > 0
          ? "confirmation_required"
          : "clear",
    project: {
      ...inventory.summary,
      semantic_candidate_files: semantic.files,
      semantic_candidate_bytes: semantic.bytes,
      projected_packet: packet.metrics,
      projected_semantic_evidence: semanticEvidence.metrics
    },
    sources,
    reasons,
    blocking_reasons: blockingReasons,
    next:
      blockingReasons.length > 0
        ? "reduce the explicit source set before initialization; size confirmation cannot override the semantic input limit"
        : reasons.length > 0
        ? "review the size warning and rerun with --allow-large-project to continue"
        : "continue initialization"
  };
}
