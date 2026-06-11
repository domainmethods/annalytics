# ReferenceCard Repair And Re-run

**Date:** 2026-06-11
**Status:** Design
**Governance:** `docs/trajectory-governance.md`
**Predecessor:** `docs/plans/2026-06-10-tranche-a-sessions-traffic-acceptance-design.md`

## Decision

The next tranche is a scoped repair of the first real ReferenceCard acceptance run, followed by a re-run of the same acceptance workflow.

The 2026-06-11 sessions and traffic pilot produced a real benchmark JSON, analyzer reports, judge enrichment, and a governance verdict of `NEEDS_REVISION`. That means the next work is not another domain and not new evaluation scaffolding. It is repair of the two failed evidence categories already recorded in governance:

1. Clarification-gate coverage for in-domain session-mart metrics that the current cards did not make recognizable enough.
2. SQL-shape conformance where retrieved ReferenceCards were present but the generated query still drifted from the intended dimension or grain.

This tranche is complete only after the repaired implementation content and template-safe prompt/review changes produce a new acceptance report. If the re-run records `ACCEPTED`, domain expansion can re-arm. If it records `NEEDS_REVISION`, the next tranche remains repair-scoped.

## Alternatives Considered

### Option A: Repair Cards Only

Update the implementation-specific live ReferenceCards so the suspended metric questions are covered.

Tradeoff: This is the smallest change and directly addresses the clarification failures. It does not address the two SQL-shape failures, because those already retrieved relevant cards and still passed through generation and supervisor review with the wrong shape.

### Option B: Repair Prompts Only

Tighten generic SQL generation and supervisor prompts so retrieved ReferenceCards are treated as binding constraints.

Tradeoff: This is template-safe and helps future installs. It does not give the clarification agent enough install-local vocabulary for the uncovered metric questions, because clarification consumes local knowledge summaries before SQL generation.

### Option C: Hybrid Repair, Then Re-run

Repair the live cards for the in-domain metric coverage gap and make narrow, template-safe prompt/supervisor changes so retrieved ReferenceCards are enforced more reliably.

Tradeoff: Slightly more work, but it matches the evidence. It repairs both failing categories without widening into a second domain, side-bar work, node sizing, or new benchmark machinery. This is the selected approach.

## Tranche Boundary

In scope:

- Update the operator-local sessions and traffic live ReferenceCards to cover the uncovered in-domain metrics or explicitly classify them out of domain.
- If the corpus contract changes because a metric is declared out of domain, update only the operator-local live corpus slice and record the rationale in the re-run notes.
- Tighten the generic SQL generator prompt so retrieved ReferenceCard fields are treated as operational constraints.
- Tighten the generic supervisor prompt so it fails SQL that contradicts retrieved ReferenceCard constraints.
- Add focused unit tests for the prompt and summary-contract changes.
- Re-run the existing knowledge validation, sync, benchmark, judge, and analyzer workflow.
- Update `docs/trajectory-governance.md` with the re-run decision and next branch.

Out of scope:

- A second ReferenceCard domain.
- New benchmark, calibration, sizing, sweep, or judging machinery.
- Side-bar/admin-consult implementation.
- Teaching impact measurement.
- Fast-path graduation.
- Committed implementation-specific cards, corpus, dbt artifacts, project IDs, File Search store IDs, or raw benchmark evidence.

## Failure Model

The first run showed two distinct failures.

### Coverage Failures

Two in-domain metric questions stopped at LOW clarification before SQL generation. That is a knowledge-coverage issue, not a validator or BigQuery issue. The clarification agent only sees `KnowledgeSummary` records derived from local teachings and ReferenceCards. If a metric is valid for the pilot domain but absent from the summaries, the classifier has no strong reason to treat it as answerable.

Repair principle: make valid in-domain session-mart metrics visible in the live card summaries with aliases and routing triggers. Do not lower the clarification threshold globally. If a metric is not part of the pilot domain, record that decision and remove or reclassify the corpus expectation.

### Shape Failures

Two SQL-generating questions retrieved relevant cards and selected broadly correct tables, but the SQL shape contradicted the intended business meaning:

- A "source" question was answered as a channel-grouping question.
- A session-conversion question reached into a lower-grain staging source instead of using the session mart's pre-aggregated metric.

Repair principle: retrieved ReferenceCards must function as constraints. The generator should treat canonical table, grain, required filters, exclusions, aliases, and avoid tables as binding unless impossible. The supervisor should fail deviations when the generated SQL uses an avoided table, wrong grain, or mismatched dimension for a term the card defines.

## Component Design

### Live ReferenceCards

The implementation-specific live card file remains gitignored and operator-local. This tranche changes its content, not the ReferenceCard schema.

Design requirements:

