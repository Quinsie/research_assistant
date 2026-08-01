import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { activateBootstrap } from "../../runtime/lib/activation.mjs";
import { authorizeTerminalEpisode } from "../../runtime/lib/episode.mjs";
import { initializeProject } from "../../runtime/lib/installer.mjs";
import { parseNodeDocument, serializeNodeDocument } from "../../runtime/lib/meta.mjs";
import { routeTask } from "../../runtime/lib/router.mjs";
import { maintainStructure } from "../../runtime/lib/structure.mjs";
import {
  commitCanonicalUpdate,
  stageCanonicalUpdate
} from "../../runtime/lib/transaction.mjs";
import {
  loadCanonicalNodes,
  validateProject
} from "../../runtime/lib/validator.mjs";

const QUESTION_FIELDS = [
  "Question",
  "Why it matters",
  "Related theory",
  "Prior work",
  "Evidence needed",
  "Related hypotheses",
  "Experiments or milestones",
  "Current partial answer",
  "Open scope"
];
const HYPOTHESIS_FIELDS = [
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
];
const EXPERIMENT_FIELDS = [
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
];
const EVIDENCE_FIELDS = [
  "Observation",
  "Conditions",
  "Artifact identity",
  "Supports",
  "Challenges",
  "Limitations"
];

function fields(names, values = {}) {
  return names
    .map((name) => `### ${name}\n\n${values[name] ?? "Unknown — not established."}`)
    .join("\n\n");
}

function block(record, body) {
  return `<!-- assistant-record:start ${record.id} -->
## ${record.id}: ${record.title}

${body}
<!-- assistant-record:end ${record.id} -->`;
}

function collection(id, kind, title, records) {
  const metadata = {
    schema: "assistant.node/v1",
    id,
    type: "collection",
    collection_kind: kind,
    status: "active",
    authority: "canonical_agent",
    relations: records.map((item) => ({ type: "contains", target: item.record.id })),
    records: records.map((item) => {
      const { title: ignored, ...metadataRecord } = item.record;
      return metadataRecord;
    }),
    verified_at: new Date().toISOString()
  };
  return serializeNodeDocument(
    metadata,
    `# ${title}\n\n${records.map((item) => block(item.record, item.body)).join("\n\n")}\n`
  );
}

async function currentContent(target, patch, body) {
  const currentPath = path.join(target, ".assistant", "CURRENT.md");
  const current = parseNodeDocument(await readFile(currentPath, "utf8"));
  Object.assign(current.metadata, patch, { verified_at: new Date().toISOString() });
  return serializeNodeDocument(current.metadata, `# Current state\n\n${body}\n`);
}

async function applyEpisode(target, id, writes, conflicts = []) {
  const staged = await stageCanonicalUpdate(target, {
    id,
    type: "longitudinal_episode",
    authority: "current_user_instruction",
    writes,
    conflicts
  });
  return { staged, commit: (confirmed = false) =>
    commitCanonicalUpdate(target, id, { confirmed }) };
}

