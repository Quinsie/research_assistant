const TASK_TYPE_ROUTES = Object.freeze({
  status: ["current"],
  continue: ["current", "work"],
  project_orientation: ["current", "foundation", "plan"],
  research_question: ["current", "foundation", "question"],
  hypothesis: ["current", "question", "hypothesis"],
  experiment: ["current", "question", "hypothesis", "experiment", "evidence"],
  literature: ["current", "question", "literature"],
  issue: ["current", "issue"],
  report: ["current", "work", "evidence", "decision"],
  software_requirement: ["current", "foundation", "requirement"],
  software_design: ["current", "foundation", "requirement", "design"],
  software_task: ["current", "requirement", "design", "task", "issue"],
  software_test: [
    "current",
    "requirement",
    "design",
    "task",
    "test",
    "evidence",
    "issue"
  ],
  software_issue: ["current", "issue", "task", "test", "design"],
  software_release: [
    "current",
    "requirement",
    "design",
    "task",
    "test",
    "release",
    "issue",
    "risk"
  ]
});

const TASK_PRIMARY_TYPES = Object.freeze({
  continue: ["work"],
  project_orientation: ["foundation"],
  research_question: ["question"],
  hypothesis: ["hypothesis"],
  experiment: ["experiment"],
  literature: ["literature"],
  issue: ["issue"],
  software_requirement: ["requirement"],
  software_design: ["design"],
  software_task: ["task"],
  software_test: ["test"],
  software_issue: ["issue"],
  software_release: ["release"]
});

function flatten(nodes) {
  const records = [];
  for (const node of nodes) {
    if (node.metadata.type === "collection" && Array.isArray(node.metadata.records)) {
      for (const record of node.metadata.records) {
        records.push({
          path: node.path,
          ownerId: node.metadata.id,
          metadata: record
        });
      }
    } else {
      records.push(node);
    }
  }
  return records;
}

function routeItem(candidate) {
  return {
    id: candidate.metadata.id,
    type: candidate.metadata.type,
    path: candidate.path,
    owner_id: candidate.ownerId ?? candidate.metadata.id
  };
}

export function routeTask(nodes, taskType, options = {}) {
  const wantedTypes = TASK_TYPE_ROUTES[taskType];
  if (!wantedTypes) {
    return {
      status: "documentation_gap",
      taskType,
      reason: "unknown task type",
      required: []
    };
  }

  const allRecords = flatten(nodes);
  const byId = new Map(allRecords.map((record) => [record.metadata.id, record]));
  const current = allRecords.find((record) => record.metadata.type === "current");
  const requestedIds = options.entityIds ?? [];
  if (requestedIds.length > 0) {
    const selected = new Map();
    if (current) selected.set(current.metadata.id, current);
    const queue = [...requestedIds];
    const missingIds = [];
    while (queue.length > 0) {
      const id = queue.shift();
      if (selected.has(id)) continue;
      const candidate = byId.get(id);
      if (!candidate) {
        missingIds.push(id);
        continue;
      }
      selected.set(id, candidate);
      for (const relation of candidate.metadata.relations ?? []) {
        if (
          [
            "depends_on",
            "derived_from",
            "tests",
            "blocked_by",
            "implements",
            "verifies",
            "resolves",
            "challenges"
          ].includes(relation.type)
        ) {
          queue.push(relation.target);
        }
      }
    }
    if (missingIds.length > 0) {
      return {
        status: "documentation_gap",
        taskType,
        reason: "requested entity is not registered",
        missing_entity_ids: [...new Set(missingIds)],
        required: current ? [routeItem(current)] : []
      };
    }
    const uniquePaths = new Map();
    for (const candidate of selected.values()) {
      const item = routeItem(candidate);
      const existing = uniquePaths.get(item.path);
      if (existing) existing.entity_ids.push(item.id);
      else uniquePaths.set(item.path, { ...item, entity_ids: [item.id] });
    }
    return {
      status: "routed",
      taskType,
      required: [...uniquePaths.values()],
      missing: []
    };
  }

  const byType = new Map();
  for (const routeRecord of allRecords) {
      const list = byType.get(routeRecord.metadata.type) ?? [];
      list.push(routeRecord);
      byType.set(routeRecord.metadata.type, list);
  }

  const required = [];
  const missing = [];
  const ambiguous = [];
  for (const type of wantedTypes) {
    const candidates = byType.get(type) ?? [];
    if (type === "current" && candidates.length === 0) {
      missing.push(type);
      continue;
    }
    if (type !== "current" && candidates.length > 5) {
      ambiguous.push({
        type,
        candidates: candidates.map((candidate) => candidate.metadata.id)
      });
      continue;
    }
    for (const candidate of candidates) {
      required.push(routeItem(candidate));
    }
  }

  const uniquePaths = new Map();
  for (const item of required) {
    const existing = uniquePaths.get(item.path);
    if (existing) existing.entity_ids.push(item.id);
    else uniquePaths.set(item.path, { ...item, entity_ids: [item.id] });
  }

  const missingPrimary = (TASK_PRIMARY_TYPES[taskType] ?? []).filter(
    (type) => (byType.get(type) ?? []).length === 0
  );
  const noActiveWork =
    taskType === "continue" &&
    missingPrimary.includes("work") &&
    current &&
    ["awaiting_direction", "idle", "terminal"].includes(
      current.metadata.activity_status
    );
  return {
    status:
      missing.length > 0
        ? "invalid"
        : ambiguous.length > 0
          ? "needs_entity_selection"
          : noActiveWork
            ? current.metadata.activity_status === "terminal"
              ? "terminal"
              : "awaiting_direction"
          : missingPrimary.length > 0
            ? "documentation_gap"
            : "routed",
    taskType,
    required: [...uniquePaths.values()],
    missing,
    selection: ambiguous,
    ...(noActiveWork
      ? {
          reason: "no active work is registered",
          activity_status: current.metadata.activity_status,
          authorization: current.metadata.authorization ?? null
        }
      : missingPrimary.length > 0
      ? {
          reason: "required semantic owner is not registered",
          missing_primary_types: missingPrimary
        }
      : {})
  };
}
