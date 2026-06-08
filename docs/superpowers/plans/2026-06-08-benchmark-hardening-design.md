# Benchmark Hardening — Validation Visibility, Teaching Retrieval & Provenance Completion

**Created:** 2026-06-08
**Status:** Design — approved scope, pending implementation plan
**Governance anchor:** `docs/trajectory-governance.md` → "Benchmark Hardening" (lines 104–121)
**Scope decision:** Full hardening pass, sequenced keystone-first.

---

## Goal

Make a benchmark record carry enough information to (a) **explain which validation
layer failed and on which retry attempt**, (b) **measure whether teaching retrieval
fired for cases where it should**, and (c) **be defensibly comparable to another run**.
All three are named acceptance criteria in the governance doc's Benchmark Hardening
section; today the first is degraded, the second is dead, and the third is partial.

This is trust infrastructure that *serves* the implementation-specific ReferenceCard
acceptance pilot (the active tranche): the pilot's acceptance evidence requires a
benchmark slice that shows whether retrieved knowledge improves answers, and a
provenance record strong enough to compare a pre-pilot run against a post-pilot run.

## Non-Goals

- **No new live measurement.** Every change below surfaces signal the pipeline already
  produces (`qualityLoop.validationHistory`, `teaching:` citation prefixes,
  `BenchmarkMetadata.judgeModel`/`gcpProjectId`). Nothing new is computed at query time.
- **No client data in the template.** No real teachings, ReferenceCards, dbt artifacts,
  project IDs, or store IDs are committed. The teaching slice is validated with **mocked
  retrieval and `benchmarks/mock-results/` fixtures**, the same bar references already meet.
- **No runtime behavior change.** L2 stays advisory; the validation pipeline,
  `qualityLoop`, and the agents are untouched. Only the benchmark *record* and the
  *acceptance report* widen.
- **No node-sizing / sweep work.** Orthogonal effort, deferred separately.

---

## Background — what already exists (do not rebuild)

The governance "maintain" list is ~60% satisfied. Confirmed present:

| Maintain item | Where |
|---|---|
| Git SHA + dirty state | `BenchmarkMetadata.gitSha/gitDirty` (`scripts/benchmark-types.ts:18-19`) |
| Corpus hash | `BenchmarkMetadata.corpusHash` (`:21`) |
| dbt manifest/catalog hashes | `dbtManifestHash`/`dbtCatalogHash` (`:22-23`) |
| Model names + store ID **captured** | `geminiModel`/`judgeModel`/`fileSearchStoreId`/`gcpProjectId` (`:24-27`) |
| L2 advisory visibility | acceptance scorecard shows `advisory_fail`, never blocks |
| Reference-ID retrieval (end-to-end) | `expectedReferenceIds`/`observedReferenceIds`/`referenceRetrievalPassed` |

The reference-ID path is the **template to mirror** for teachings, and it is already
unit-tested against `benchmarks/mock-results/`.

---

## The three gaps and their fixes

### Slice 1 — Keystone: preserve per-attempt validation history

**Gap.** `qualityLoop` builds a rich `ValidationLayerRecord[]` — every layer, every
attempt, with an error `detail` and `bytesProcessed`:

```ts
// src/qualityLoop.ts:17-23  (already exists)
export interface ValidationLayerRecord {
  attempt: number;
  layer: 'l1' | 'l2' | 'l3' | 'l4';
  valid: boolean;
  detail?: string;
  bytesProcessed?: number;
}
```

But `scripts/benchmark.ts:269` passes it through `validationResultsFromFailures(...)`,
which **reduces it to four booleans from the final attempt only**
(`scripts/benchmarkSupport.ts:70-106`) and discards the rest. The acceptance report can
therefore say "Final SQL failed L3" but cannot say *why* L3 failed or that attempt 1
failed L1 before attempt 2 failed L3. That is exactly the governance acceptance
criterion "Benchmark records explain **which** validation layer failed."

**Fix.** Stop discarding. Add the array to the record; keep the boolean summary for
backward compatibility and the existing scorecard.

