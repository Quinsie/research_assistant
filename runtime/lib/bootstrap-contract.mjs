import {
  NODE_TYPES,
  PROFILE_ALLOWED_TYPES,
  PROFILE_FORBIDDEN_RELATIONS,
  PROFILE_RELATION_REQUIREMENTS,
  PROFILE_WORKFLOW_HEADINGS,
  RELATION_TYPES,
} from "./contract.mjs";

export function validateBootstrapOutput(output, inventory, options = {}) {
  const findings = [];
  const profile = options.profile ?? "research";
  const workflowHeadings =
    PROFILE_WORKFLOW_HEADINGS[profile] ?? PROFILE_WORKFLOW_HEADINGS.research;
  const forbiddenRelations =
    PROFILE_FORBIDDEN_RELATIONS[profile] ??
    PROFILE_FORBIDDEN_RELATIONS.research;
  const profileRelationRequirements =
    PROFILE_RELATION_REQUIREMENTS[profile] ??
    PROFILE_RELATION_REQUIREMENTS.research;
  const allowedTypes =
    PROFILE_ALLOWED_TYPES[profile] ?? PROFILE_ALLOWED_TYPES.research;
  if (output?.schema !== "assistant.bootstrap-output/v1") {
    findings.push("invalid bootstrap output schema");
  }
  if (!Array.isArray(output?.candidate_nodes)) {
    findings.push("candidate_nodes is missing");
  }
  const summary = output?.project_summary ?? {};
  const authorizationStates = new Set([
    "active",
    "parallel_allowed",
    "blocked",
    "not_authorized",
    "completed",
    "superseded"
  ]);
  if (
    summary.authorization_state !== undefined &&
    !authorizationStates.has(summary.authorization_state)
  ) {
    findings.push(
      `invalid bootstrap authorization_state ${summary.authorization_state}`
    );
  }
  for (const field of [
    "authorized_work",
    "blocked_work",
    "authorization_basis_paths"
  ]) {
    if (summary[field] !== undefined && !Array.isArray(summary[field])) {
      findings.push(`project_summary.${field} must be an array`);
    }
  }
  if (
    ["active", "parallel_allowed"].includes(summary.authorization_state) &&
    (
      !Array.isArray(summary.authorized_work) ||
      summary.authorized_work.length === 0 ||
      !Array.isArray(summary.authorization_basis_paths) ||
      summary.authorization_basis_paths.length === 0
    )
  ) {
    findings.push(
      "active bootstrap authorization requires authorized_work and authorization_basis_paths"
    );
  }

  const ids = new Set();
  const types = new Map();
  for (const node of output?.candidate_nodes ?? []) {
    if (ids.has(node.id)) findings.push(`duplicate candidate id ${node.id}`);
    ids.add(node.id);
    types.set(node.id, node.type);
    if (!NODE_TYPES.has(node.type) || ["current", "policy"].includes(node.type)) {
      findings.push(`invalid candidate type ${node.type}`);
    } else if (!allowedTypes.has(node.type)) {
      findings.push(
        `${node.id} uses ${node.type}, which is not allowed by the ${profile} profile`
      );
    }
    if (!["direct", "mixed", "inferred"].includes(node.certainty)) {
      findings.push(`invalid certainty for ${node.id}`);
    }
    const relationKeys = new Set();
    for (const relation of node.relations ?? []) {
      const relationKey = `${relation.type}\u0000${relation.target}`;
      if (relationKeys.has(relationKey)) {
        findings.push(
          `${node.id} has duplicate relation ${relation.type} -> ${relation.target}`
        );
      }
      relationKeys.add(relationKey);
      if (!RELATION_TYPES.has(relation.type)) {
        findings.push(`invalid relation type ${relation.type}`);
      }
      if (forbiddenRelations[node.type]?.includes(relation.type)) {
        findings.push(`${node.id} cannot use ${relation.type} as a ${node.type}`);
      }
    }
    const requiredHeadings = workflowHeadings[node.type];
    const sections = node.semantic_sections ?? [];
    if (requiredHeadings) {
      const headings = new Set(sections.map((section) => section.heading));
      for (const heading of requiredHeadings) {
        if (!headings.has(heading)) {
          findings.push(`${node.id} is missing semantic section ${heading}`);
        }
      }
      if (sections.length !== requiredHeadings.length) {
        findings.push(`${node.id} has unexpected semantic section count`);
      }
    } else if (sections.length > 0) {
      findings.push(`${node.id} must use an empty semantic_sections array`);
    }
  }

  for (const gap of output?.gaps ?? []) {
    if (gap.critical !== (gap.blocking_level === "initialization")) {
      findings.push(
        `${gap.id} critical does not match blocking_level ${gap.blocking_level}`
      );
    }
    if (
      gap.blocking_level === "initialization" &&
      gap.safe_unknown_state !== false
    ) {
      findings.push(
        `${gap.id} cannot block initialization when an honest unknown state is safe`
      );
    }
    if (
      gap.safe_unknown_state === false &&
      (typeof gap.unsafe_reason !== "string" ||
        gap.unsafe_reason.trim().length === 0)
    ) {
      findings.push(`${gap.id} requires unsafe_reason`);
    }
  }

  for (const conflict of output?.conflicts ?? []) {
    if (
      conflict.material !==
      (conflict.reconcilability === "unresolved_material")
    ) {
      findings.push(
        `${conflict.id} material does not match reconcilability ${conflict.reconcilability}`
      );
    }
    if (
      conflict.reconcilability === "unresolved_material" &&
      (typeof conflict.why_not_conditionable !== "string" ||
        conflict.why_not_conditionable.trim().length === 0)
    ) {
      findings.push(`${conflict.id} requires why_not_conditionable`);
    }
  }

  for (const node of output?.candidate_nodes ?? []) {
    for (const relation of node.relations ?? []) {
      if (!ids.has(relation.target)) {
        findings.push(`${node.id} targets missing candidate ${relation.target}`);
      }
    }
    const relationRequirements = profileRelationRequirements[node.type];
    if (
      relationRequirements &&
      !relationRequirements.alternatives.some((requirement) =>
        (node.relations ?? []).some(
          (relation) =>
            requirement.relations.includes(relation.type) &&
            requirement.targets.includes(types.get(relation.target))
        )
      )
    ) {
      findings.push(`${node.id} has no valid ${node.type} parent relation`);
    }
  }

  const accounted = new Set();
  for (const entry of inventory.entries) {
    for (const group of output?.coverage_groups ?? []) {
      const matches =
        (group.selector_kind === "exact_path" && entry.path === group.selector) ||
        (group.selector_kind === "path_prefix" &&
          (entry.path === group.selector ||
            entry.path.startsWith(`${group.selector.replace(/\/$/u, "")}/`))) ||
        (group.selector_kind === "inventory_category" &&
          entry.category === group.selector);
      if (matches) accounted.add(entry.path);
    }
  }
  const missingCoverage = inventory.entries
    .filter((entry) => !accounted.has(entry.path))
    .map((entry) => entry.path);
  if (missingCoverage.length > 0) {
    findings.push(
      `coverage misses ${missingCoverage.length} paths: ${missingCoverage.slice(0, 10).join(", ")}`
    );
  }
  return findings;
}

