# Benchmark Abstention Discriminator Design

**Date:** 2026-06-25
**Status:** Draft for written-spec review
**Scope:** Fix the benchmark calibration instrument so intentional clarification abstentions are not conflated with benchmark crashes

## Summary

Add an explicit `abstained` discriminator to benchmark results. Today,
`generatedSql === null` means two different things:

- the benchmark intentionally stopped because the clarification classifier
  returned LOW confidence; or
- the benchmark failed before producing SQL.

The calibration reducer currently skips every `generatedSql === null` result.
That correctly avoids counting LOW clarification abstentions as wrong answers,
but it also silently drops crash rows. A partially crashed run can therefore
look cleaner than it is.

The fix is to move the truth to the producers: benchmark-shaped results should
say whether they intentionally abstained. Calibration should exclude only
explicit abstentions, while null-SQL failures continue through normal judge
coverage and wrong-rate handling.

## Context

`docs/trajectory-governance.md` lists this as a Code Debt Register item:
`Benchmark generatedSql === null overloaded (abstention vs crash)`. The same
document permits fixing defects in existing instruments while keeping net-new
benchmark/scaffolding work deferred behind higher-priority trust work.

This is an engineering fallback item, not a product tranche. It does not add a
new benchmark runner, change the Slack or WhatsApp runtime, add a ReferenceCard
domain, or relax the template boundary around client-specific benchmark
artifacts.

## Goals

- Distinguish intentional LOW clarification abstentions from benchmark failures
  in the `BenchmarkResult` data contract.
- Exclude only intentional abstentions from calibration buckets.
- Count or flag null-SQL failures instead of silently dropping them.
- Keep older benchmark JSON readable without requiring historical artifact
  rewrites.
- Keep the change bounded to benchmark scripts and script tests.

## Non-Goals

- Do not rerun live benchmark acceptance data as part of this change.
- Do not rewrite historical `benchmarks/results/*.json` artifacts.
- Do not change judge scoring semantics.
- Do not add new calibration gates or side-bar behavior.
- Do not modify the application pipeline, Slack response flow, or WhatsApp
  prototype flow.
- Do not commit implementation-specific dbt artifacts, project IDs, File Search
  store IDs, ReferenceCards, or new live benchmark evidence.

## Alternatives Considered

### A. Add `abstained: boolean`

Add a boolean discriminator to `BenchmarkResult`.

This is the recommended approach. It matches the governance note directly,
keeps the schema small, and gives the calibration reducer a precise signal. It
also keeps the existing `generatedSql` field focused on payload shape rather
than lifecycle meaning.

### B. Add `resultKind: 'answer' | 'abstention' | 'error'`

This is more expressive and could support richer result reporting later.
However, the current defect only needs to distinguish intentional abstention
from non-abstention. Introducing a broader lifecycle enum now would touch more
call sites and invite reporting decisions that are outside this maintenance
slice.

### C. Infer Abstention From Existing Fields

The reducer could inspect `supervisorNotes`, `confidence`, `qualityVerdict`, or
`clarificationPassed`.

This is rejected. It preserves the original problem in a different form:
calibration would depend on wording conventions and loosely correlated fields
instead of a producer-owned fact.

## Recommended Design

Use Alternative A.

Extend `BenchmarkResult` with:

```ts
abstained: boolean;
```

Producer semantics:

- `abstained: true` means the benchmark intentionally suspended because
  clarification confidence was LOW and no SQL answer was attempted.
- `abstained: false` means the row is not an intentional abstention. This
  includes normal answers and error rows where `generatedSql` is `null`.
- `generatedSql: null` remains valid, but it no longer controls calibration
  exclusion by itself.

Consumer semantics:

- Calibration skips only rows where `result.abstained === true`.
- A row with `generatedSql: null` and `abstained: false` is treated like any
  other attempted benchmark result:
  - if a judge result exists, it contributes to that confidence bucket and may
    be counted wrong;
  - if a judge result is missing, it appears in `missingJudgeCorpusIds` and the
    verdict fails with `missing_judge_results`.

## Producer Changes

Update all code paths that create `BenchmarkResult` values.

In `scripts/benchmark.ts`:

- LOW clarification branch: set `abstained: true`.
- Normal quality-loop result: set `abstained: false`.
- catch/error fallback result: set `abstained: false`.

In `scripts/node-sweep.ts`:

- `buildResult` should accept or derive an `abstained` value.
- The LOW clarification skip path should produce `abstained: true`.
- The quality-loop path should produce `abstained: false`.

`node-sweep` still may avoid a judge LLM call for explicit abstentions, because
that optimization is about cost and determinism inside the sweep. The key
contract is that downstream benchmark-shaped consumers can tell why
`generatedSql` is null.

## Backward Compatibility

Historical benchmark JSON may not have `abstained`. Runtime consumers should be
defensive:

```ts
if (result.abstained === true) continue;
```

Only an explicit `true` value excludes a row from calibration. Missing
`abstained` means the row is not proven to be an intentional abstention. This is
conservative for calibration and avoids rewriting historical artifacts.

Tests and new producers should use the required TypeScript field so newly
created benchmark results cannot omit the discriminator accidentally.

## Reporting

No new report section is required. Existing acceptance reports already include
the calibration verdict and bucket table. Once calibration uses `abstained`,
those existing outputs become truthful for partial-crash runs.

The summary's pipeline-failure count can remain based on `qualityVerdict`; this
change is specifically about calibration exclusion, not redefining every report
metric.

## Testing

Use script-level tests only.

Required cases:

- An explicit abstention with `generatedSql: null` and `abstained: true` is not
  included in calibration totals, wrong counts, or missing judge IDs.
- A null-SQL non-abstention with `abstained: false` and a wrong judge result is
  included in the confidence bucket and counted wrong.
- A null-SQL non-abstention with `abstained: false` and no judge result is
  reported in `missingJudgeCorpusIds`.
- Test helpers that create `BenchmarkResult` values default to
  `abstained: false`.
- `node-sweep` LOW clarification behavior continues to skip the judge and floor
  the score, while marking the benchmark-shaped row as an abstention.

Verification commands:

```bash
npx vitest run tests/scripts/benchmarkCalibration.test.ts tests/scripts/benchmarkAcceptance.test.ts tests/scripts/benchmark-analyze.test.ts tests/scripts/createRunCorpusOnce.test.ts
npm run typecheck
npm test
```

## Acceptance Criteria

- `BenchmarkResult` has an explicit `abstained` discriminator.
- `scripts/benchmark.ts` marks only LOW clarification skips as abstentions.
- `scripts/node-sweep.ts` marks only LOW clarification skips as abstentions.
- Calibration skips explicit abstentions only.
- Null-SQL non-abstentions are never silently dropped by calibration.
- Existing committed benchmark JSON remains readable.
- No live benchmark artifacts or implementation-specific identifiers are added.

## Risks And Mitigations

**Risk:** Older accepted mock fixtures contain null SQL rows without
`abstained`, and calibration may treat them more conservatively.

**Mitigation:** This is acceptable for calibration because missing
`abstained` is not proof of intentional abstention. Existing ReferenceCard
acceptance behavior should remain governed by its own clarification scorecard.

**Risk:** A future producer creates a benchmark result without setting
`abstained`.

**Mitigation:** Make the field required in TypeScript and update all current
producers and test helpers.

**Risk:** Someone expects `generatedSql === null` to remain the abstention
signal.

**Mitigation:** Update reducer comments and tests so the new invariant is
visible where the old behavior lived.
