# ReferenceCard Evidence Acceptance

**Date:** 2026-06-04
**Status:** Design
**Governance:** `docs/trajectory-governance.md`
**Predecessor:** `docs/superpowers/specs/2026-06-04-referencecard-v1-trust-tranche-design.md`

## Decision

The next tranche should be a deterministic **ReferenceCard Evidence Acceptance** layer.

The Revenue ReferenceCard v1 tranche created the content primitive, validation gates, File Search sync, and benchmark fields needed to observe whether reference cards are retrieved and followed. The next tranche should not add another domain or runtime behavior yet. It should convert benchmark records into an explicit accept/revise decision for the revenue pilot.

This is a design for the next implementation tranche. It does not claim the acceptance analyzer already exists.

## Alternatives Considered

### Option A: Manual Benchmark Review

Run benchmarks and inspect JSON by hand.

Tradeoff: fastest to start, but too easy to miss a retrieval miss, model-declared table mismatch, or validation-layer failure. It does not create repeatable evidence for governance.

### Option B: Deterministic Acceptance Analyzer

Add pure helpers that read benchmark JSON and produce a compact markdown acceptance report.

Tradeoff: modest implementation work, but it creates a stable acceptance surface without adding live-service flakiness to CI. This is the selected approach.

### Option C: Live CI Gate

Run the full benchmark in CI and fail the build on acceptance failure.

Tradeoff: too brittle for this stage because it depends on Gemini, File Search, BigQuery credentials, dbt artifacts, and data warehouse state. Keep CI structural and deterministic for now.

## Tranche Boundary

In scope:

- Acceptance helpers for benchmark runs that already contain reference-card fields.
- A markdown report for revenue ReferenceCard evidence.
- Failure classification by deterministic benchmark fields.
- Optional comparison to a previous benchmark run.
- Unit tests with benchmark-run fixtures.
- A governance note when the first acceptance run is recorded.

Out of scope:

- New reference-card domains.
- New Slack UI or user-facing provenance footer.
- New domain router, domain agent, or custom retrieval layer.
- Automatic card rewriting.
- Live benchmark execution in pull-request CI.
- LLM judging as a requirement for ReferenceCard v1 acceptance.

## Acceptance Rules

A benchmark run is accepted for the revenue pilot only when all rules below pass:

1. Run metadata includes git SHA, dirty state, corpus hash, model name, File Search store ID, and dbt artifact hashes when artifacts are available.
2. Every corpus case with `expectedReferenceIds` has `referenceRetrievalPassed === true`.
3. Every revenue reference case with `expectedTables` has `tableSelectionPassed === true`.
4. Every revenue reference case with `expectedSqlContains` has `sqlShapePassed === true`.
5. No SQL-generating revenue reference case has `qualityVerdict` equal to `exhausted` or `cost_exceeded`; clarification-only cases are evaluated by clarification expectations instead.
6. Final SQL validation has L1, L3, and L4 passing for each SQL-generating revenue reference case.
7. L2 failures remain visible but do not fail acceptance because L2 is advisory.
8. The ambiguous `revenue` case has `clarificationPassed === true` when it declares `expectedClarificationConfidence`.

## Module Design

Add a focused script helper:

```text
scripts/benchmarkAcceptance.ts
```

Responsibilities:

- Select acceptance-relevant benchmark cases.
- Evaluate the acceptance rules.
- Classify each failure into one of:
  - `missing_metadata`
  - `retrieval_miss`
  - `table_mismatch`
  - `sql_shape_mismatch`
  - `validation_failure`
  - `clarification_mismatch`
  - `pipeline_failure`
- Format a compact markdown report.

Extend:

```text
scripts/benchmark-analyze.ts
```

Responsibilities:

- Preserve existing judge-summary behavior.
- Always include deterministic ReferenceCard acceptance output, even when `judgeResults` is empty.
- Write the report next to the benchmark JSON as:

```text
benchmarks/results/<run-date>-referencecard-acceptance.md
```

## Data Flow

```text
benchmarks/results/<run>.json
  -> parse BenchmarkRun
  -> evaluateReferenceCardAcceptance(run)
  -> formatReferenceCardAcceptanceReport(result)
  -> write <run>-referencecard-acceptance.md
```

When a previous benchmark run is provided:

```text
current + previous
  -> compare case-level acceptance status
  -> flag newly failing cases and newly passing cases
```

The comparison should not be a hard requirement for acceptance. It is diagnostic context.

## Report Shape

The markdown report should include:

- `# ReferenceCard Acceptance - <runDate>`
- Overall decision: `ACCEPTED` or `NEEDS_REVISION`
- Run provenance table.
- Revenue scorecard table with one row per relevant corpus case.
- Failure table with corpus ID, failure class, and detail.
- Suggested next action:
  - If accepted: "Expand to one next high-confusion domain."
  - If rejected: "Tighten the failing layer before expanding domain scope."

## Error Handling

The analyzer should fail fast on malformed benchmark JSON.

Missing optional sections should be handled deliberately:

- Missing `judgeResults` is allowed.
- Missing `metadata` fails acceptance because provenance is part of the evidence contract.
- Missing reference-card fields on cases without expectations is allowed.
- Missing deterministic reference-card fields on expected reference cases fails acceptance, and missing observed arrays should be treated as empty for clear reporting rather than crashing the analyzer.

## Testing

Add focused tests for:

- Passing revenue acceptance fixture.
- Retrieval miss fixture.
- SQL-derived table mismatch fixture.
- SQL-shape mismatch fixture.
- Advisory L2 failure that remains visible but does not fail acceptance.
- Missing metadata fixture.
- Previous/current comparison with a newly failing case.

Use mocked or inline JSON fixtures only. Do not call Gemini, BigQuery, Firestore, or File Search in acceptance tests.

## Completion Criteria

This tranche is complete when:

1. `scripts/benchmarkAcceptance.ts` exists with pure acceptance helpers.
2. `scripts/benchmark-analyze.ts` writes a ReferenceCard acceptance report.
3. Unit tests cover the acceptance rules and failure classes.
4. The analyzer can run against a benchmark JSON with empty `judgeResults`.
5. The governance doc records the first real acceptance decision after a live benchmark run.

## Future Follow-Up

If the revenue pilot is accepted, the next product tranche may add exactly one additional high-confusion domain. If it is not accepted, the next tranche should be card/prompt/benchmark repair scoped to the failing evidence category.