async function reportThroughGateway(target, args) {
  const gateway = path.join(
    target,
    ".assistant",
    "system",
    "runtime",
    "gateway.mjs"
  );
  const child = spawn(process.execPath, [gateway], {
    cwd: target,
    env: { ...process.env, ASSISTANT_PROJECT_ROOT: target },
    stdio: ["pipe", "pipe", "pipe"]
  });
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stdin.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "report_write_new", arguments: args }
  })}\n`);
  const deadline = Date.now() + 5_000;
  while (!output.includes("\n") && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const closed = new Promise((resolve) => child.once("close", resolve));
  child.kill();
  await closed;
  return JSON.parse(output.trim());
}

test("one project survives a complete multi-episode research lifecycle", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "assistant-longitudinal-"));
  const target = path.join(tempRoot, "legacy research");
  try {
    await mkdir(path.join(target, "docs", "user"), { recursive: true });
    await writeFile(path.join(target, "README.md"), "# Legacy study\n", "utf8");
    await writeFile(
      path.join(target, "docs", "user", "plan.md"),
      "Origin rationale that may later disappear.\n",
      "utf8"
    );
    await initializeProject(target);
    const bootstrapResult = {
      schema: "assistant.bootstrap-output/v1",
      project_summary: {
        purpose: "Longitudinal fixture",
        scope: "Synthetic research",
        current_state: "Awaiting a research direction",
        current_authorization: "No experiment execution",
        next_safe_route: "Create a scoped question"
      },
      candidate_nodes: [
        {
          id: "FND-LONG-001",
          type: "foundation",
          status: "active",
          authority: "candidate_unintegrated",
          certainty: "direct",
          relations: [],
          title: "Fixture origin",
          body: "Origin is preserved from docs/user/plan.md.",
          evidence_paths: ["docs/user/plan.md"],
          legacy_aliases: []
        }
      ],
      coverage_groups: [],
      semantic_coverage: [],
      legacy_surfaces: [],
      lineage: {
        origin_ids: ["FND-LONG-001"],
        ordered_stage_ids: [],
        current_ids: ["FND-LONG-001"],
        complete: true,
        missing: []
      },
      closed_book_audit: {
        origin_to_current_explainable: true,
        current_authorization_explainable: true,
        hypotheses_explainable: true,
        decisions_explainable: true,
        live_legacy_dependencies: [],
        missing_concerns: []
      },
      gaps: [],
      conflicts: []
    };
    await writeFile(
      path.join(
        target,
        ".assistant",
        "internal",
        "bootstrap",
        "model-result.json"
      ),
      `${JSON.stringify(bootstrapResult, null, 2)}\n`,
      "utf8"
    );
    await activateBootstrap(target);

    let fresh = await loadCanonicalNodes(target);
    assert.equal(routeTask(fresh.nodes, "project_orientation").status, "routed");

    const question = {
      id: "RQ-LONG-001",
      type: "question",
      title: "Does the intervention change the metric?",
      status: "active",
      authority: "canonical_user_approved",
      origin: "ongoing",
      workflow_schema: "research.question/v1",
      relations: [{ type: "derived_from", target: "FND-LONG-001" }]
    };
    const work = {
      id: "WORK-LONG-001",
      type: "work",
      title: "Test the intervention",
      status: "active",
      authority: "canonical_user_approved",
      origin: "ongoing",
      relations: [{ type: "depends_on", target: "RQ-LONG-001" }]
    };
    const agenda1 = collection(
      "COL-RESEARCH-AGENDA",
      "research_agenda",
      "Research agenda",
      [{
        record: question,
        body: fields(QUESTION_FIELDS, {
          Question: "Does the intervention change the metric?",
          "Why it matters": "It determines whether the proposed mechanism is worth testing."
        })
      }]
    );
    const operations1 = collection(
      "COL-ACTIVE-OPERATIONS",
      "operations",
      "Active operations",
      [{ record: work, body: "### Scope\n\nQuestion and first decisive experiment." }]
    );
    let episode = await applyEpisode(target, "TXN-LONG-001", [
      { path: ".assistant/knowledge/research/AGENDA.md", content: agenda1 },
      { path: ".assistant/knowledge/work/ACTIVE.md", content: operations1 },
      {
        path: ".assistant/CURRENT.md",
        content: await currentContent(
          target,
          {
            activity_status: "active",
            active_work_id: work.id,
            authorization: "active",
            relations: [
              { type: "routes_to", target: work.id },
              { type: "routes_to", target: question.id }
            ]
          },
          "The scoped question is active; experiment design is authorized."
        )
      }
    ]);
    await episode.commit();

    const hypothesis = {
      id: "HYP-LONG-001",
      type: "hypothesis",
      title: "Intervention raises the metric",
      status: "under_test",
      authority: "canonical_agent",
      origin: "ongoing",
      workflow_schema: "research.hypothesis/v1",
      relations: [{ type: "depends_on", target: question.id }]
    };
    const experiment = {
      id: "EXP-LONG-001",
      type: "experiment",
      title: "Controlled intervention test",
      status: "active",
      authority: "canonical_agent",
      origin: "ongoing",
      workflow_schema: "research.experiment/v1",
      relations: [{ type: "tests", target: hypothesis.id }]
    };
    const agenda2 = collection(
      "COL-RESEARCH-AGENDA",
      "research_agenda",
      "Research agenda",
      [
        {
          record: question,
          body: fields(QUESTION_FIELDS, {
            Question: "Does the intervention change the metric?",
            "Related hypotheses": hypothesis.id
          })
        },
        {
          record: hypothesis,
          body: fields(HYPOTHESIS_FIELDS, {
            Statement: "The intervention raises the metric under the controlled condition.",
            "Current disposition": "under_test"
          })
        }
      ]
    );
    const evidence1 = collection(
      "COL-RESEARCH-EVIDENCE",
      "research_evidence",
      "Research evidence",
      [{
        record: experiment,
        body: fields(EXPERIMENT_FIELDS, {
          "Question or hypothesis": hypothesis.id,
          Test: "Compare intervention and control.",
          Result: "Unknown — not run."
        })
      }]
    );
    episode = await applyEpisode(target, "TXN-LONG-002", [
      { path: ".assistant/knowledge/research/AGENDA.md", content: agenda2 },
      { path: ".assistant/knowledge/research/EVIDENCE.md", content: evidence1 }
    ]);
    await episode.commit();

    const evidenceRecord = {
      id: "EVID-LONG-001",
      type: "evidence",
      title: "Controlled result",
      status: "active",
      authority: "canonical_agent",
      origin: "ongoing",
      workflow_schema: "research.evidence/v1",
      relations: [
        { type: "derived_from", target: experiment.id },
        { type: "challenges", target: hypothesis.id }
      ]
    };
    experiment.status = "completed";
    const evidence2 = collection(
      "COL-RESEARCH-EVIDENCE",
      "research_evidence",
      "Research evidence",
      [
        {
          record: experiment,
          body: fields(EXPERIMENT_FIELDS, {
            "Question or hypothesis": hypothesis.id,
            Test: "Compare intervention and control.",
            Result: "No reliable increase; one control condition was unstable.",
            Interpretation: "The planned claim is not supported.",
            "Artifact identity": "artifact:sha256:synthetic"
          })
        },
        {
          record: evidenceRecord,
          body: fields(EVIDENCE_FIELDS, {
            Observation: "No reliable increase was observed.",
            Conditions: "Synthetic controlled fixture.",
            "Artifact identity": "artifact:sha256:synthetic",
            Challenges: hypothesis.id
          })
        }
      ]
    );
    const issue = {
      id: "ISSUE-LONG-001",
      type: "issue",
      title: "Unstable control",
      status: "blocked",
      authority: "canonical_agent",
      origin: "ongoing",
      relations: [{ type: "blocked_by", target: experiment.id }]
    };
    work.status = "blocked";
    const operations2 = collection(
      "COL-ACTIVE-OPERATIONS",
      "operations",
      "Active operations",
      [
        { record: work, body: "### State\n\nBlocked pending control repair." },
        { record: issue, body: "### Issue\n\nControl instability limits interpretation." }
      ]
    );
    episode = await applyEpisode(target, "TXN-LONG-003", [
      { path: ".assistant/knowledge/research/EVIDENCE.md", content: evidence2 },
      { path: ".assistant/knowledge/work/ACTIVE.md", content: operations2 },
      {
        path: ".assistant/CURRENT.md",
        content: await currentContent(
          target,
          {
            activity_status: "blocked",
            authorization: "blocked",
            relations: [
              { type: "routes_to", target: work.id },
              { type: "routes_to", target: issue.id },
              { type: "routes_to", target: experiment.id }
            ]
          },
          "Execution is blocked by an unstable control; interpretation only."
        )
      }
    ]);
    await episode.commit();

    const beforeConflict = await readFile(
      path.join(target, ".assistant", "CURRENT.md"),
      "utf8"
    );
    episode = await applyEpisode(
      target,
      "TXN-LONG-CONFLICT",
      [{
        path: ".assistant/CURRENT.md",
        content: await currentContent(
          target,
          {
            activity_status: "paused",
            authorization: "not_authorized"
          },
          "A conflicting source proposes replacing the active route."
        )
      }],
      [{ id: "CONFLICT-LONG-001", material: true, concern: "current route" }]
    );
    assert.equal(await readFile(path.join(target, ".assistant", "CURRENT.md"), "utf8"), beforeConflict);
    await assert.rejects(episode.commit(), /confirmation/);
    await episode.commit(true);

    hypothesis.status = "challenged";
    const agendaLarge = collection(
      "COL-RESEARCH-AGENDA",
      "research_agenda",
      "Research agenda",
      [
        {
          record: question,
          body: fields(QUESTION_FIELDS, { Question: "Does the intervention change the metric?" })
        },
        {
          record: hypothesis,
          body: fields(HYPOTHESIS_FIELDS, {
            Statement: `The intervention raises the metric.${" context".repeat(1_000)}`,
            "Current disposition": "challenged",
            "Allowed claim": "No support under the tested condition.",
            "Prohibited overclaim": "Do not claim universal rejection."
          })
        }
      ]
    );
    episode = await applyEpisode(target, "TXN-LONG-004", [
      { path: ".assistant/knowledge/research/AGENDA.md", content: agendaLarge }
    ]);
    await episode.commit();
    const maintained = await maintainStructure(target);
    assert.equal(maintained.applied, true);
    fresh = await loadCanonicalNodes(target);
    assert.equal(
      routeTask(fresh.nodes, "hypothesis", { entityIds: [hypothesis.id] }).status,
      "routed"
    );

    work.status = "completed";
    const operations3 = collection(
      "COL-ACTIVE-OPERATIONS",
      "operations",
      "Active operations",
      [{ record: work, body: "### State\n\nCompleted at a user decision boundary." }]
    );
    episode = await applyEpisode(target, "TXN-LONG-005", [
      { path: ".assistant/knowledge/work/ACTIVE.md", content: operations3 },
      {
        path: ".assistant/CURRENT.md",
        content: await currentContent(
          target,
          {
            activity_status: "terminal",
            active_work_id: work.id,
            authorization: "completed",
            relations: [
              { type: "routes_to", target: work.id },
              { type: "routes_to", target: hypothesis.id },
              { type: "routes_to", target: evidenceRecord.id }
            ]
          },
          "The work episode is complete; no downstream experiment is authorized."
        )
      }
    ]);
    await episode.commit();
    await authorizeTerminalEpisode(target, {
      workId: work.id,
      episodeId: "EP-LONG-001",
      locale: "ko"
    });
    const report = await reportThroughGateway(target, {
      relative_path: "WORK-LONG-001-EP-LONG-001.md",
      content: "# 작업 보고서\n\n합성 장기 시나리오가 종료되었다.\n",
      work_id: work.id,
      episode_id: "EP-LONG-001",
      report_kind: "terminal"
    });
    assert.ok(report.result);

    await rm(path.join(target, "docs", "user", "plan.md"), { force: true });
    await rm(path.join(target, "docs", "report"), { recursive: true, force: true });
    const finalValidation = await validateProject(target);
    assert.equal(finalValidation.valid, true);
    fresh = await loadCanonicalNodes(target);
    const resume = routeTask(fresh.nodes, "experiment", {
      entityIds: [experiment.id]
    });
    assert.equal(resume.status, "routed");
    assert.ok(resume.required.some((item) => item.entity_ids.includes(hypothesis.id)));
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
