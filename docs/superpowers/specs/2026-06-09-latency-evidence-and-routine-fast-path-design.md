# Latency Evidence And Routine Fast Path Design

**Date:** 2026-06-09  
**Status:** Approved direction; design pending implementation plan  
**Governing checkpoint:** `docs/trajectory-governance.md`

## Problem

Some analytics answers can currently take one to two minutes. That violates the product target of P95 end-to-end latency below 30 seconds, even though the current pipeline is intentionally trust-heavy.

The existing model-sizing work produced a useful boundary:

- Small install-invariant classifier nodes can run on cheaper/faster Gemini 3.x models.
- Schema-dependent reasoning nodes, especially `sqlGenerator` and `supervisor`, remain unsized because the available corpus evidence was too noisy.
- The `clarification` node has a promising implementation-specific downsize, but should be applied through `NODE_PROFILE_OVERRIDES`, not as a template default.

The next work should reduce latency without weakening the trust model or committing implementation-specific benchmark artifacts to this reusable template.

## Goals

1. Produce a fresh latency evidence slice for the current implementation using an external, gitignored corpus.
2. Validate the implementation-specific `clarification` profile override before recommending deploy config.
3. Design a conservative runtime fast path for routine ReferenceCard-backed questions.
4. Preserve the existing read-only, dry-run, cost-gate, and escalation protections.
5. Keep all client-specific corpus files, benchmark outputs, project IDs, store IDs, dbt artifacts, and local trial evidence out of the template repository.

## Non-Goals

- No full `sqlGenerator` / `supervisor` model downsize without a meaningful live sweep result.
- No automatic supervisor removal for all questions.
- No new product surface such as charts, BQML expansion, or broad domain agents.
- No committed implementation corpus or benchmark output under `benchmarks/results/`.
- No automatic correction harvesting or auto-promotion into teachings.

## Approach

This work has two connected slices.

### Slice 1: Latency Evidence

Run a small, controlled latency pass before making runtime changes.

The evidence run uses an operator-provided corpus path outside the repository. The run must not print secrets, commit corpus rows, or commit benchmark results. It should capture only the summary needed to decide the next implementation step.

Measurements:

- Default node profiles.
- `NODE_PROFILE_OVERRIDES` with `clarification` set to `flash-lite/3.1` and `thinkingLevel: minimal`.
- Optional `--bypass-clarification` smoke to isolate SQL-path timing without allowing LOW clarification verdicts to hide `sqlGenerator` and `supervisor`.

Report:

- P50/P95 total pass time.
- Per-node p95 latency for `clarification`, `sqlGenerator`, and `supervisor`.
- Token counts by node.
- Clarification LOW rate.
- Fallback/error count.
- Whether the `clarification` override is safe enough to apply in local deploy config.

The result of this slice is an operational recommendation, not a template default change.

### Slice 2: Routine Query Fast Path

Add a narrow runtime path for questions that are likely routine, well-grounded, and low-risk.

The fast path should sit after clarification and retrieval, before the existing `qualityLoop`. It should keep SQL generation and all deterministic validation layers, while making supervisor review conditional for highly routine cases.

The current full quality loop remains the fallback for every non-eligible question and for any fast-path uncertainty.

## Fast Path Eligibility

A query is eligible only when all required conditions pass:

- Clarification confidence is `medium` or `high`.
- The request is a standard data query, not `dbt_status`, refinement, discrepancy, meta-question, or negative-feedback recovery.
- At least one retrieved ReferenceCard or teaching citation matches the question's domain or metric intent.
- SQL generation returns `medium` or `high` confidence.
- Generated SQL references only tables present in the allowed retrieved schema.
- L1 static analysis passes.
- L2 AST validation has no blocking effect, preserving current advisory behavior.
- L3 BigQuery dry run passes.
- L4 cost gate passes.
- Estimated bytes processed stay below a stricter fast-path threshold.
- No validation retry was needed.

Any missing signal or parsing uncertainty should make the query ineligible.

## Supervisor Gating

Supervisor review still runs when any risk trigger appears:

