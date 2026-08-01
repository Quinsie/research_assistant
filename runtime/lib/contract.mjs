export const SYSTEM_VERSION = "0.1.0-dev";
export const MANIFEST_SCHEMA = "assistant.manifest/v1";
export const NODE_SCHEMA = "assistant.node/v1";
export const PROJECT_PROFILES = new Set(["research", "software"]);

export const NODE_TYPES = new Set([
  "collection",
  "current",
  "policy",
  "foundation",
  "plan",
  "question",
  "hypothesis",
  "experiment",
  "evidence",
  "literature",
  "dataset",
  "decision",
  "issue",
  "risk",
  "history",
  "environment",
  "work",
  "requirement",
  "design",
  "task",
  "test",
  "release"
]);

export const PROFILE_ALLOWED_TYPES = Object.freeze({
  research: new Set(NODE_TYPES),
  software: new Set([
    "collection",
    "current",
    "policy",
    "foundation",
    "plan",
    "evidence",
    "decision",
    "issue",
    "risk",
    "history",
    "environment",
    "work",
    "requirement",
    "design",
    "task",
    "test",
    "release"
  ])
});

export const RELATION_TYPES = new Set([
  "contains",
  "routes_to",
  "depends_on",
  "derived_from",
  "supports",
  "challenges",
  "tests",
  "produces",
  "resolves",
  "supersedes",
  "blocked_by",
  "authorizes",
  "implements",
  "verifies",
  "precedes",
  "follows",
  "aliases"
]);

export const AUTHORITIES = new Set([
  "current_user_instruction",
  "canonical_user_approved",
  "canonical_agent",
  "machine_contract",
  "immutable_artifact",
  "candidate_unintegrated",
  "derived_non_authoritative"
]);

export const INITIALIZATION_STATUSES = new Set([
  "ready",
  "ready_with_gaps",
  "awaiting_user_input",
  "environment_blocked",
  "bootstrap_incomplete",
  "bootstrap_failed"
]);

export const ACTIVITY_STATUSES = new Set([
  "awaiting_direction",
  "idle",
  "active",
  "paused",
  "blocked",
  "terminal"
]);

export const AUTHORIZATION_STATES = new Set([
  "active",
  "parallel_allowed",
  "blocked",
  "not_authorized",
  "completed",
  "superseded"
]);

export const SIDE_EFFECTS = new Set([
  "canonical_write",
  "project_asset_write",
  "report_write",
  "source_read",
  "report_read",
  "git_commit",
  "git_push",
  "network_public",
  "network_private",
  "update_check",
  "external_action",
  "destructive_action"
]);

export const REQUIRED_CANONICAL_FILES = [
  ".assistant/CURRENT.md",
  ".assistant/POLICY.md"
];

export const RESTRICTED_ZONES = [
  "docs",
  ".assistant/vault",
  ".assistant/internal/restricted"
];

export const BOUNDEDNESS_DEFAULTS = Object.freeze({
  softBytes: 12_000,
  hardBytes: 24_000,
  softChildRecords: 12,
  hardChildRecords: 24
});

export const RESEARCH_WORKFLOW_HEADINGS = Object.freeze({
  question: [
    "Question",
    "Why it matters",
    "Related theory",
    "Prior work",
    "Evidence needed",
    "Related hypotheses",
    "Experiments or milestones",
    "Current partial answer",
    "Open scope"
  ],
  hypothesis: [
    "Statement",
    "Rationale",
    "Mechanism basis",
    "Published or local evidence",
    "Competing explanations",
    "Required controls",
    "Decisive test",
    "Falsification or stop condition",
    "Current disposition",
    "Allowed claim",
    "Prohibited overclaim"
  ],
  experiment: [
    "Question or hypothesis",
    "Test",
    "Method",
    "Inputs and conditions",
    "Controls",
    "Independent unit",
    "Metrics",
    "Completion or stop condition",
    "Result",
    "Establishable scope",
    "Non-establishable scope",
    "Interpretation",
    "Artifact identity",
    "Decision consequence"
  ],
  evidence: [
    "Observation",
    "Conditions",
    "Artifact identity",
    "Supports",
    "Challenges",
    "Limitations"
  ],
  literature: [
    "Contribution",
    "Conditions and data",
    "Evidence",
    "What it does not establish",
    "Project role",
    "Reproduction, code, and data",
    "Supported claims"
  ]
});

export const RESEARCH_FORBIDDEN_RELATIONS = Object.freeze({
  question: ["tests", "produces", "verifies", "authorizes", "implements"],
  hypothesis: [
    "contains",
    "tests",
    "produces",
    "resolves",
    "authorizes",
    "implements",
    "verifies"
  ],
  experiment: ["contains", "authorizes", "resolves"],
  evidence: ["contains", "tests", "produces", "authorizes", "implements"],
  literature: ["contains", "tests", "produces", "authorizes", "implements"]
});