function without(object, keys) {
  return Object.fromEntries(
    Object.entries(object ?? {}).filter(([key]) => !keys.includes(key))
  );
}

export function validateBootstrapRepair(before, after, originalFindings) {
  const findings = [];
  if (
    JSON.stringify(before.project_summary) !==
    JSON.stringify(after.project_summary)
  ) {
    findings.push("repair changed project_summary");
  }

  const beforeCandidates = new Map(
    (before.candidate_nodes ?? []).map((node) => [node.id, node])
  );
  const afterCandidates = new Map(
    (after.candidate_nodes ?? []).map((node) => [node.id, node])
  );
  if (
    JSON.stringify([...beforeCandidates.keys()]) !==
    JSON.stringify([...afterCandidates.keys()])
  ) {
    findings.push("repair changed candidate ID set or order");
  }
  for (const [id, node] of beforeCandidates) {
    if (
      JSON.stringify(without(node, ["relations"])) !==
      JSON.stringify(without(afterCandidates.get(id), ["relations"]))
    ) {
      findings.push(`repair changed semantic candidate content for ${id}`);
    }
  }

  const coreGap = (gap) =>
    without(gap, [
      "critical",
      "blocking_level",
      "safe_unknown_state",
      "unsafe_reason"
    ]);
  if (
    JSON.stringify((before.gaps ?? []).map(coreGap)) !==
    JSON.stringify((after.gaps ?? []).map(coreGap))
  ) {
    findings.push("repair changed gap meaning");
  }
  const coreConflict = (conflict) =>
    without(conflict, [
      "material",
      "reconcilability",
      "why_not_conditionable"
    ]);
  if (
    JSON.stringify((before.conflicts ?? []).map(coreConflict)) !==
    JSON.stringify((after.conflicts ?? []).map(coreConflict))
  ) {
    findings.push("repair changed conflict meaning");
  }

  const coverageViolation = (originalFindings ?? []).some((item) =>
    /coverage misses/iu.test(item)
  );
  if (
    !coverageViolation &&
    JSON.stringify(before.coverage_groups) !==
      JSON.stringify(after.coverage_groups)
  ) {
    findings.push("repair changed coverage without a coverage finding");
  }
  return findings;
}