- Add concise coverage for each valid in-domain metric that previously failed clarification.
- Put metric names, common business phrasing, and routing triggers in the card content that feeds summaries.
- State whether each metric is pre-aggregated at session grain or requires a different domain.
- Strengthen source-vs-channel language: source and medium are distinct from default channel grouping.
- Strengthen mart-vs-staging language: when a session mart carries a metric, prefer that mart over reconstructing the metric from lower-grain events.

Do not add broad GA4 documentation. The card should remain retrieval-friendly: short, specific, and tied to the pilot domain.

### Knowledge Summaries

The clarification prompt consumes `KnowledgeSummary` records from `src/teachings/summaryMap.ts`. The current summary definition includes title, canonical metric, grain, and required guidance. It does not include exclusions or avoid-table guidance.

Design requirement:

- Expand ReferenceCard summary definitions only as much as needed for clarification and routing. Include compact aliases/triggers already present in the prompt path, and include concise required/exclusion language when it affects whether a question should proceed.
- Keep the summary bounded. It should not become the full markdown document; File Search already carries the full card for generation.

This is template-safe because it changes how existing card fields are summarized, not the schema or the live cards themselves.

### SQL Generator Prompt

`src/agents/sqlGenerator.ts` already tells the model to follow ReferenceCards. The repair should make that instruction sharper and auditable.

Design requirements:

- Say that a retrieved ReferenceCard is authoritative for matching terms, metrics, and routing triggers.
- Treat canonical table and grain as the default binding choice.
- Treat avoid tables and exclusions as prohibited unless the generated explanation explicitly says why the card cannot answer the question.
- Preserve term fidelity: do not substitute a broader category when the user asks for a narrower dimension.
- Prefer mart columns over reconstructing a metric from lower-grain staging sources when the mart exposes the metric.

The prompt remains generic. It must not hardcode the sessions pilot's table or column names.

### Supervisor Prompt

`src/agents/supervisorAgent.ts` receives the primary agent's grounding citations, including retrieved ReferenceCard chunks. The first run showed that the supervisor checklist was too generic: it approved SQL that contradicted retrieved-card semantics.

Design requirements:

- Add explicit review criteria for ReferenceCard compliance:
  - canonical table and grain followed
  - required filters present
  - exclusions and avoid tables respected
  - aliases and routing triggers interpreted faithfully
  - mart-level metrics not reconstructed from lower-grain sources when the card provides a mart path
- A contradiction should produce `FAIL` with a concrete suggestion.
- Keep L2 parser behavior unchanged; BigQuery dry run remains the SQL authority.

This change is template-safe because it enforces already-retrieved generic card fields.

### Acceptance Re-run

The re-run uses the existing workflow:

```text
operator-local live cards
  -> knowledge validation
  -> File Search sync
  -> benchmark run
  -> judge enrichment
  -> benchmark analyzer
  -> governance update
```

The re-run should use the same pilot domain and the same corpus family. Corpus edits are allowed only for the coverage decision: if a previously expected metric is formally out of scope, update the live corpus expectation and document the reason in governance.

## Testing

Add focused unit tests around deterministic prompt construction and summary conversion. Do not add live-service tests.

Recommended coverage:

- `tests/teachings/summaryMap.test.ts`: ReferenceCard summaries include enough required/exclusion guidance to make in-domain metrics recognizable without including the full markdown card.
- `tests/agents/sqlGenerator.test.ts`: the prompt says retrieved ReferenceCards are authoritative and that avoid tables/exclusions require explicit justification.
- `tests/agents/supervisorAgent.test.ts`: the prompt tells the supervisor to fail ReferenceCard contradictions, including wrong grain, avoided table, and dimension substitution.

Existing live acceptance commands remain the integration proof. Unit tests prove only that the intended contract reaches the model prompts.

## Error Handling

- If knowledge validation fails, do not sync. Fix card content or dbt references first.
- If File Search sync does not converge to active managed documents, do not benchmark. The acceptance report depends on retrieval evidence.
- If the benchmark fails before corpus work because env vars are absent, fix environment visibility rather than changing code.
- If the analyzer returns `NEEDS_REVISION`, record the failing category and keep the next branch repair-scoped.
- If calibration still fails only because a confidence bucket is missing, record it as non-gating for this tranche. Side bar remains deferred.

## Acceptance Criteria

The tranche is successful when:

1. Template-safe code changes are covered by targeted unit tests.
2. Operator-local live cards validate and sync.
3. The repaired benchmark run produces a JSON artifact and both analyzer reports.
4. The ReferenceCard acceptance report records `ACCEPTED`.
5. `docs/trajectory-governance.md` records the re-run decision, evidence source, and next branch.
6. No implementation-specific cards, corpus, dbt artifacts, project IDs, File Search store IDs, or raw benchmark evidence are committed.

If item 4 fails, items 1-3 may still be valid repair work, but the product branch does not advance.
