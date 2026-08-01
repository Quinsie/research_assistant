---
name: assistant-research-workflow
description: Create or update durable research questions, hypotheses, literature, experiments, evidence, controls, dispositions, claim boundaries, work episodes, and reports in an installed Assistant project.
---

# Research workflow

Use this skill only for durable research meaning. A short answer or transient
analysis does not require a canonical node.

1. Read `.assistant/INDEX.md` and `.assistant/CURRENT.md`.
2. Resolve only the task-relevant route and policy. Do not inspect `docs/`, an
   external cold document boundary, or `.assistant/vault/` without a current
   exact-path gateway grant. `docs/report/` is write-only except when the user
   names an exact report for review, edit, or comparison.
3. Read `.assistant/system/research-schema.md` completely.
4. Identify whether the instruction adds, refines, conflicts with, or
   supersedes active canonical meaning.
5. If it materially conflicts with north star, scope, plan, state,
   authorization, active work, gate, disposition, or methodology, stage the
   whole change and ask before changing active owners.
6. Otherwise update the smallest canonical owner. Preserve stable IDs and typed
   relations. Never copy detailed results into a parent; parents route and
   summarize status only.
7. Create a new owner when durable meaning first appears. Start related small
   records in a bounded collection. Promote a record without changing its ID
   when it gains an independent lifecycle, selective routing need, or makes the
   owner exceed its boundedness warning.
8. Record unknown or unverified fields explicitly. Do not invent values.
9. Update `CURRENT.md` only for current state, authorization, blocker, active
   work, current decision, and next safe route.
10. Run `.assistant\system\assistant.cmd validate` after material changes. If
    boundedness warns, run `.assistant\system\assistant.cmd structure` for a
    preview and then `structure --apply`; validate again.

Canonical state must be current before a terminal report is generated.

## Work episode and report

- When a new prompt changes active-work priority, state, or next action, give
  concise transition feedback. Distinguish a short question then resume,
  additive instruction, explicit stop/replace, material conflict, and unrelated
  substantial work. If priority is genuinely unspecified, ask whether to
  pause, replace, or run in parallel; do not silently abandon or resume work.
- Do not create a durable Goal for a short answer or trivial maintenance task.
- For continuing work, preserve its ID, authority, scope, status, stop
  condition, current state, lineage, decision requirement, and report linkage.
- At a material result, blocker, decision, authorization, plan, or state
  change, update canonical owners promptly instead of waiting for the report.
- Stop before downstream work at a Gate, anomaly, material problem, user stop,
  or required branch decision.
- A terminal report is generated only after canonical state is current. Use the
  project locale in `.assistant/manifest.json`; if it is not set, follow the
  first-prompt locale instruction before reporting.
- One terminal episode has at most one idempotent report. Include without
  repetition: Goal and authority, Why, work actually done and excluded, method
  and evidence basis, factual results, interpretation and non-claims,
  limitations and uncertainty, resulting state and authorization, exact
  decision required, next paths, and traceability.
- A requested report is created only on explicit request from current
  canonical state and artifacts. Never use an older report as its source.

## Exact source integration

Use this workflow only when the current instruction both identifies an exact
source boundary and requests canonical integration. Review, summary, critique,
or comparison alone must not update canonical state.

1. Use only the current prompt grant. For a directory, inventory the whole
   granted boundary and account every entry; do not follow a link outside it.
2. Preflight each file. Read supported text through the gateway and preserve
   exact bytes with `source_snapshot`. Binary or oversized content that cannot
   be interpreted is a documented coverage gap, not silently integrated.
3. Map every meaningful source section to one of `preserved`, `consolidated`,
   `historical`, `superseded`, or `omitted_with_reason`. Preserve definitions,
   formulas, variables, conditions, numbers, claims, evidence, controls,
   falsification/stop conditions, plans, gates, results, limitations,
   decisions, authorization, and plan evolution when present.
4. Compare against routed canonical owners. Classify additions, refinements,
   conflicts, supersessions, and history. Never use filename, date, mtime, Git
   state, or words such as "latest" as authority.
5. Create one `source_integration` transaction specification containing all
   affected writes, immutable `source_snapshot_ids`, section `coverage`, and
   all conflicts. Canonical text may cite snapshot identities but must not cite
   the live source path.
6. If any conflict is material, preview the whole conflict and wait for
   explicit confirmation. Do not commit a non-conflicting subset.
7. Commit the transaction, run structure maintenance if signaled, then
   validate. Re-route from canonical owners without reading the source,
   reports, or vault; failure is a documentation gap and the integration is
   not complete.

## Existing-project bootstrap resolution

