# Research semantic schema

This file is a system contract, not project knowledge.

Ongoing records use `origin: "ongoing"` and
`workflow_schema: "research.<type>/v1"` in node or collection-record metadata.
Each collection record is bounded by:

```text
<!-- assistant-record:start <stable-id> -->
...
<!-- assistant-record:end <stable-id> -->
```

Use `Unknown — <reason>` for information that is not known. A required field
must not be silently omitted.

## Research question

Required `###` headings:

`Question`, `Why it matters`, `Related theory`, `Prior work`,
`Evidence needed`, `Related hypotheses`, `Experiments or milestones`,
`Current partial answer`, `Open scope`.

## Hypothesis

Required headings:

`Statement`, `Rationale`, `Mechanism basis`, `Published or local evidence`,
`Competing explanations`, `Required controls`, `Decisive test`,
`Falsification or stop condition`, `Current disposition`, `Allowed claim`,
`Prohibited overclaim`.

A hypothesis must relate to a question through `depends_on` or `derived_from`.
Do not collapse disposition to boolean. Use project-appropriate values such as
`proposed`, `under_test`, `supported`, `challenged`, `rejected`,
`inconclusive`, `deferred`, or `abandoned`.

## Experiment

Required headings:

`Question or hypothesis`, `Test`, `Method`, `Inputs and conditions`, `Controls`,
`Independent unit`, `Metrics`, `Completion or stop condition`, `Result`,
`Establishable scope`, `Non-establishable scope`, `Interpretation`,
`Artifact identity`, `Decision consequence`.

An experiment must have a `tests` relation to a question or hypothesis. Before
execution, `Result` and later fields may explicitly say not run. After a
material result, update the experiment promptly and create or update evidence;
do not wait for a terminal report.

## Evidence

Required headings:

`Observation`, `Conditions`, `Artifact identity`, `Supports`, `Challenges`,
`Limitations`.

Evidence must relate to an experiment through `derived_from` or `produces`.
Artifact bytes do not own interpretation.

## Literature

Required headings:

`Contribution`, `Conditions and data`, `Evidence`,
`What it does not establish`, `Project role`,
`Reproduction, code, and data`, `Supported claims`.

Do not infer missing bibliographic fields. Preserve why a reference matters,
not just its citation.

## Storage and growth

- Co-routed small questions, hypotheses, and literature may share a research
  agenda collection.
- Co-routed small experiments and evidence may share a research evidence
  collection.
- Split when a record needs independent routing/lifecycle or its owner crosses
  the validator warning. Preserve the record ID and all incoming relations.
- Consolidate only small co-routed records whose independent lifecycle has
  ended. Never consolidate merely to reduce file count.
