import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { BOUNDEDNESS_DEFAULTS } from "./contract.mjs";
import { pathExists, writeUtf8 } from "./files.mjs";
import { parseNodeDocument, serializeNodeDocument } from "./meta.mjs";
import { loadCanonicalNodes, validateProject } from "./validator.mjs";
import { renderIndex } from "./projection.mjs";
import { refreshValidatedHashes } from "./integrity.mjs";

const GROUPS = Object.freeze({
  foundation: {
    key: "foundation",
    ownerId: "COL-FOUNDATION",
    title: "Project foundation",
    path: ".assistant/knowledge/FOUNDATION.md"
  },
  plan: {
    key: "plan",
    ownerId: "COL-ACTIVE-PLAN",
    title: "Active plan",
    path: ".assistant/PLAN.md"
  },
  question: {
    key: "research_agenda",
    ownerId: "COL-RESEARCH-AGENDA",
    title: "Research agenda",
    path: ".assistant/knowledge/research/AGENDA.md"
  },
  hypothesis: {
    key: "research_agenda",
    ownerId: "COL-RESEARCH-AGENDA",
    title: "Research agenda",
    path: ".assistant/knowledge/research/AGENDA.md"
  },
  literature: {
    key: "research_agenda",
    ownerId: "COL-RESEARCH-AGENDA",
    title: "Research agenda",
    path: ".assistant/knowledge/research/AGENDA.md"
  },
  experiment: {
    key: "research_evidence",
    ownerId: "COL-RESEARCH-EVIDENCE",
    title: "Research evidence",
    path: ".assistant/knowledge/research/EVIDENCE.md"
  },
  evidence: {
    key: "research_evidence",
    ownerId: "COL-RESEARCH-EVIDENCE",
    title: "Research evidence",
    path: ".assistant/knowledge/research/EVIDENCE.md"
  },
  dataset: {
    key: "research_evidence",
    ownerId: "COL-RESEARCH-EVIDENCE",
    title: "Research evidence",
    path: ".assistant/knowledge/research/EVIDENCE.md"
  },
  work: {
    key: "operations",
    ownerId: "COL-ACTIVE-OPERATIONS",
    title: "Active operations",
    path: ".assistant/knowledge/work/ACTIVE.md"
  },
  issue: {
    key: "operations",
    ownerId: "COL-ACTIVE-OPERATIONS",
    title: "Active operations",
    path: ".assistant/knowledge/work/ACTIVE.md"
  },
  risk: {
    key: "operations",
    ownerId: "COL-ACTIVE-OPERATIONS",
    title: "Active operations",
    path: ".assistant/knowledge/work/ACTIVE.md"
  },
  decision: {
    key: "decisions",
    ownerId: "COL-DECISIONS",
    title: "Decisions",
    path: ".assistant/knowledge/decisions/DECISIONS.md"
  },
  history: {
    key: "history",
    ownerId: "COL-HISTORY",
    title: "Plan and project history",
    path: ".assistant/knowledge/history/HISTORY.md"
  },
  environment: {
    key: "environment",
    ownerId: "COL-ENVIRONMENT",
    title: "Environment and conventions",
    path: ".assistant/knowledge/environment/ENVIRONMENT.md"
  },
  requirement: {
    key: "software_architecture",
    ownerId: "COL-SOFTWARE-ARCHITECTURE",
    title: "Software requirements and design",
    path: ".assistant/knowledge/software/ARCHITECTURE.md"
  },
  design: {
    key: "software_architecture",
    ownerId: "COL-SOFTWARE-ARCHITECTURE",
    title: "Software requirements and design",
    path: ".assistant/knowledge/software/ARCHITECTURE.md"
  },
  task: {
    key: "software_delivery",
    ownerId: "COL-SOFTWARE-DELIVERY",
    title: "Software delivery",
    path: ".assistant/knowledge/software/DELIVERY.md"
  },
  test: {
    key: "software_delivery",
    ownerId: "COL-SOFTWARE-DELIVERY",
    title: "Software delivery",
    path: ".assistant/knowledge/software/DELIVERY.md"
  },
  release: {
    key: "software_delivery",
    ownerId: "COL-SOFTWARE-DELIVERY",
    title: "Software delivery",
    path: ".assistant/knowledge/software/DELIVERY.md"
  }
});