export function repairDeterministicBootstrapRelations(output, findings) {
  const findingSet = new Set(findings ?? []);
  const types = new Map(
    (output?.candidate_nodes ?? []).map((node) => [node.id, node.type])
  );
  const repaired = structuredClone(output);
  const nodes = new Map(
    (repaired.candidate_nodes ?? []).map((node) => [node.id, node])
  );
  const changes = [];
  for (const node of repaired.candidate_nodes ?? []) {
    let nodeChanged = false;
    node.relations = (node.relations ?? []).map((relation) => {
      const expectedFinding = `${node.id} cannot use tests as a hypothesis`;
      if (
        node.type === "hypothesis" &&
        relation.type === "tests" &&
        types.get(relation.target) === "question" &&
        findingSet.has(expectedFinding)
      ) {
        nodeChanged = true;
        const replacement = {
          type: "depends_on",
          target: relation.target
        };
        changes.push({
          node_id: node.id,
          from: { ...relation },
          to: replacement,
          reason:
            "a hypothesis depends on a research question; experiments test hypotheses or questions"
        });
        return replacement;
      }
      if (
        node.type === "hypothesis" &&
        relation.type === "tests" &&
        types.get(relation.target) === "experiment" &&
        findingSet.has(expectedFinding) &&
        (nodes.get(relation.target)?.relations ?? []).some(
          (candidate) =>
            candidate.type === "tests" && candidate.target === node.id
        )
      ) {
        nodeChanged = true;
        changes.push({
          node_id: node.id,
          from: { ...relation },
          to: null,
          reason:
            "the experiment already owns the reciprocal tests edge to the hypothesis"
        });
        return null;
      }
      const evidenceFinding = `${node.id} cannot use produces as a evidence`;
      if (
        node.type === "evidence" &&
        relation.type === "produces" &&
        types.get(relation.target) === "experiment" &&
        findingSet.has(evidenceFinding) &&
        (nodes.get(relation.target)?.relations ?? []).some(
          (candidate) =>
            candidate.type === "depends_on" && candidate.target === node.id
        )
      ) {
        nodeChanged = true;
        const replacement = {
          type: "precedes",
          target: relation.target
        };
        changes.push({
          node_id: node.id,
          from: { ...relation },
          to: replacement,
          reason:
            "the target experiment explicitly depends on this evidence, so the evidence precedes it"
        });
        return replacement;
      }
      return relation;
    }).filter(Boolean);
    if (nodeChanged) {
      const seen = new Set();
      node.relations = node.relations.filter((relation) => {
        const key = `${relation.type}\u0000${relation.target}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }
  }
  return { output: repaired, changes };
}
