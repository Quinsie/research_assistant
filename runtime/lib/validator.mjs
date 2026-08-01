import path from "node:path";
import {
  ACTIVITY_STATUSES,
  AUTHORIZATION_STATES,
  AUTHORITIES,
  BOUNDEDNESS_DEFAULTS,
  INITIALIZATION_STATUSES,
  MANIFEST_SCHEMA,
  NODE_SCHEMA,
  NODE_TYPES,
  PROFILE_ALLOWED_TYPES,
  PROFILE_FORBIDDEN_RELATIONS,
  PROFILE_RELATION_REQUIREMENTS,
  PROFILE_WORKFLOW_HEADINGS,
  PROJECT_PROFILES,
  RELATION_TYPES,
  REQUIRED_CANONICAL_FILES
} from "./contract.mjs";
import { listFilesRecursive, pathExists, readUtf8 } from "./files.mjs";
import { parseNodeDocument, parsePolicyRules } from "./meta.mjs";
import { validatePolicyRules } from "./policy.mjs";
import { renderIndex } from "./projection.mjs";
import { inspectValidatedHashes } from "./integrity.mjs";

function finding(severity, code, message, filePath = null) {
  return { severity, code, message, path: filePath };
}

function validateMetadata(metadata, filePath) {
  const findings = [];
  if (metadata.schema !== NODE_SCHEMA) {
    findings.push(finding("error", "NODE_SCHEMA", `expected ${NODE_SCHEMA}`, filePath));
  }
  if (typeof metadata.id !== "string" || metadata.id.length === 0) {
    findings.push(finding("error", "NODE_ID", "missing stable node id", filePath));
  }
  if (!NODE_TYPES.has(metadata.type)) {
    findings.push(finding("error", "NODE_TYPE", `unknown node type ${metadata.type}`, filePath));
  }
  if (!AUTHORITIES.has(metadata.authority)) {
    findings.push(finding("error", "NODE_AUTHORITY", `unknown authority ${metadata.authority}`, filePath));
  }
  if (!Array.isArray(metadata.relations)) {
    findings.push(finding("error", "NODE_RELATIONS", "relations must be an array", filePath));
  } else {
    const relationKeys = new Set();
    for (const relation of metadata.relations) {
      if (!relation || !RELATION_TYPES.has(relation.type) || typeof relation.target !== "string") {
        findings.push(finding("error", "NODE_RELATION", "invalid typed relation", filePath));
      } else {
        const relationKey = `${relation.type}\u0000${relation.target}`;
        if (relationKeys.has(relationKey)) {
          findings.push(
            finding(
              "error",
              "DUPLICATE_RELATION",
              `duplicate relation ${relation.type} -> ${relation.target}`,
              filePath
            )
          );
        }
        relationKeys.add(relationKey);
      }
    }
  }
  if (metadata.type === "collection") {
    if (!Array.isArray(metadata.records) || metadata.records.length === 0) {
      findings.push(
        finding(
          "error",
          "COLLECTION_RECORDS",
          "collection must own at least one record",
          filePath
        )
      );
    } else {
      for (const record of metadata.records) {
        if (
          !record ||
          typeof record.id !== "string" ||
          !NODE_TYPES.has(record.type) ||
          record.type === "collection"
        ) {
          findings.push(
            finding(
              "error",
              "COLLECTION_RECORD",
              "invalid collection record identity or type",
              filePath
            )
          );
        }
        if (!Array.isArray(record.relations)) {
          findings.push(
            finding(
              "error",
              "COLLECTION_RECORD_RELATIONS",
              `record ${record?.id ?? "<unknown>"} has invalid relations`,
              filePath
            )
          );
        } else {
          const relationKeys = new Set();
          for (const relation of record.relations) {
            if (
              !relation ||
              !RELATION_TYPES.has(relation.type) ||
              typeof relation.target !== "string"
            ) {
              findings.push(
                finding(
                  "error",
                  "COLLECTION_RECORD_RELATION",
                  `record ${record.id} has invalid typed relation`,
                  filePath
                )
              );
            } else {
              const relationKey = `${relation.type}\u0000${relation.target}`;
              if (relationKeys.has(relationKey)) {
                findings.push(
                  finding(
                    "error",
                    "DUPLICATE_RELATION",
                    `record ${record.id} has duplicate relation ${relation.type} -> ${relation.target}`,
                    filePath
                  )
                );
              }
              relationKeys.add(relationKey);
            }
          }
        }
        if (!AUTHORITIES.has(record.authority)) {
          findings.push(
            finding(
              "error",
              "COLLECTION_RECORD_AUTHORITY",
              `record ${record.id} has unknown authority ${record.authority}`,
              filePath
            )
          );
        }
      }
    }
  }
  return findings;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function recordBody(body, recordId) {
  const escaped = escapeRegExp(recordId);
  const pattern = new RegExp(
    `<!-- assistant-record:start ${escaped} -->\\s*([\\s\\S]*?)\\s*<!-- assistant-record:end ${escaped} -->`,
    "u"
  );
  return body.match(pattern)?.[1] ?? null;
}

function validateProfileSemantics(node, profile) {
  const findings = [];
  const headings =
    PROFILE_WORKFLOW_HEADINGS[profile] ?? PROFILE_WORKFLOW_HEADINGS.research;
  const profileLabel = profile === "software" ? "SOFTWARE" : "RESEARCH";
  const candidates =
    node.metadata.type === "collection"
      ? node.metadata.records.map((record) => ({
          metadata: record,
          body: recordBody(node.body, record.id)
        }))
      : [{ metadata: node.metadata, body: node.body }];
  for (const candidate of candidates) {
    const required = headings[candidate.metadata.type];
    if (!required) continue;
    if (candidate.metadata.origin === "bootstrap") {
      if (!candidate.metadata.workflow_schema) {
        findings.push(
          finding(
            "warning",
            "BOOTSTRAP_SEMANTIC_GAP",
            `${candidate.metadata.id} requires workflow normalization when next touched`,
            node.path
          )
        );
      }
      continue;
    }
    if (
      candidate.metadata.workflow_schema !==
      `${profile}.${candidate.metadata.type}/v1`
    ) {
      findings.push(
        finding(
          "error",
          `${profileLabel}_WORKFLOW_SCHEMA`,
          `${candidate.metadata.id} is missing ${profile}.${candidate.metadata.type}/v1`,
          node.path
        )
      );
      continue;
    }
    if (!candidate.body) {
      findings.push(
          finding(
            "error",
            `${profileLabel}_RECORD_BOUNDARY`,
          `${candidate.metadata.id} has no stable record boundary`,
          node.path
        )
      );
      continue;
    }
    for (const heading of required) {
      const headingPattern = new RegExp(
        `^### ${escapeRegExp(heading)}\\s*\\r?\\n\\s*\\S`,
        "mu"
      );
      if (!headingPattern.test(candidate.body)) {
        findings.push(
          finding(
            "error",
            `${profileLabel}_REQUIRED_FIELD`,
            `${candidate.metadata.id} is missing non-empty "${heading}"`,
            node.path
          )
        );
      }
    }
  }
  return findings;
}

export async function loadCanonicalNodes(target) {
  const root = path.resolve(target);
  const candidates = [];
  for (const relative of REQUIRED_CANONICAL_FILES) {
    candidates.push(relative);
  }

  const knowledgeRoot = path.join(root, ".assistant", "knowledge");
  if (await pathExists(knowledgeRoot)) {
    const entries = await listFilesRecursive(knowledgeRoot);
    for (const entry of entries) {
      if (entry.kind === "file" && entry.path.toLowerCase().endsWith(".md")) {
        candidates.push(`.assistant/knowledge/${entry.path}`);
      }
    }
  }

  const planPath = path.join(root, ".assistant", "PLAN.md");
  if (await pathExists(planPath)) candidates.push(".assistant/PLAN.md");

  const nodes = [];
  const loadFindings = [];
  for (const relative of candidates) {
    const absolute = path.join(root, ...relative.split("/"));
    if (!(await pathExists(absolute))) {
      loadFindings.push(finding("error", "MISSING_CANONICAL", `missing ${relative}`, relative));
      continue;
    }
    try {
      const content = await readUtf8(absolute);
      const parsed = parseNodeDocument(content, relative);
      nodes.push({ ...parsed, path: relative, bytes: Buffer.byteLength(content, "utf8") });
    } catch (error) {
      loadFindings.push(finding("error", "NODE_PARSE", error.message, relative));
    }
  }
  return { nodes, findings: loadFindings };
}

export async function validateProject(target) {
  const root = path.resolve(target);
  const findings = [];

  const manifestPath = path.join(root, ".assistant", "manifest.json");
  let manifest = null;
  if (!(await pathExists(manifestPath))) {
    findings.push(finding("error", "MANIFEST_MISSING", "missing .assistant/manifest.json", ".assistant/manifest.json"));
  } else {
    try {
      manifest = JSON.parse(await readUtf8(manifestPath));
      if (manifest.schema !== MANIFEST_SCHEMA) {
        findings.push(finding("error", "MANIFEST_SCHEMA", `expected ${MANIFEST_SCHEMA}`, ".assistant/manifest.json"));
      }
      if (!PROJECT_PROFILES.has(manifest.profile)) {
        findings.push(
          finding(
            "error",
            "PROJECT_PROFILE",
            `invalid ${manifest.profile}`,
            ".assistant/manifest.json"
          )
        );
      }
      if (!INITIALIZATION_STATUSES.has(manifest.initialization_status)) {
        findings.push(finding("error", "INITIALIZATION_STATUS", `invalid ${manifest.initialization_status}`, ".assistant/manifest.json"));
      }
      if (!ACTIVITY_STATUSES.has(manifest.activity_status)) {
        findings.push(finding("error", "ACTIVITY_STATUS", `invalid ${manifest.activity_status}`, ".assistant/manifest.json"));
      }
    } catch (error) {
      findings.push(finding("error", "MANIFEST_PARSE", error.message, ".assistant/manifest.json"));
    }
  }

  const loaded = await loadCanonicalNodes(root);
  findings.push(...loaded.findings);
  try {
    const integrity = await inspectValidatedHashes(root);
    if (integrity.status !== "clean") {
      findings.push(
        finding(
          "warning",
          integrity.status === "missing"
            ? "INTEGRITY_LEDGER_MISSING"
            : "CANONICAL_UNINTEGRATED_EDIT",
          integrity.status === "missing"
            ? "validated hash ledger is missing"
            : `canonical files changed outside a validated transaction: ${[
                ...integrity.changed,
                ...integrity.added,
                ...integrity.removed
              ].join(", ")}`,
          ".assistant/internal/validated-hashes.json"
        )
      );
    }
  } catch (error) {
    findings.push(
      finding(
        "error",
        "INTEGRITY_LEDGER_INVALID",
        error.message,
        ".assistant/internal/validated-hashes.json"
      )
    );
  }
  const indexPath = path.join(root, ".assistant", "INDEX.md");
  if (!(await pathExists(indexPath))) {
    findings.push(
      finding("error", "INDEX_MISSING", "missing generated index", ".assistant/INDEX.md")
    );
  } else {
    const actualIndex = await readUtf8(indexPath);
    const expectedIndex = renderIndex(loaded.nodes);
    if (actualIndex !== expectedIndex) {
      findings.push(
        finding(
          "error",
          "INDEX_STALE",
          "generated index does not match canonical owners",
          ".assistant/INDEX.md"
        )
      );
    }
  }
  const ids = new Map();
  const idTypes = new Map();
  const profile = manifest?.profile ?? "research";
  const profileRelationRequirements =
    PROFILE_RELATION_REQUIREMENTS[profile] ??
    PROFILE_RELATION_REQUIREMENTS.research;
  const forbiddenRelations =
    PROFILE_FORBIDDEN_RELATIONS[profile] ??
    PROFILE_FORBIDDEN_RELATIONS.research;
  const profileLabel = profile === "software" ? "SOFTWARE" : "RESEARCH";
  const allowedTypes =
    PROFILE_ALLOWED_TYPES[profile] ?? PROFILE_ALLOWED_TYPES.research;
  if (
    manifest &&
    !["ready", "ready_with_gaps"].includes(manifest.initialization_status)
  ) {
    const prematurelyActive = loaded.nodes.filter(
      (node) =>
        node.path.startsWith(".assistant/knowledge/") &&
        (
          node.metadata.origin === "bootstrap" ||
          (node.metadata.records ?? []).some(
            (record) => record.origin === "bootstrap"
          )
        )
    );
    for (const node of prematurelyActive) {
      findings.push(
        finding(
          "error",
          "BOOTSTRAP_PREMATURE_ACTIVATION",
          "bootstrap-derived knowledge is active while initialization is not ready",
          node.path
        )
      );
    }
  }
  for (const node of loaded.nodes) {
    findings.push(...validateMetadata(node.metadata, node.path));
    for (const candidate of [
      node.metadata,
      ...(node.metadata.records ?? [])
    ]) {
      if (!allowedTypes.has(candidate.type)) {
        findings.push(
          finding(
            "error",
            "PROFILE_NODE_TYPE",
            `${candidate.id} uses ${candidate.type}, which is not allowed by the ${profile} profile`,
            node.path
          )
        );
      }
    }
    findings.push(...validateProfileSemantics(node, profile));
    if (ids.has(node.metadata.id)) {
      findings.push(finding("error", "DUPLICATE_NODE_ID", `${node.metadata.id} also owned by ${ids.get(node.metadata.id)}`, node.path));
    } else {
      ids.set(node.metadata.id, node.path);
      idTypes.set(node.metadata.id, node.metadata.type);
    }
    for (const record of node.metadata.records ?? []) {
      if (ids.has(record.id)) {
        findings.push(
          finding(
            "error",
            "DUPLICATE_NODE_ID",
            `${record.id} also owned by ${ids.get(record.id)}`,
            node.path
          )
        );
      } else {
        ids.set(record.id, node.path);
        idTypes.set(record.id, record.type);
      }
    }

    if (node.bytes > BOUNDEDNESS_DEFAULTS.hardBytes) {
      findings.push(finding("error", "BOUNDEDNESS_HARD", `${node.bytes} bytes exceeds hard gate`, node.path));
    } else if (node.bytes > BOUNDEDNESS_DEFAULTS.softBytes) {
      findings.push(finding("warning", "BOUNDEDNESS_SOFT", `${node.bytes} bytes exceeds soft warning`, node.path));
    }

    if (node.metadata.type === "policy") {
      try {
        const policyContent = await readUtf8(path.join(root, ...node.path.split("/")));
        findings.push(...validatePolicyRules(parsePolicyRules(policyContent, node.path)).map((item) => ({ ...item, path: node.path })));
      } catch (error) {
        findings.push(finding("error", "POLICY_PARSE", error.message, node.path));
      }
    }
  }

  const currentNode = loaded.nodes.find((node) => node.metadata.type === "current");
  if (currentNode && manifest) {
    if (
      !INITIALIZATION_STATUSES.has(
        currentNode.metadata.initialization_status
      )
    ) {
      findings.push(
        finding(
          "error",
          "CURRENT_INITIALIZATION_STATUS",
          `invalid ${currentNode.metadata.initialization_status}`,
          currentNode.path
        )
      );
    }
    if (!ACTIVITY_STATUSES.has(currentNode.metadata.activity_status)) {
      findings.push(
        finding(
          "error",
          "CURRENT_ACTIVITY_STATUS",
          `invalid ${currentNode.metadata.activity_status}`,
          currentNode.path
        )
      );
    }
    if (!AUTHORIZATION_STATES.has(currentNode.metadata.authorization)) {
      findings.push(
        finding(
          "error",
          "CURRENT_AUTHORIZATION",
          `invalid ${currentNode.metadata.authorization}`,
          currentNode.path
        )
      );
    }
    if (
      currentNode.metadata.initialization_status !==
      manifest.initialization_status
    ) {
      findings.push(
        finding(
          "error",
          "CURRENT_MANIFEST_DRIFT",
          "CURRENT initialization_status differs from manifest",
          currentNode.path
        )
      );
    }
    if (currentNode.metadata.activity_status !== manifest.activity_status) {
      findings.push(
        finding(
          "error",
          "CURRENT_MANIFEST_DRIFT",
          "CURRENT activity_status differs from manifest",
          currentNode.path
        )
      );
    }
  }

  for (const node of loaded.nodes) {
    const relationOwners = [
      { id: node.metadata.id, relations: node.metadata.relations ?? [] },
      ...(node.metadata.records ?? []).map((record) => ({
        id: record.id,
        relations: record.relations ?? []
      }))
    ];
    for (const relationOwner of relationOwners) {
      for (const relation of relationOwner.relations) {
      if (!ids.has(relation.target)) {
          findings.push(
            finding(
              "error",
              "MISSING_RELATION_TARGET",
              `${relationOwner.id} ${relation.type} targets missing ${relation.target}`,
              node.path
            )
          );
        }
      }
      const ownerType = idTypes.get(relationOwner.id);
      const ownerMetadata =
        relationOwner.id === node.metadata.id
          ? node.metadata
          : (node.metadata.records ?? []).find(
              (record) => record.id === relationOwner.id
            );
      if (ownerMetadata?.origin !== "bootstrap") {
        const requirement = profileRelationRequirements[ownerType];
        if (
          requirement &&
          !requirement.alternatives.some((alternative) =>
            relationOwner.relations.some(
              (relation) =>
                alternative.relations.includes(relation.type) &&
                alternative.targets.includes(idTypes.get(relation.target))
            )
          )
        ) {
          findings.push(
            finding(
              "error",
              `${profileLabel}_REQUIRED_RELATION`,
              `${relationOwner.id} requires a valid semantic parent relation`,
              node.path
            )
          );
        }
      }
      for (const relation of relationOwner.relations) {
        if (
          forbiddenRelations[ownerType]?.includes(relation.type)
        ) {
          findings.push(
            finding(
              "error",
              `${profileLabel}_RELATION_DIRECTION`,
              `${relationOwner.id} cannot use ${relation.type} as a ${ownerType}`,
              node.path
            )
          );
        }
      }
    }
  }

  const errors = findings.filter((item) => item.severity === "error");
  const warnings = findings.filter((item) => item.severity === "warning");
  return {
    schema: "assistant.validation/v1",
    target: root,
    valid: errors.length === 0,
    summary: {
      nodes: loaded.nodes.length,
      errors: errors.length,
      warnings: warnings.length
    },
    manifest,
    nodes: loaded.nodes.map((node) => ({
      id: node.metadata.id,
      type: node.metadata.type,
      path: node.path,
      bytes: node.bytes,
      hash: node.contentHash,
      records: (node.metadata.records ?? []).map((record) => ({
        id: record.id,
        type: record.type,
        status: record.status
      }))
    })),
    findings
  };
}