export const SOFTWARE_WORKFLOW_HEADINGS = Object.freeze({
  requirement: [
    "Requirement",
    "Rationale",
    "Scope",
    "Non-goals",
    "Constraints",
    "Acceptance criteria",
    "Dependencies",
    "Current evidence",
    "Open ambiguity"
  ],
  design: [
    "Problem and context",
    "Considered options",
    "Chosen approach",
    "Rationale",
    "Interfaces and invariants",
    "Failure and security concerns",
    "Consequences and tradeoffs",
    "Validation",
    "Supersession condition"
  ],
  task: [
    "Objective",
    "Scope",
    "Parent requirement or design",
    "Authorization and preconditions",
    "Implementation plan",
    "Affected components",
    "Verification",
    "Completion or stop condition",
    "Current state",
    "Blockers",
    "Result",
    "Follow-up"
  ],
  test: [
    "Claim or risk",
    "Test level",
    "Setup",
    "Inputs and conditions",
    "Oracle or expected result",
    "Execution and result",
    "Artifact or trace identity",
    "Coverage",
    "Non-coverage",
    "Disposition"
  ],
  release: [
    "Version and scope",
    "Included requirements and changes",
    "Release gates",
    "Validation evidence",
    "Compatibility and migration",
    "Known issues and risks",
    "Rollback",
    "Artifact identity",
    "Authorization",
    "Status"
  ],
  issue: [
    "Symptom",
    "Context and impact",
    "Reproduction",
    "Evidence",
    "Cause",
    "Resolution",
    "Prevention",
    "Current status",
    "Related work"
  ]
});

export const SOFTWARE_FORBIDDEN_RELATIONS = Object.freeze({
  requirement: [
    "contains",
    "implements",
    "verifies",
    "tests",
    "produces",
    "resolves",
    "authorizes"
  ],
  design: ["contains", "verifies", "tests", "produces", "authorizes"],
  task: ["contains", "verifies", "tests", "authorizes"],
  test: ["contains", "implements", "tests", "resolves", "authorizes"],
  release: ["contains", "tests", "verifies", "resolves", "authorizes"],
  issue: [
    "contains",
    "implements",
    "verifies",
    "tests",
    "produces",
    "authorizes"
  ]
});

const EVIDENCE_PARENT_REQUIREMENT = Object.freeze({
  alternatives: [
    {
      relations: ["derived_from"],
      targets: ["experiment"]
    },
    {
      relations: ["derived_from", "supports", "challenges", "verifies"],
      targets: [
        "design",
        "work",
        "environment",
        "dataset",
        "requirement",
        "question",
        "hypothesis",
        "decision",
        "task",
        "test",
        "release",
        "issue"
      ]
    }
  ]
});

export const PROFILE_RELATION_REQUIREMENTS = Object.freeze({
  research: Object.freeze({
    hypothesis: {
      alternatives: [{
        relations: ["depends_on", "derived_from"],
        targets: ["question"]
      }]
    },
    experiment: {
      alternatives: [{
        relations: ["tests"],
        targets: ["question", "hypothesis"]
      }]
    },
    evidence: EVIDENCE_PARENT_REQUIREMENT
  }),
  software: Object.freeze({
    requirement: {
      alternatives: [{
        relations: ["depends_on", "derived_from"],
        targets: ["foundation", "requirement", "decision", "work"]
      }]
    },
    design: {
      alternatives: [{
        relations: ["implements", "derived_from", "depends_on"],
        targets: ["requirement", "foundation", "decision"]
      }]
    },
    task: {
      alternatives: [{
        relations: ["implements", "depends_on", "derived_from", "resolves"],
        targets: ["requirement", "design", "work", "task", "issue"]
      }]
    },
    test: {
      alternatives: [{
        relations: ["verifies", "derived_from"],
        targets: ["requirement", "design", "task", "release", "issue"]
      }]
    },
    release: {
      alternatives: [{
        relations: ["depends_on", "implements", "follows"],
        targets: ["requirement", "design", "task", "test", "release"]
      }]
    },
    issue: {
      alternatives: [{
        relations: ["challenges", "derived_from", "depends_on"],
        targets: [
          "requirement",
          "design",
          "task",
          "test",
          "release",
          "work",
          "environment",
          "evidence"
        ]
      }]
    },
    evidence: EVIDENCE_PARENT_REQUIREMENT
  })
});

export const PROFILE_WORKFLOW_HEADINGS = Object.freeze({
  research: RESEARCH_WORKFLOW_HEADINGS,
  software: SOFTWARE_WORKFLOW_HEADINGS
});

export const PROFILE_FORBIDDEN_RELATIONS = Object.freeze({
  research: RESEARCH_FORBIDDEN_RELATIONS,
  software: SOFTWARE_FORBIDDEN_RELATIONS
});