When `CURRENT.md` names `BOOTSTRAP-EXISTING` and `awaiting_user_input`,
assistant-managed canonical integration is paused. The project and its human
collaborators are not blocked. Before relying on assistant canonical context,
read only the listed gap/conflict records and staged candidates. Ask at most
three related questions at a time.

If migration status lists `agents_control_plane`, resolve it before semantic
gap/conflict questions. Read the preserved original AGENTS backup and the
active AGENTS file. Keep repository-native build, test, safety, and subtree
rules in AGENTS. Move durable assistant side-effect preferences such as
commit/report/network behavior into `.assistant/POLICY.md` when the user wants
them retained. Remove or rewrite any legacy route that semantically claims
active current, plan, decision, authorization, policy, or routing ownership
and competes with `.assistant`; never assume fixed filenames or directories,
and do not delete rules merely because they are old.
Preview material rule changes and obtain explicit confirmation, then run:

`.assistant\system\assistant.cmd migration --complete-agents --confirm --json`

The completion command validates that one managed block remains, competing
control routes are gone, and accepted AGENTS/POLICY plus the original are
archived. It does not decide rule meaning for the user.

This migration changes only the active AGENTS/POLICY control route. Do not
move, delete, rename, or archive documents referenced by legacy AGENTS. The
subsequent semantic bootstrap must first integrate their meaning and then
present any document relocation as a separate reversible whole-plan proposal.

After every pending system migration is complete, continue the same bootstrap
with `.assistant\system\assistant.cmd init --json` on Windows or
`.assistant/system/assistant init --json` on POSIX. The installed runner uses
the persisted profile or model/effort selection and a preserved Codex session
when one exists. Never downgrade effort, add a timeout, or start a replacement
semantic attempt without the user's explicit restart instruction and reason.

The runner processes every knowledge-bearing text candidate as stable semantic
units in resumable batches, then synthesizes from the validated unit ledger.
Do not bypass an incomplete batch, unit coverage, lineage, or closed-book
finding by opening one legacy master document and treating it as live fallback
authority. Historical and superseded meaning must be integrated into bounded
canonical history, decision, evidence, or plan owners when it explains the
project. A valid node count alone is not readiness.

Review every staged `legacy_surfaces` entry by observed meaning. Preserve
repository-native build/test instructions, user sources, reports, and ordinary
project documents in their appropriate role. `integrate_then_cold` means the
meaning is canonical and the original is protected from normal Assistant
access; it does not require deletion or movement. For a competing control
surface, preview the proposed preserve/rewrite/move/remove action and obtain
the user's approval before changing it. Do not invent a generic archive
directory.

Review every staged `document_assets` item. Show one whole relocation preview:
the current path, observed role, canonical targets, proposed destination or
cold-in-place disposition, reason, and rollback conditions. Explain that
`docs/` is human-managed cold storage and `docs/report/` is the only report
write interface. Ask once whether to apply the complete proposal. The user may
change any disposition or destination. Do not move a file before the complete
semantic output validates, and never overwrite a collision. In the resolved
output, approved `move_to_docs` and `cold_in_place` items use
`decision_status: approved`; rejected or ambiguous items must be changed to a
fully decided non-pending disposition.

After all answers are explicit, create one temporary
`assistant.bootstrap-resolution/v1` JSON package. It must contain:

- one decision for every active initialization gap and material conflict;
- one `document_asset` decision keyed by exact path for every pending document
  placement item;
- each decision's affected candidate IDs;
- a complete `resolved_output` that preserves unaffected candidate meaning and
  inventory and semantic-unit coverage;
- complete origin-to-current lineage, control-surface dispositions, and a
  closed-book audit with no live legacy authority dependency;
- a `canonical_user_approved` decision candidate for every material conflict.

Preview the package to the user when any material conflict exists. After the
user confirms the whole change, run:

`.assistant\system\assistant.cmd bootstrap-resolve --input <exact-json-path> --confirm --json`

For gap-only resolution with no material conflict or document placement, omit
`--confirm`. Never delete or downgrade a blocker without recording its answer
in the package. The command validates declared changes, applies the approved
relocation and cold-boundary ledger transaction, activates canonical knowledge
atomically, performs boundedness maintenance, validates closed-book state, and
reports environment readiness.

After successful activation, run
`.assistant\system\assistant.cmd bootstrap-deferred --claim --json`. Tell the user
that initialization is resolved and that you are returning to the original
request, then perform that request under the newly active canonical state.
After its durable state is safely recorded, run
`.assistant\system\assistant.cmd bootstrap-deferred --complete --json`. A new session
may reclaim an `in_progress` request; do not rely on chat history alone.