```ts
// scripts/benchmark-types.ts — BenchmarkResult, additive
import type { ValidationLayerRecord } from '../src/qualityLoop.js';

validationResults: { l1: boolean; l2: boolean; l3: boolean; l4: boolean };  // keep
validationHistory: ValidationLayerRecord[];                                 // NEW: full trace
```

- `scripts/benchmark.ts` populates `validationHistory: quality.validationHistory ?? []`
  at the success construction site (`:262`), and `[]` at the error site (`:320`) and the
  early-skip site (`~:182`). `validationResultsFromFailures` is unchanged.
- `scripts/benchmarkAcceptance.ts`: for any case with a blocking failure, render a
  **Validation Trace** — per attempt, the layers that ran and the `detail` of the
  failing one — built from `validationHistory`. L2 entries appear in the trace marked
  advisory (visible, never escalated to a blocking failure). When `validationHistory` is
  empty (older fixtures), fall back to today's "Final SQL failed L1, L3" string so
  existing mock-results still render.

**Acceptance:** a failing case's report names the failing layer, its attempt index, and
its error detail; an advisory L2 failure is visible in the trace without blocking.

### Slice 2 — Teaching retrieval measurement

**Gap.** `expectedTeachingIds` exists on `CorpusEntry` (`:7`) but is never read;
`observedTeachingIds` does not exist; `teachingCompliance` is hardcoded to
`'no_relevant_teaching'` at all three construction sites (`benchmark.ts:182,276,330`).
Yet `src/agents/grounding.ts:64` already stamps `teaching:<id>` onto citation source
files — the signal is present and thrown away, mirroring the (working) reference path.

**Fix.** Mirror the reference-ID path exactly.

1. New support fn beside the reference one (`scripts/benchmarkSupport.ts`):
   ```ts
   // mirrors extractReferenceIdsFromCitations, matching /teaching:([a-z0-9-]+)/i
   export function extractTeachingIdsFromCitations(citations): string[]
   ```
   (Either add a `teaching:` matcher in `src/agents/grounding.ts` and re-export, or
   parse `citationSourceFile` output directly — the plan picks one; both read the prefix
   `grounding.ts` already produces.)
2. New `BenchmarkResult` fields, parallel to references:
   ```ts
   observedTeachingIds: string[];
   teachingRetrievalPassed: boolean | null;   // null when no expectedTeachingIds
   ```
   `teachingRetrievalPassed` reuses the **same** predicate shape as
   `referenceRetrievalPassed` (`benchmarkSupport.ts:127`): `null` when nothing expected,
   else "every expected id observed."
3. Derive the existing `teachingCompliance` string from it instead of hardcoding:
   `null → 'no_relevant_teaching'`, `true → 'followed'`, `false → 'missed'`. The field
   keeps its type; its value finally means something.
4. `benchmark.ts` computes `observedTeachingIds` from the SQL grounding citations
   (`quality.sqlResult.groundingCitations`) at the success site and `[]` on error/skip.

**Acceptance:** a corpus entry with `expectedTeachingIds` yields a non-null
`teachingRetrievalPassed`; observed teaching IDs are captured from citations; the
acceptance report can show a teaching-retrieval column the way it shows references.
Validated with mocked citations + a `mock-results` fixture carrying a `teaching:` id.

### Slice 3 — Provenance completion (cheap polish)

**Gap.** `judgeModel` and `gcpProjectId` are captured in `BenchmarkMetadata` but **not
rendered** in the acceptance report's "Run Provenance" table
(`benchmarkAcceptance.ts:139-151` lists Git SHA, Corpus Hash, Gemini Model, File Search
Store only). Two runs can differ in judge model or project and the comparison table
hides it.

**Fix.** Two `lines.push` rows in the provenance table:
`| Judge Model | … |` and `| GCP Project | … |`, using the existing
`escapeMarkdown(result.metadata?.<field> ?? '(missing)')` pattern. Optionally add a
run-level total/median latency line (decide in the plan; low value, keep only if free).