- SQL generator confidence is `low`.
- No relevant grounding citation exists.
- Retrieved ReferenceCard IDs are missing when the corpus expects one.
- Generated tables conflict with ReferenceCard canonical or avoid-table guidance.
- Dry run needed a retry or validation failed once.
- Estimated scan size exceeds the fast-path threshold.
- The query uses joins across multiple fact-like tables.
- The query contains BQML, nested subqueries, window functions, or complex date logic.
- The user is refining a prior answer or responding after negative feedback.
- Fast-path pilot mode is configured to sample or require supervisor review.

This makes the fast path "skip supervisor when routine," not "remove supervisor from the product."

## Runtime Flow

1. Slack event handlers continue to use the existing preflight checks.
2. `runPipeline` performs clarification, thread context construction, fallback schema lookup, sample-row loading, and negative-feedback lookup as it does today.
3. A new fast-path eligibility helper evaluates the clarified question and available context.
4. If ineligible, `runPipeline` calls the existing `qualityLoop` unchanged.
5. If eligible, the fast path generates SQL once, records node usage, and runs L1 through L4 validation.
6. If validation fails, confidence drops, or a risk trigger appears, execution falls back to `qualityLoop` with the failed attempt as context.
7. If validation passes and no supervisor trigger appears, the query executes and formats normally.
8. ResponseContext records whether the full loop or routine fast path was used, which supervisor triggers were evaluated, and why supervisor was skipped or run.

## Data And Types

Add a small fast-path result type instead of widening existing agent contracts broadly.

Suggested fields:

- `mode`: `full_quality_loop` or `routine_fast_path`
- `eligible`: boolean
- `ineligibleReasons`: string[]
- `supervisorDecision`: `skipped` or `required`
- `supervisorTriggers`: string[]
- `validationHistory`: existing `ValidationLayerRecord[]`
- `bytesProcessed`: number
- `nodeUsage`: optional benchmark-only telemetry

ResponseContext should persist the mode and supervisor decision. It should not store result rows.

## Observability

Structured logs should include:

- `traceId`
- selected path
- eligibility decision
- ineligible reasons
- supervisor triggers
- validation-layer outcome
- bytes processed
- elapsed milliseconds

The benchmark/analyzer path should be able to report fast-path eligibility and supervisor-skip decisions. This lets the team compare speed against correctness evidence rather than treating latency as an isolated metric.

## Configuration

Use configuration rather than hardcoding rollout behavior:

- `NODE_PROFILE_OVERRIDES` remains the way to apply the `clarification` downsize in a specific implementation.
- Add a fast-path feature flag, default off.
- Add a stricter fast-path byte threshold.
- Add pilot controls for supervisor sampling or forced supervisor review during rollout.

The default template behavior remains the current full quality loop until an implementation intentionally enables the fast path.

## Error Handling

The fast path must fail closed.

- Invalid or missing eligibility inputs route to the full quality loop.
- Failed SQL generation routes to the existing error path.
- Validation failure routes to the full quality loop with previous-attempt context where possible.
- Cost-gate failure keeps the current user-facing cost message.
- Any persistence failure is logged but does not expose raw internals to users.

## Testing

Unit tests:

- Eligibility accepts only well-grounded routine cases.
- Each risk trigger requires supervisor review.
- Missing citations, low confidence, validation retry, high bytes, and complex SQL all fail closed.
- The `clarification` override remains an env-only profile choice and does not become a template default.

Integration tests:

- Eligible routine query takes the fast path and persists `mode: routine_fast_path`.
- Ineligible query falls back to `qualityLoop`.
- Validation failure in the fast path falls back to `qualityLoop` with context.
- Supervisor-required fast-path candidate runs supervisor before execution.

Operational checks:

- Run the latency smoke with default profiles.
- Run the latency smoke with the clarification override.
- Run typecheck and the focused fast-path tests.
- Do not commit external corpus or benchmark results.

## Rollout

1. Run the evidence slice locally against the external implementation corpus.
2. If the clarification override holds, apply it only in local/deploy configuration.
3. Implement fast path behind a disabled-by-default flag.
4. Enable pilot mode with supervisor sampling or forced supervisor review.
5. Compare latency, skipped-supervisor cases, validation outcomes, and feedback.
6. Only relax pilot controls after benchmark and analyst review show no correctness regression.

## Governance

This design serves the current trust/evaluation tranche. It does not add a new product surface and does not weaken deterministic validation. If implementation evidence changes the active trajectory, `docs/trajectory-governance.md` must be updated in the same change set as the behavior change.
