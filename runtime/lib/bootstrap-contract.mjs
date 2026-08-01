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
  const semanticManifest = options.semanticManifest ?? null;
  const semanticLedger = options.semanticLedger ?? null;
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

  if (semanticManifest) {
    const ledgerControlPaths = new Set();
    const manifestUnits = new Map(
      (semanticManifest.units ?? []).map((unit) => [unit.unit_id, unit])
    );
    const semanticCoverage = output?.semantic_coverage ?? [];
    const coveredUnits = new Map();
    for (const coverage of semanticCoverage) {
      if (!manifestUnits.has(coverage.unit_id)) {
        findings.push(
          `semantic coverage targets unknown unit ${coverage.unit_id}`
        );
        continue;
      }
      if (coveredUnits.has(coverage.unit_id)) {
        findings.push(
          `semantic unit ${coverage.unit_id} has duplicate coverage`
        );
        continue;
      }
      coveredUnits.set(coverage.unit_id, coverage);
      const requiresTarget = [
        "preserved",
        "consolidated",
        "historical",
        "superseded"
      ].includes(coverage.disposition);
      if (requiresTarget && (coverage.target_ids ?? []).length === 0) {
        findings.push(
          `semantic unit ${coverage.unit_id} requires a canonical target`
        );
      }
      for (const target of coverage.target_ids ?? []) {
        if (!ids.has(target)) {
          findings.push(
            `semantic unit ${coverage.unit_id} targets missing candidate ${target}`
          );
        }
      }
      const unit = manifestUnits.get(coverage.unit_id);
      const roleTargetTypes = {
        decision: new Set(["decision", "history"]),
        history: new Set(["history", "decision", "plan", "experiment", "evidence"]),
        plan: new Set(["plan", "history", "decision"]),
        current: new Set(["work", "plan", "decision", "issue", "evidence"]),
        authorization: new Set(["plan", "decision", "work", "requirement"]),
        router: new Set(["plan", "foundation", "work"]),
        instruction: new Set(["requirement", "environment", "plan", "decision"])
      };
      for (const role of unit.control_roles ?? []) {
        const allowedTargets = roleTargetTypes[role];
        if (
          requiresTarget &&
          allowedTargets &&
          !(coverage.target_ids ?? []).some((target) =>
            allowedTargets.has(types.get(target))
          )
        ) {
          findings.push(
            `semantic unit ${coverage.unit_id} with ${role} meaning lacks a compatible canonical target`
          );
        }
      }
    }
    const missingUnits = [...manifestUnits.keys()].filter(
      (unitId) => !coveredUnits.has(unitId)
    );
    if (missingUnits.length > 0) {
      findings.push(
        `semantic coverage misses ${missingUnits.length} units: ${missingUnits.slice(0, 10).join(", ")}`
      );
    }

    const manifestAssets = new Map(
      (semanticManifest.document_assets ?? []).map((asset) => [asset.path, asset])
    );
    const outputAssets = new Map();
    const destinations = new Set();
    for (const asset of output?.document_assets ?? []) {
      if (outputAssets.has(asset.path)) {
        findings.push(`duplicate document asset ${asset.path}`);
        continue;
      }
      outputAssets.set(asset.path, asset);
      if (!manifestAssets.has(asset.path)) {
        findings.push(`document asset targets unknown path ${asset.path}`);
      }
      const requiresConfirmation = [
        "move_to_docs",
        "cold_in_place",
        "ask_user"
      ].includes(asset.proposed_action);
      if (asset.requires_confirmation !== requiresConfirmation) {
        findings.push(
          `document asset ${asset.path} has inconsistent requires_confirmation`
        );
      }
      if (
        requiresConfirmation &&
        !["pending", "approved"].includes(asset.decision_status)
      ) {
        findings.push(`document asset ${asset.path} requires a decision status`);
      }
      if (
        asset.decision_status === "approved" &&
        options.allowApprovedDocumentAssets !== true
      ) {
        findings.push(
          `document asset ${asset.path} cannot be pre-approved by model output`
        );
      }
      const allowedActionsByRole = {
        human_document: new Set([
          "move_to_docs",
          "cold_in_place",
          "already_in_docs",
          "report_output",
          "ask_user"
        ]),
        repository_surface: new Set([
          "move_to_docs",
          "cold_in_place",
          "already_in_docs",
          "ask_user"
        ]),
        assistant_control: new Set(["not_document_asset"]),
        data: new Set(["not_document_asset"]),
        config: new Set(["not_document_asset"]),
        code: new Set(["not_document_asset"]),
        artifact: new Set(["not_document_asset"]),
        ambiguous: new Set(["ask_user"])
      };
      if (
        !allowedActionsByRole[asset.observed_role]?.has(asset.proposed_action)
      ) {
        findings.push(
          `document asset ${asset.path} has action ${asset.proposed_action} incompatible with role ${asset.observed_role}`
        );
      }
      const manifestAsset = manifestAssets.get(asset.path);
      if (
        manifestAsset?.already_in_docs &&
        ["move_to_docs", "cold_in_place"].includes(asset.proposed_action)
      ) {
        findings.push(
          `document asset ${asset.path} is already protected by the docs boundary`
        );
      }
      if (
        manifestAsset &&
        !["extracted", "partial"].includes(manifestAsset.extraction_status) &&
        asset.proposed_action !== "ask_user"
      ) {
        findings.push(
          `document asset ${asset.path} with extraction status ${manifestAsset.extraction_status} requires ask_user`
        );
      }
      if (
        !requiresConfirmation &&
        asset.decision_status !== "not_required"
      ) {
        findings.push(
          `document asset ${asset.path} must use decision_status not_required`
        );
      }
      const isHumanDocument = asset.observed_role === "human_document";
      if (
        isHumanDocument &&
        ["move_to_docs", "cold_in_place", "already_in_docs"].includes(
          asset.proposed_action
        ) &&
        (asset.target_ids ?? []).length === 0
      ) {
        findings.push(
          `human document ${asset.path} lacks a canonical meaning target`
        );
      }
      for (const target of asset.target_ids ?? []) {
        if (!ids.has(target)) {
          findings.push(
            `document asset ${asset.path} targets missing candidate ${target}`
          );
        }
      }
      const destination = asset.proposed_destination;
      if (asset.proposed_action === "move_to_docs") {
        if (
          typeof destination !== "string" ||
          !destination.startsWith("docs/") ||
          destination.startsWith("docs/report/") ||
          destination === asset.path ||
          destination.includes("..") ||
          pathIsAbsoluteLike(destination)
        ) {
          findings.push(
            `document asset ${asset.path} has an unsafe move destination`
          );
        } else if (destinations.has(destination)) {
          findings.push(`duplicate document destination ${destination}`);
        } else {
          destinations.add(destination);
        }
      } else if (destination !== null) {
        findings.push(
          `document asset ${asset.path} must not set a destination for ${asset.proposed_action}`
        );
      }
      if (
        asset.proposed_action === "already_in_docs" &&
        !(asset.path === "docs" || asset.path.startsWith("docs/"))
      ) {
        findings.push(
          `document asset ${asset.path} is not already inside docs`
        );
      }
      if (
        asset.proposed_action === "report_output" &&
        !asset.path.startsWith("docs/report/")
      ) {
        findings.push(
          `document asset ${asset.path} is outside the report interface`
        );
      }
    }
    for (const assetPath of manifestAssets.keys()) {
      if (!outputAssets.has(assetPath)) {
        findings.push(`document asset classification misses ${assetPath}`);
      }
    }

    if (semanticLedger) {
      const analysisByUnit = new Map();
      for (const batch of semanticLedger.batches ?? []) {
        for (const analysis of batch.unit_analyses ?? []) {
          if (analysisByUnit.has(analysis.unit_id)) {
            findings.push(
              `semantic ledger duplicates unit ${analysis.unit_id}`
            );
          }
          analysisByUnit.set(analysis.unit_id, analysis);
        }
      }
      for (const unitId of manifestUnits.keys()) {
        if (!analysisByUnit.has(unitId)) {
          findings.push(`semantic ledger misses unit ${unitId}`);
        }
      }
      const candidateText = new Map(
        (output?.candidate_nodes ?? []).map((node) => [
          node.id,
          [
            node.title,
            node.body,
            ...(node.semantic_sections ?? []).flatMap((section) => [
              section.heading,
              section.content
            ])
          ].join("\n")
        ])
      );
      for (const [unitId, analysis] of analysisByUnit) {
        const manifestUnit = manifestUnits.get(unitId);
        if (
          manifestUnit?.path &&
          (
            analysis.classification === "repository_instruction" ||
            (analysis.semantic_roles ?? []).some((role) =>
              [
                "current",
                "plan",
                "decision",
                "authorization",
                "history",
                "instruction"
              ].includes(role)
            )
          )
        ) {
          ledgerControlPaths.add(manifestUnit.path);
        }
        const coverage = coveredUnits.get(unitId);
        if (!coverage || analysis.classification === "nonsemantic") continue;
        const meaningful =
          analysis.classification !== "repository_instruction" ||
          (analysis.semantic_roles ?? []).some(
            (role) => role !== "instruction"
          );
        if (
          meaningful &&
          ["omitted_with_reason", "observed_noncanonical"].includes(
            coverage.disposition
          )
        ) {
          findings.push(
            `meaningful semantic unit ${unitId} was not retained canonically`
          );
          continue;
        }
        const targets = (coverage.target_ids ?? [])
          .map((target) => candidateText.get(target) ?? "")
          .join("\n");
        for (const exact of analysis.exact_elements ?? []) {
          if (exact.length > 0 && !targets.includes(exact)) {
            findings.push(
              `semantic unit ${unitId} exact element is absent from its canonical targets: ${exact.slice(0, 80)}`
            );
          }
        }
        if (
          (analysis.conflict_candidates ?? []).length > 0 &&
          (coverage.target_ids ?? []).length === 0
        ) {
          findings.push(
            `semantic unit ${unitId} has conflict candidates without a canonical target`
          );
        }
        if (
          (analysis.conflict_candidates ?? []).length > 0 &&
          (output.conflicts ?? []).length === 0 &&
          !(coverage.target_ids ?? []).some((target) =>
            ["issue", "decision", "history"].includes(types.get(target))
          )
        ) {
          findings.push(
            `semantic unit ${unitId} has unrepresented conflict candidates`
          );
        }
      }
    }

    const legacySurfaces = output?.legacy_surfaces ?? [];
    const surfaceByPath = new Map();
    for (const surface of legacySurfaces) {
      if (surfaceByPath.has(surface.path)) {
        findings.push(`duplicate legacy surface ${surface.path}`);
      }
      surfaceByPath.set(surface.path, surface);
      for (const target of surface.target_ids ?? []) {
        if (!ids.has(target)) {
          findings.push(
            `legacy surface ${surface.path} targets missing candidate ${target}`
          );
        }
      }
    }
    const requiredSurfacePaths = new Set([
      ...(semanticManifest.control_candidate_paths ?? []),
      ...ledgerControlPaths
    ]);
    for (const candidatePath of requiredSurfacePaths) {
      if (!surfaceByPath.has(candidatePath)) {
        findings.push(
          `control candidate ${candidatePath} lacks legacy surface classification`
        );
      }
    }

    const lineage = output?.lineage;
    const audit = output?.closed_book_audit;
    if (!lineage || !audit) {
      findings.push("semantic bootstrap lacks lineage or closed-book audit");
    } else {
      for (const id of [
        ...(lineage.origin_ids ?? []),
        ...(lineage.ordered_stage_ids ?? []),
        ...(lineage.current_ids ?? [])
      ]) {
        if (!ids.has(id)) findings.push(`lineage targets missing candidate ${id}`);
      }
      const unresolvedSurface = legacySurfaces.some((surface) =>
        ["canonical_candidate", "competing_control_surface"].includes(
          surface.status
        ) ||
        (
          surface.status === "repository_native" &&
          (surface.roles ?? []).some((role) =>
            ["current", "plan", "decision", "authorization", "router"].includes(role)
          )
        ) ||
        (
          surface.status === "resolved" &&
          ![
            "integrate_then_cold",
            "integrate_then_move",
            "integrate_then_remove"
          ].includes(
            surface.proposed_action
          )
        )
      );
      const auditIncomplete =
        !lineage.complete ||
        ((output.candidate_nodes ?? []).length > 0 &&
          (
            (lineage.origin_ids ?? []).length === 0 ||
            (lineage.current_ids ?? []).length === 0
          )) ||
        !audit.origin_to_current_explainable ||
        !audit.current_authorization_explainable ||
        !audit.hypotheses_explainable ||
        !audit.decisions_explainable ||
        (audit.live_legacy_dependencies ?? []).length > 0 ||
        (audit.missing_concerns ?? []).length > 0 ||
        unresolvedSurface;
      const initializationGap = (output.gaps ?? []).some(
        (gap) => gap.blocking_level === "initialization"
      );
      if (auditIncomplete && !initializationGap) {
        findings.push(
          "incomplete lineage, legacy migration, or closed-book audit requires an initialization-level gap"
        );
      }
    }
  }
  return findings;
}

function pathIsAbsoluteLike(value) {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(value);
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
  for (const field of [
    "semantic_coverage",
    "legacy_surfaces",
    "lineage",
    "closed_book_audit"
  ]) {
    if (JSON.stringify(before[field]) !== JSON.stringify(after[field])) {
      findings.push(`repair changed ${field}`);
    }
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