**Acceptance:** the provenance table renders judge model and GCP project; comparing two
reports surfaces a judge/project difference instead of silently absorbing it.

---

## Data flow (after)

```
qualityLoop  ──validationHistory[]──►  benchmark.ts  ──►  BenchmarkResult.validationHistory   ──►  acceptance: Validation Trace
grounding.ts ──teaching: citations──►  benchmark.ts  ──►  observedTeachingIds + teachingRetrievalPassed ──►  acceptance: teaching column
BenchmarkMetadata.judgeModel/gcpProjectId ─────────────────────────────────────────────────►  acceptance: Run Provenance rows
```

Every arrow starts from data that already exists upstream; the work is connecting it to
the record and the report.

## Files touched

- `scripts/benchmark-types.ts` — widen `BenchmarkResult` (validationHistory, observedTeachingIds, teachingRetrievalPassed).
- `scripts/benchmarkSupport.ts` — `extractTeachingIdsFromCitations`, `teachingRetrievalPassed` (or reuse a generic predicate), `teachingCompliance` derivation.
- `scripts/benchmark.ts` — populate the new fields at the 3 construction sites (success / error / early-skip).
- `scripts/benchmarkAcceptance.ts` — Validation Trace renderer, teaching column, two provenance rows.
- `src/agents/grounding.ts` — only if a `teaching:` extractor is added there for re-use.
- Tests: `tests/scripts/benchmarkSupport.test.ts` (+ acceptance/grounding tests as they exist), and a `benchmarks/mock-results/` fixture exercising a teaching id and a multi-attempt validation trace.

## Testing strategy

- **Pure functions first (TDD).** `extractTeachingIdsFromCitations`,
  `teachingRetrievalPassed`, and the `teachingCompliance` derivation are pure — test with
  literal citation arrays, no mocks. Mirror the existing reference-ID tests.
- **Validation trace** is rendered from a literal `validationHistory[]` — test the
  acceptance renderer with a hand-built two-attempt history (L1 fail → L3 fail) and assert
  the report names layer + attempt + detail, and that an L2 advisory line is present but
  non-blocking. Test the empty-history fallback path against an existing fixture.
- **Fixtures.** Add/extend a `benchmarks/mock-results/*.json` with a `teaching:` observed
  id and a populated `validationHistory`, asserting the analyzer's `*-acceptance.md`
  output. `benchmarks/results/*` stays gitignored; only `mock-results/` is committed.
- **No external services.** BigQuery/Gemini/Firestore/Slack remain mocked; the template
  ships no live teaching corpus, so teaching capture is proven structurally, not on real
  knowledge — the appropriate bar for template infrastructure.
- `npm run typecheck` + `npm test` green; the additive `BenchmarkResult` fields must not
  break existing fixtures (hence keep `validationResults` and make the new array
  default-`[]` on read).

## Sequencing (keystone-first, each task independently committable)

1. **Slice 1 — validation history** (the named #1 criterion; forces the type-widening the
   rest lean on). Bankable on its own if work stops here.
2. **Slice 2 — teaching retrieval** (the pilot-relevant evidence).
3. **Slice 3 — provenance rows** (trivial; finishes "defensible comparison").

Each is TDD: failing test → minimal impl → green → commit. After all three, update
`docs/trajectory-governance.md` "Benchmark Hardening" notes to record the subsection as
satisfied (per its Maintenance Protocol), and run `npm test` + `npm run typecheck` as the
final gate.

## Risks & mitigations

- **Fixture breakage** from a required new field → keep additions optional-on-read
  (default `[]`/`null`) and retain the boolean summary; the acceptance renderer must
  tolerate empty `validationHistory`.
- **Teaching extractor drift** from the reference one → derive both from the single
  `citationSourceFile` prefix convention in `grounding.ts`; add a test asserting a mixed
  `reference_card:`/`teaching:` citation list splits correctly.
- **Scope creep into live validation** → explicitly out of scope; if real teaching
  quality matters, that's the implementation-repo pilot, not this template change.