const RESEARCH_PROFILE_GROUPS = Object.freeze({
  requirement: {
    key: "research_methodology",
    ownerId: "COL-RESEARCH-METHODOLOGY",
    title: "Research methodology and requirements",
    path: ".assistant/knowledge/research/METHODOLOGY.md"
  },
  design: {
    key: "research_methodology",
    ownerId: "COL-RESEARCH-METHODOLOGY",
    title: "Research methodology and requirements",
    path: ".assistant/knowledge/research/METHODOLOGY.md"
  }
});

const SOFTWARE_PROFILE_GROUPS = Object.freeze({
  evidence: {
    key: "software_verification",
    ownerId: "COL-SOFTWARE-VERIFICATION",
    title: "Software verification evidence",
    path: ".assistant/knowledge/software/VERIFICATION.md"
  },
  test: {
    key: "software_verification",
    ownerId: "COL-SOFTWARE-VERIFICATION",
    title: "Software verification evidence",
    path: ".assistant/knowledge/software/VERIFICATION.md"
  }
});

function activationGroup(type, profile) {
  if (profile === "research" && RESEARCH_PROFILE_GROUPS[type]) {
    return RESEARCH_PROFILE_GROUPS[type];
  }
  if (profile === "software" && SOFTWARE_PROFILE_GROUPS[type]) {
    return SOFTWARE_PROFILE_GROUPS[type];
  }
  return GROUPS[type];
}

const BOOTSTRAP_AUTHORIZATION_STATES = new Set([
  "active",
  "parallel_allowed",
  "blocked",
  "not_authorized",
  "completed",
  "superseded"
]);

function bootstrapAuthorization(summary = {}) {
  const candidate = summary.authorization_state;
  if (!BOOTSTRAP_AUTHORIZATION_STATES.has(candidate)) {
    return "not_authorized";
  }
  if (
    ["active", "parallel_allowed"].includes(candidate) &&
    (
      !Array.isArray(summary.authorized_work) ||
      summary.authorized_work.length === 0 ||
      !Array.isArray(summary.authorization_basis_paths) ||
      summary.authorization_basis_paths.length === 0
    )
  ) {
    return "not_authorized";
  }
  return candidate;
}

function summaryList(values, fallback) {
  return Array.isArray(values) && values.length > 0
    ? values.map((value) => `\`${value}\``).join("; ")
    : fallback;
}

function currentStateBody(status, summary, gaps, timestamp) {
  const authorization = bootstrapAuthorization(summary);
  return `# Current state

- Initialization: \`${status}\`
- Activity: \`idle\`
- Active work: none
- Authorization state: \`${authorization}\`
- Current authorization: ${summary.current_authorization ?? "no new material execution is implied by bootstrap"}
- Currently authorized work: ${summaryList(summary.authorized_work, "none established")}
- Blocked or conditional work: ${summaryList(summary.blocked_work, "none separately enumerated")}
- Authorization basis: ${summaryList(summary.authorization_basis_paths, "none established")}
- Current project state: ${summary.current_state ?? "unknown"}
- Next safe route: ${summary.next_safe_route ?? "await user direction"}
- Noncritical documentation gap IDs: ${gaps.length > 0 ? gaps.map((gap) => `\`${gap.id}\``).join(", ") : "none"}
- Last verified: \`${timestamp}\`
`;
}

function activationTransactionRoot(root) {
  return path.join(root, ".assistant", "internal", "transactions");
}

async function activationRecords(root, status) {
  const transactionsRoot = activationTransactionRoot(root);
  if (!(await pathExists(transactionsRoot))) return [];
  const records = [];
  for (const entry of await readdir(transactionsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const recordPath = path.join(transactionsRoot, entry.name, "record.json");
    if (!(await pathExists(recordPath))) continue;
    const record = JSON.parse(await readFile(recordPath, "utf8"));
    if (
      record.type === "bootstrap_activation" &&
      record.status === status
    ) {
      records.push(record);
    }
  }
  return records;
}

async function latestCommittedActivation(root) {
  const committed = await activationRecords(root, "committed");
  return committed.sort((left, right) =>
    String(right.committed_at).localeCompare(String(left.committed_at), "en")
  )[0] ?? null;
}

function rootRelativePath(root, relative) {
  if (
    typeof relative !== "string" ||
    path.isAbsolute(relative) ||
    relative.split("/").includes("..")
  ) {
    throw new Error(`unsafe activation path: ${relative}`);
  }
  const resolved = path.resolve(root, ...relative.split("/"));
  const assistantRoot = path.resolve(root, ".assistant");
  if (
    resolved === assistantRoot ||
    !resolved.startsWith(`${assistantRoot}${path.sep}`)
  ) {
    throw new Error(`activation path escapes .assistant: ${relative}`);
  }
  return resolved;
}

async function rollbackApplyingActivation(
  root,
  record,
  { recovery = "startup_recovery", error = null } = {}
) {
  const recordPath = path.join(
    activationTransactionRoot(root),
    record.id,
    "record.json"
  );
  for (const relative of [...(record.planned_paths ?? [])].reverse()) {
    const destination = rootRelativePath(root, relative);
    if (await pathExists(destination)) {
      await rm(destination, { force: true });
    }
  }
  for (const backup of record.backups ?? []) {
    const destination = rootRelativePath(root, backup.target);
    const source = path.join(
      activationTransactionRoot(root),
      record.id,
      ...backup.backup.split("/")
    );
    await writeUtf8(destination, await readFile(source, "utf8"));
  }
  const rolledBackAt = new Date().toISOString();
  await writeUtf8(
    recordPath,
    `${JSON.stringify({
      ...record,
      status: "rolled_back",
      recovery,
      ...(error ? { error } : {}),
      rolled_back_at: rolledBackAt
    }, null, 2)}\n`
  );
  return record.id;
}

async function recoverApplyingActivations(root) {
  const applying = await activationRecords(root, "applying");
  const recovered = [];
  for (const record of applying.sort((left, right) =>
    String(left.started_at).localeCompare(String(right.started_at), "en")
  )) {
    recovered.push(await rollbackApplyingActivation(root, record));
  }
  return recovered;
}

async function reconcileCommittedActivation(root, record) {
  for (const relative of record.created_paths ?? []) {
    if (!(await pathExists(path.join(root, ...relative.split("/"))))) {
      throw new Error(
        `committed activation is incomplete; missing ${relative}`
      );
    }
  }
  const bootstrapRoot = path.join(root, ".assistant", "internal", "bootstrap");
  const output = JSON.parse(
    await readFile(path.join(bootstrapRoot, "model-result.json"), "utf8")
  );
  await assertClosedBookReady(root, output);
  const status = output.gaps.length > 0 ? "ready_with_gaps" : "ready";
  const timestamp = new Date().toISOString();
  const manifestPath = path.join(root, ".assistant", "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.initialization_status = status;
  manifest.activity_status = "idle";
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  const currentPath = path.join(root, ".assistant", "CURRENT.md");
  const current = parseNodeDocument(await readFile(currentPath, "utf8"));
  current.metadata.initialization_status = status;
  current.metadata.activity_status = "idle";
  current.metadata.active_work_id = null;
  const summary = output.project_summary;
  current.metadata.authorization = bootstrapAuthorization(summary);
  current.metadata.verified_at = timestamp;
  const body = currentStateBody(
    status,
    summary,
    output.gaps,
    timestamp
  );
  await writeFile(
    currentPath,
    serializeNodeDocument(current.metadata, body),
    "utf8"
  );
  const loaded = await loadCanonicalNodes(root);
  if (loaded.findings.some((item) => item.severity === "error")) {
    throw new Error(
      `committed activation owners are invalid: ${JSON.stringify(loaded.findings)}`
    );
  }
  await writeFile(
    path.join(root, ".assistant", "INDEX.md"),
    renderIndex(loaded.nodes),
    "utf8"
  );
  const statePath = path.join(bootstrapRoot, "state.json");
  const state = JSON.parse(await readFile(statePath, "utf8"));
  state.phase = "activating";
  state.status = status;
  state.semantic_survey_complete = true;
  state.closed_book_validated = true;
  state.activated_at = record.committed_at;
  state.transaction_id = record.id;
  state.reconciled_at = timestamp;
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await refreshValidatedHashes(
    root,
    `bootstrap_activation_reconcile:${record.id}`
  );
  const validation = await validateProject(root);
  if (!validation.valid) {
    throw new Error(
      `reconciled activation failed validation: ${JSON.stringify(validation.findings)}`
    );
  }
  return {
    schema: "assistant.activation-result/v1",
    status,
    transaction_id: record.id,
    canonical_documents: record.created_paths?.length ?? null,
    semantic_records: output.candidate_nodes.length,
    validation,
    idempotent: true,
    reconciled: true
  };
}

function groupCandidates(candidates, profile) {
  const groups = new Map();
  for (const candidate of candidates) {
    const definition = activationGroup(candidate.type, profile);
    if (!definition) throw new Error(`no activation group for ${candidate.type}`);
    const group = groups.get(definition.key) ?? {
      ...definition,
      records: []
    };
    group.records.push(candidate);
    groups.set(definition.key, group);
  }
  return [...groups.values()];
}

function replaceRestrictedReferences(value, snapshotMap) {
  let result = value;
  for (const [originalPath, snapshotId] of snapshotMap) {
    result = result.replaceAll(originalPath, snapshotId);
  }
  return result;
}

function canonicalEvidencePaths(paths, snapshotMap) {
  return paths.map((evidencePath) =>
    snapshotMap.get(evidencePath) ?? evidencePath
  );
}

function evidenceUnitsByTarget(output) {
  const byTarget = new Map();
  for (const coverage of output.semantic_coverage ?? []) {
    for (const target of coverage.target_ids ?? []) {
      const values = byTarget.get(target) ?? [];
      values.push(coverage.unit_id);
      byTarget.set(target, values);
    }
  }
  return byTarget;
}

async function assertClosedBookReady(root, output) {
  const audit = output.closed_book_audit;
  const lineage = output.lineage;
  const unresolvedSurfaces = [];
  for (const surface of output.legacy_surfaces ?? []) {
    if (
      ["canonical_candidate", "competing_control_surface"].includes(
        surface.status
      )
    ) {
      unresolvedSurfaces.push(surface.path);
      continue;
    }
    if (
      surface.status === "repository_native" &&
      (surface.roles ?? []).some((role) =>
        ["current", "plan", "decision", "authorization", "router"].includes(role)
      )
    ) {
      unresolvedSurfaces.push(surface.path);
      continue;
    }
    if (surface.status === "resolved") {
      if (
        !["integrate_then_move", "integrate_then_remove"].includes(
          surface.proposed_action
        )
      ) {
        unresolvedSurfaces.push(surface.path);
        continue;
      }
      const absolute = path.resolve(root, surface.path);
      const relative = path.relative(root, absolute);
      if (
        relative.startsWith("..") ||
        path.isAbsolute(relative) ||
        await pathExists(absolute)
      ) {
        unresolvedSurfaces.push(surface.path);
      }
    }
  }
  if (
    !lineage?.complete ||
    (output.candidate_nodes?.length > 0 &&
      ((lineage?.origin_ids ?? []).length === 0 ||
        (lineage?.current_ids ?? []).length === 0)) ||
    !audit?.origin_to_current_explainable ||
    !audit?.current_authorization_explainable ||
    !audit?.hypotheses_explainable ||
    !audit?.decisions_explainable ||
    (audit?.live_legacy_dependencies ?? []).length > 0 ||
    (audit?.missing_concerns ?? []).length > 0 ||
    unresolvedSurfaces.length > 0
  ) {
    throw new Error(
      "closed-book activation blocked: semantic lineage or legacy migration is incomplete"
    );
  }
}

function canonicalRecord(record, snapshotMap, profile, evidenceUnitMap) {
  return {
    id: record.id,
    type: record.type,
    status: record.status,
    authority:
      record.authority === "canonical_user_approved"
        ? "canonical_user_approved"
        : "canonical_agent",
    certainty: record.certainty,
    relations: record.relations,
    evidence_units: evidenceUnitMap.get(record.id) ?? [],
    snapshot_evidence: canonicalEvidencePaths(record.evidence_paths, snapshotMap)
      .filter((value) => /^SNAP-/u.test(value)),
    legacy_aliases: record.legacy_aliases,
    origin: "bootstrap",
    ...(record.semantic_sections?.length > 0
      ? { workflow_schema: `${profile}.${record.type}/v1` }
      : {})
  };
}

function semanticRecordBody(record, snapshotMap) {
  return (record.semantic_sections ?? [])
    .map(
      (section) =>
        `### ${section.heading}\n\n${replaceRestrictedReferences(
          section.content.trim(),
          snapshotMap
        )}`
    )
    .join("\n\n") ||
    replaceRestrictedReferences(record.body.trim(), snapshotMap);
}

function collectionDocument(
  group,
  timestamp,
  snapshotMap,
  profile,
  evidenceUnitMap
) {
  const records = group.records.map((record) =>
    canonicalRecord(record, snapshotMap, profile, evidenceUnitMap)
  );
  const metadata = {
    schema: "assistant.node/v1",
    id: group.ownerId,
    type: "collection",
    collection_kind: group.key,
    status: "active",
    authority: "canonical_agent",
    relations: records.map((record) => ({
      type: "contains",
      target: record.id
    })),
    records,
    verified_at: timestamp
  };
  const sections = [`# ${group.title}`];
  for (const record of group.records) {
    sections.push("");
    sections.push(`<!-- assistant-record:start ${record.id} -->`);
    sections.push(`## ${record.id}: ${record.title}`);
    sections.push("");
    sections.push(`- Type: \`${record.type}\``);
    sections.push(`- Status: \`${record.status}\``);
    sections.push(`- Certainty: \`${record.certainty}\``);
    if (record.legacy_aliases.length > 0) {
      sections.push(`- Legacy aliases: ${record.legacy_aliases.map((alias) => `\`${alias}\``).join(", ")}`);
    }
    sections.push("");
    sections.push(semanticRecordBody(record, snapshotMap));
    sections.push(`<!-- assistant-record:end ${record.id} -->`);
  }
  return serializeNodeDocument(metadata, `${sections.join("\n")}\n`);
}

function standalonePath(record, profile) {
  const directories = {
    question: "research/questions",
    hypothesis: "research/hypotheses",
    literature: "research/literature",
    experiment: "research/experiments",
    evidence: "research/evidence",
    dataset: "research/datasets",
    requirement: "software/requirements",
    design: "software/design",
    task: "software/tasks",
    test: "software/tests",
    release: "software/releases",
    work: "work/items",
    issue: "work/issues",
    risk: "risks",
    decision: "decisions",
    history: "history",
    environment: "environment",
    plan: "plans",
    foundation: "foundations"
  };
  if (
    profile === "research" &&
    (record.type === "requirement" || record.type === "design")
  ) {
    return `.assistant/knowledge/research/methodology/${record.id}.md`;
  }
  if (
    profile === "software" &&
    (record.type === "evidence" || record.type === "dataset")
  ) {
    return `.assistant/knowledge/software/${record.type}/${record.id}.md`;
  }
  return `.assistant/knowledge/${directories[record.type]}/${record.id}.md`;
}

function standaloneDocument(
  record,
  timestamp,
  snapshotMap,
  profile,
  evidenceUnitMap
) {
  const metadata = {
    schema: "assistant.node/v1",
    ...canonicalRecord(record, snapshotMap, profile, evidenceUnitMap),
    verified_at: timestamp
  };
  return serializeNodeDocument(
    metadata,
    `# ${record.title}\n\n${semanticRecordBody(record, snapshotMap)}\n`
  );
}

function splitOversizedGroups(
  groups,
  timestamp,
  snapshotMap,
  profile,
  evidenceUnitMap
) {
  const result = [];
  for (const original of groups) {
    const group = { ...original, records: [...original.records] };
    if (
      Buffer.byteLength(
        collectionDocument(
          group,
          timestamp,
          snapshotMap,
          profile,
          evidenceUnitMap
        ),
        "utf8"
      ) <= BOUNDEDNESS_DEFAULTS.hardBytes
    ) {
      result.push(group);
      continue;
    }
    const candidates = group.records
      .map((record) => ({
        record,
        bytes: Buffer.byteLength(
          standaloneDocument(
            record,
            timestamp,
            snapshotMap,
            profile,
            evidenceUnitMap
          ),
          "utf8"
        )
      }))
      .sort(
        (left, right) =>
          right.bytes - left.bytes ||
          left.record.id.localeCompare(right.record.id, "en")
      );
    const promoted = [];
    while (
      group.records.length > 0 &&
      Buffer.byteLength(
        collectionDocument(
          group,
          timestamp,
          snapshotMap,
          profile,
          evidenceUnitMap
        ),
        "utf8"
      ) > BOUNDEDNESS_DEFAULTS.softBytes
    ) {
      const next = candidates.shift();
      group.records = group.records.filter(
        (record) => record.id !== next.record.id
      );
      promoted.push(next.record);
    }
    if (group.records.length > 0) result.push(group);
    for (const record of promoted) {
      const standalone = {
        key: record.type,
        ownerId: record.id,
        title: record.title,
        path: standalonePath(record, profile),
        records: [record],
        standalone: true
      };
      const bytes = Buffer.byteLength(
        standaloneDocument(
          record,
          timestamp,
          snapshotMap,
          profile,
          evidenceUnitMap
        ),
        "utf8"
      );
      if (bytes > BOUNDEDNESS_DEFAULTS.hardBytes) {
        throw new Error(
          `bootstrap record ${record.id} exceeds hard boundedness after promotion`
        );
      }
      result.push(standalone);
    }
  }
  return result;
}

export async function activateBootstrap(target) {
  const root = path.resolve(target);
  const recoveredTransactions = await recoverApplyingActivations(root);
  const committed = await latestCommittedActivation(root);
  if (committed) {
    const result = await reconcileCommittedActivation(root, committed);
    return {
      ...result,
      recovered_transactions: recoveredTransactions
    };
  }
  const pendingRoot = path.join(root, ".assistant", "internal", "pending");
  if (await pathExists(pendingRoot)) {
    const pendingEntries = await import("node:fs/promises").then(({ readdir }) =>
      readdir(pendingRoot)
    );
    if (pendingEntries.length > 0) {
      throw new Error(
        `activation blocked: pending system migration (${pendingEntries.join(", ")})`
      );
    }
  }
  const bootstrapRoot = path.join(root, ".assistant", "internal", "bootstrap");
  const output = JSON.parse(
    await readFile(path.join(bootstrapRoot, "model-result.json"), "utf8")
  );
  const critical = output.gaps.filter(
    (gap) => gap.blocking_level === "initialization"
  );
  const material = output.conflicts.filter((conflict) => conflict.material);
  if (critical.length > 0 || material.length > 0) {
    throw new Error(
      `activation blocked: critical_gaps=${critical.length}, material_conflicts=${material.length}`
    );
  }
  await assertClosedBookReady(root, output);

  const manifestPath = path.join(root, ".assistant", "manifest.json");
  const beforeManifest = await readFile(manifestPath, "utf8");
  const manifest = JSON.parse(beforeManifest);
  const profile = manifest.profile ?? "research";
  const initialGroups = groupCandidates(output.candidate_nodes, profile);
  const snapshotManifestPath = path.join(
    bootstrapRoot,
    "restricted-snapshots.json"
  );
  const snapshotManifest = await pathExists(snapshotManifestPath)
    ? JSON.parse(await readFile(snapshotManifestPath, "utf8"))
    : { records: [] };
  const snapshotMap = new Map(
    snapshotManifest.records.map((record) => [
      record.original_path,
      record.snapshot_id
    ])
  );
  const timestamp = new Date().toISOString();
  const evidenceUnitMap = evidenceUnitsByTarget(output);
  const groups = splitOversizedGroups(
    initialGroups,
    timestamp,
    snapshotMap,
    profile,
    evidenceUnitMap
  );
  const transactionId = `TXN-${randomUUID()}`;
  const transactionRoot = path.join(
    root,
    ".assistant",
    "internal",
    "transactions",
    transactionId
  );
  await mkdir(transactionRoot, { recursive: true });
  const currentPath = path.join(root, ".assistant", "CURRENT.md");
  const indexPath = path.join(root, ".assistant", "INDEX.md");
  const integrityPath = path.join(
    root,
    ".assistant",
    "internal",
    "validated-hashes.json"
  );
  const statePath = path.join(bootstrapRoot, "state.json");
  const beforeCurrent = await readFile(currentPath, "utf8");
  const beforeIndex = await readFile(indexPath, "utf8");
  const beforeIntegrity = await readFile(integrityPath, "utf8");
  const beforeState = await readFile(statePath, "utf8");
  const plannedPaths = groups.map((group) => group.path);
  const backups = [
    ["manifest.json", ".assistant/manifest.json", beforeManifest],
    ["CURRENT.md", ".assistant/CURRENT.md", beforeCurrent],
    ["INDEX.md", ".assistant/INDEX.md", beforeIndex],
    [
      "validated-hashes.json",
      ".assistant/internal/validated-hashes.json",
      beforeIntegrity
    ],
    [
      "bootstrap-state.json",
      ".assistant/internal/bootstrap/state.json",
      beforeState
    ]
  ];
  for (const [name, , content] of backups) {
    await writeUtf8(path.join(transactionRoot, "backup", name), content);
  }
  const applyingRecord = {
    schema: "assistant.transaction/v1",
    id: transactionId,
    type: "bootstrap_activation",
    status: "applying",
    profile,
    planned_paths: plannedPaths,
    backups: backups.map(([name, target]) => ({
      target,
      backup: `backup/${name}`
    })),
    started_at: timestamp
  };
  await writeUtf8(
    path.join(transactionRoot, "record.json"),
    `${JSON.stringify(applyingRecord, null, 2)}\n`
  );
  const createdPaths = [];

  try {
    for (const group of groups) {
      const destination = path.join(root, ...group.path.split("/"));
      if (await pathExists(destination)) {
        throw new Error(`bootstrap activation target already exists: ${group.path}`);
      }
      await writeUtf8(
        destination,
        group.standalone
          ? standaloneDocument(
              group.records[0],
              timestamp,
              snapshotMap,
              profile,
              evidenceUnitMap
            )
          : collectionDocument(
              group,
              timestamp,
              snapshotMap,
              profile,
              evidenceUnitMap
            )
      );
      createdPaths.push(destination);
    }

    const status = output.gaps.length > 0 ? "ready_with_gaps" : "ready";
    manifest.initialization_status = status;
    manifest.activity_status = "idle";
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    const current = parseNodeDocument(beforeCurrent, currentPath);
    current.metadata.initialization_status = status;
    current.metadata.activity_status = "idle";
    current.metadata.active_work_id = null;
    const summary = output.project_summary;
    current.metadata.authorization = bootstrapAuthorization(summary);
    current.metadata.relations = groups.map((group) => ({
      type: "routes_to",
      target: group.ownerId
    }));
    current.metadata.verified_at = timestamp;
    const currentBody = currentStateBody(
      status,
      summary,
      output.gaps,
      timestamp
    );
    await writeFile(
      currentPath,
      serializeNodeDocument(current.metadata, currentBody),
      "utf8"
    );

    const projected = await loadCanonicalNodes(root);
    if (projected.findings.some((item) => item.severity === "error")) {
      throw new Error(
        `cannot generate activation index: ${JSON.stringify(projected.findings)}`
      );
    }
    await writeFile(indexPath, renderIndex(projected.nodes), "utf8");

    const preliminaryValidation = await validateProject(root);
    if (!preliminaryValidation.valid) {
      throw new Error(
        `closed-book activation validation failed: ${JSON.stringify(preliminaryValidation.findings)}`
      );
    }

    const state = JSON.parse(await readFile(statePath, "utf8"));
    state.phase = "activating";
    state.status = status;
    state.closed_book_validated = true;
    state.activated_at = timestamp;
    state.transaction_id = transactionId;
    await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");

    await writeUtf8(
      path.join(transactionRoot, "record.json"),
      `${JSON.stringify({
        schema: "assistant.transaction/v1",
        id: transactionId,
        type: "bootstrap_activation",
        status: "committed",
        profile,
        created_paths: createdPaths.map((item) => path.relative(root, item).replaceAll(path.sep, "/")),
        started_at: timestamp,
        committed_at: timestamp
      }, null, 2)}\n`
    );
    await refreshValidatedHashes(root, `bootstrap_activation:${transactionId}`);
    const validation = await validateProject(root);

    return {
      schema: "assistant.activation-result/v1",
      status,
      transaction_id: transactionId,
      canonical_documents: groups.length,
      semantic_records: output.candidate_nodes.length,
      validation,
      recovered_transactions: recoveredTransactions
    };
  } catch (error) {
    await rollbackApplyingActivation(root, applyingRecord, {
      recovery: "in_process_rollback",
      error: error.message
    });
    throw error;
  }
}
