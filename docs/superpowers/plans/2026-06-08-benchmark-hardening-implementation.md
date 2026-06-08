# Benchmark Hardening Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Make benchmark records carry per-attempt validation traces, measure teaching
retrieval, and complete the comparison provenance — closing the three gaps in
`docs/superpowers/plans/2026-06-08-benchmark-hardening-design.md`.

**Architecture:** Every change surfaces signal the pipeline already produces
(`qualityLoop.validationHistory`, `teaching:` citation prefixes,
`BenchmarkMetadata.judgeModel`/`gcpProjectId`). No runtime change, no new live
measurement, no client data. Pure helpers are added to `scripts/benchmarkSupport.ts` and
`src/agents/grounding.ts` (TDD, no mocks); the benchmark record type widens additively;
the acceptance report renders the new fields. The reference-ID path is the working
template to mirror for teachings.

**Tech Stack:** TypeScript (NodeNext ESM, `.js` import specifiers), Vitest. Validation
layers and report formatting are pure functions tested without mocks.

**Sequencing:** keystone-first. Task 1 (validation trace) is the named #1 governance
acceptance criterion and forces the type-widening the others lean on; Task 2 (teaching
retrieval) is the ReferenceCard-pilot evidence; Task 3 (provenance) is trivial polish;
Task 4 closes out (governance note + full gate).

**Conventions to respect:**
- `benchmarks/results/*` is gitignored; only `benchmarks/mock-results/*` is committed.
- New `BenchmarkResult` fields are read defensively in the acceptance code
  (`arrayOrEmpty(...)`, `?? null`) so existing mock fixtures without them still render.
- Mirror existing patterns: teachings copy references; new helpers sit beside their
  reference twins; tests mirror the reference test blocks.
- Commit after each green task. Trailer: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

---

## Task 1: Preserve per-attempt validation history (keystone)

**Files:**
- Modify: `scripts/benchmark-types.ts` (add field + import)
- Modify: `scripts/benchmarkSupport.ts` (add `formatValidationTrace`)
- Modify: `scripts/benchmark.ts` (populate field at 3 construction sites)
- Modify: `scripts/benchmarkAcceptance.ts` (enrich `validation_failure` detail via trace)
- Test: `tests/scripts/benchmarkSupport.test.ts`, `tests/scripts/benchmarkAcceptance.test.ts`

### Step 1.1: Write the failing test for `formatValidationTrace`

In `tests/scripts/benchmarkSupport.test.ts`, add a `describe('formatValidationTrace')`:

```ts
import { formatValidationTrace } from '../../scripts/benchmarkSupport.js';
import type { ValidationLayerRecord } from '../../src/qualityLoop.js';

describe('formatValidationTrace', () => {
  it('names the failing layer, attempt index, and detail per attempt', () => {
    const history: ValidationLayerRecord[] = [
      { attempt: 0, layer: 'l1', valid: false, detail: 'DML keyword blocked' },
      { attempt: 1, layer: 'l1', valid: true },
      { attempt: 1, layer: 'l2', valid: false, detail: 'parse: unexpected token' },
      { attempt: 1, layer: 'l3', valid: false, detail: 'Table not found: foo' },
    ];
    const trace = formatValidationTrace(history);
    expect(trace).toContain('a0 L1✗ (DML keyword blocked)');
    expect(trace).toContain('a1 L3✗ (Table not found: foo)');
    // L2 is advisory: visible, flagged advisory, never escalated
    expect(trace).toContain('L2✗ advisory');
  });

  it('returns an empty string for empty/undefined history (older fixtures)', () => {
    expect(formatValidationTrace([])).toBe('');
    expect(formatValidationTrace(undefined)).toBe('');
  });

  it('omits passing layers from the trace, keeping only failures', () => {
    const history: ValidationLayerRecord[] = [
      { attempt: 0, layer: 'l1', valid: true },
      { attempt: 0, layer: 'l3', valid: true },
    ];
    expect(formatValidationTrace(history)).toBe('');
  });
});
```

### Step 1.2: Run it — expect FAIL

Run: `npx vitest run tests/scripts/benchmarkSupport.test.ts -t formatValidationTrace`
Expected: FAIL — `formatValidationTrace is not a function`.

### Step 1.3: Implement `formatValidationTrace`

In `scripts/benchmarkSupport.ts` (it already imports `ValidationLayerRecord`):

```ts
// Compact, deterministic per-attempt failure trace for the acceptance report.
// Only failing layers appear; L2 is marked advisory (visible, never blocking).
export function formatValidationTrace(history: ValidationLayerRecord[] = []): string {
  return history
    .filter(r => !r.valid)
    .map(r => {
      const advisory = r.layer === 'l2' ? ' advisory' : '';
      const detail = r.detail ? ` (${r.detail})` : '';
      return `a${r.attempt} ${r.layer.toUpperCase()}✗${advisory}${detail}`;
    })
    .join('; ');
}
```

### Step 1.4: Run it — expect PASS

Run: `npx vitest run tests/scripts/benchmarkSupport.test.ts -t formatValidationTrace`
Expected: PASS.

### Step 1.5: Add `validationHistory` to the `BenchmarkResult` type

In `scripts/benchmark-types.ts`, add the import and the optional field (optional so
external mock JSON without it still satisfies the type at the read boundary):

```ts
import type { ValidationLayerRecord } from '../src/qualityLoop.js';
// ...inside BenchmarkResult, next to validationResults:
validationResults: { l1: boolean; l2: boolean; l3: boolean; l4: boolean };
validationHistory?: ValidationLayerRecord[];   // NEW: full per-attempt trace
```

### Step 1.6: Populate it at all three construction sites in `scripts/benchmark.ts`

- Success site (`~:262`): add `validationHistory: quality.validationHistory ?? [],`
- Error site (`~:320`): add `validationHistory: [],`
- Early-skip site (`~:182`): add `validationHistory: [],`

Run `npm run typecheck` — expect clean (additive optional field, all sites set it).

### Step 1.7: Write the failing acceptance-report test

In `tests/scripts/benchmarkAcceptance.test.ts`, add a case asserting the
`validation_failure` detail now carries the trace. Build a minimal `BenchmarkResult`
(reuse an existing test factory if present) with:
`qualityVerdict: 'exhausted'`, `validationResults: { l1: true, l2: true, l3: false, l4: true }`,
and a `validationHistory` showing `a1 L3✗ (Table not found: foo)`. Assert the produced
report's Failures table detail for that case contains both the layer summary and the
trace, e.g. `expect(detail).toContain('L3')` and `expect(detail).toContain('Table not found: foo')`.
Add a second case with **no** `validationHistory` (empty) asserting the detail falls back
to today's `Final SQL failed L3` string (no trace appended, no crash).

Run: `npx vitest run tests/scripts/benchmarkAcceptance.test.ts` — expect FAIL on the trace assertion.

### Step 1.8: Enrich the `validation_failure` detail in `scripts/benchmarkAcceptance.ts`

In `evaluateCase`, where the blocking `validation_failure` is pushed (`~:257-263`), append
the trace when present:

```ts
} else if (!isClarificationOnly && blockingValidationFailures.length > 0) {
  const trace = formatValidationTrace(result.validationHistory);
  failures.push({
    corpusId: result.corpusId,
    failureClass: 'validation_failure',
    detail: `Final SQL failed ${blockingValidationFailures.join(', ')}`
      + (trace ? `. Trace: ${trace}` : ''),
  });
}
```

Import `formatValidationTrace` from `./benchmarkSupport.js`.

### Step 1.9: Run the full benchmark test suite — expect PASS

Run: `npx vitest run tests/scripts/` then `npm run typecheck`. Expected: PASS, clean.

### Step 1.10: Commit

```bash
git add scripts/benchmark-types.ts scripts/benchmarkSupport.ts scripts/benchmark.ts \
        scripts/benchmarkAcceptance.ts tests/scripts/
git commit -m "feat(benchmark): preserve per-attempt validation trace in records and report"
```

---

## Task 2: Teaching retrieval measurement

**Files:**
- Modify: `src/agents/grounding.ts` (add `extractTeachingIdsFromCitations`)
- Modify: `scripts/benchmarkSupport.ts` (re-export extractor + `teachingRetrievalPassed` + `teachingComplianceLabel`)
- Modify: `scripts/benchmark-types.ts` (add `observedTeachingIds`, `teachingRetrievalPassed`)
- Modify: `scripts/benchmark.ts` (compute + populate at 3 sites; read `expectedTeachingIds`)
- Modify: `scripts/benchmarkAcceptance.ts` (teaching column + `teaching_miss` failure class)
- Add: a `benchmarks/mock-results/*.json` fixture carrying a `teaching:` observed id
- Test: `tests/agents/grounding.test.ts`, `tests/scripts/benchmarkSupport.test.ts`, `tests/scripts/benchmarkAcceptance.test.ts`

### Step 2.1: Failing test — `extractTeachingIdsFromCitations`

In `tests/agents/grounding.test.ts`, mirror the reference test. The extractor must match
`teaching:<id>` in `sourceFile` and `Teaching: <id>` in `chunkText`, sorted & deduped:

```ts
import { extractTeachingIdsFromCitations } from '../../src/agents/grounding.js';

it('extracts teaching ids from source files and chunk text', () => {
  expect(extractTeachingIdsFromCitations([
    { sourceFile: 'teaching:revenue-grain', chunkText: '' },
    { sourceFile: 'x', chunkText: 'Teaching: session-window' },
    { sourceFile: 'reference_card:rev-001', chunkText: '' },  // not a teaching
  ])).toEqual(['revenue-grain', 'session-window']);
});
```

### Step 2.2: Run — expect FAIL. Then implement in `src/agents/grounding.ts`

Mirror `extractReferenceIdsFromCitations` exactly, swapping the prefixes:

```ts
export function extractTeachingIdsFromCitations(
  citations: Pick<GroundingCitation, 'sourceFile' | 'chunkText'>[],
): string[] {
  const ids = new Set<string>();
  for (const citation of citations) {
    const sourceMatch = citation.sourceFile.match(/teaching:([a-z0-9-]+)/i);
    if (sourceMatch) ids.add(sourceMatch[1]);
    const chunkMatch = citation.chunkText.match(/Teaching:\s*([a-z0-9-]+)/i);
    if (chunkMatch) ids.add(chunkMatch[1]);
  }
  return [...ids].sort();
}
```

Run: `npx vitest run tests/agents/grounding.test.ts` — expect PASS.

### Step 2.3: Failing tests — `teachingRetrievalPassed` + `teachingComplianceLabel`

In `tests/scripts/benchmarkSupport.test.ts`, mirror the `referenceRetrievalPassed` block:

```ts
import {
  extractTeachingIdsFromCitations,
  teachingRetrievalPassed,
  teachingComplianceLabel,
} from '../../scripts/benchmarkSupport.js';

describe('teaching retrieval helpers', () => {
  it('passes when every expected teaching id is observed; null when none expected', () => {
    expect(teachingRetrievalPassed(['a', 'b'], ['a', 'b', 'c'])).toBe(true);
    expect(teachingRetrievalPassed(['a', 'b'], ['a'])).toBe(false);
    expect(teachingRetrievalPassed(undefined, [])).toBeNull();
    expect(teachingRetrievalPassed([], ['a'])).toBeNull();
  });

  it('labels compliance from the pass/null state', () => {
    expect(teachingComplianceLabel(null)).toBe('no_relevant_teaching');
    expect(teachingComplianceLabel(true)).toBe('followed');
    expect(teachingComplianceLabel(false)).toBe('missed');
  });
});
```

### Step 2.4: Run — expect FAIL. Then implement in `scripts/benchmarkSupport.ts`

```ts
import { extractTeachingIdsFromCitations as extractCitationTeachingIds } from '../src/agents/grounding.js';

export function extractTeachingIdsFromCitations(
  citations: Pick<GroundingCitation, 'sourceFile' | 'chunkText'>[],
): string[] {
  return extractCitationTeachingIds(citations);
}

// Same shape as referenceRetrievalPassed: null when nothing expected, else
// "every expected id observed". Keeps the two retrieval signals symmetric.
export function teachingRetrievalPassed(
  expectedTeachingIds: string[] | undefined,
  observedTeachingIds: string[],
): boolean | null {
  if (!expectedTeachingIds || expectedTeachingIds.length === 0) return null;
  const observed = new Set(observedTeachingIds);
  return expectedTeachingIds.every(id => observed.has(id));
}

export function teachingComplianceLabel(passed: boolean | null): string {
  if (passed === null) return 'no_relevant_teaching';
  return passed ? 'followed' : 'missed';
}
```

Run: `npx vitest run tests/scripts/benchmarkSupport.test.ts` — expect PASS.

### Step 2.5: Widen `BenchmarkResult` in `scripts/benchmark-types.ts`

Beside the reference fields, mirror them for teachings (required, like `observedReferenceIds`):

```ts
teachingCompliance: string;                 // existing; now derived, not hardcoded
observedTeachingIds: string[];              // NEW
teachingRetrievalPassed: boolean | null;    // NEW (null when no expectedTeachingIds)
```

### Step 2.6: Wire `scripts/benchmark.ts` (3 sites)

At the success site (`~:262`), after `observedReferenceIds` is built:

```ts
const observedTeachingIds = extractTeachingIdsFromCitations(quality.sqlResult.groundingCitations);
const teachingPassed = teachingRetrievalPassed(entry.expectedTeachingIds, observedTeachingIds);
// in the result object, REPLACE the hardcoded teachingCompliance line:
teachingCompliance: teachingComplianceLabel(teachingPassed),
observedTeachingIds,
teachingRetrievalPassed: teachingPassed,
```

At the error site (`~:320`) and early-skip site (`~:182`):

```ts
teachingCompliance: teachingComplianceLabel(teachingRetrievalPassed(entry.expectedTeachingIds, [])),
observedTeachingIds: [],
teachingRetrievalPassed: teachingRetrievalPassed(entry.expectedTeachingIds, []),
```

Import the three helpers from `./benchmarkSupport.js`. Run `npm run typecheck` — clean.

### Step 2.7: Failing test — acceptance teaching column + `teaching_miss`

In `tests/scripts/benchmarkAcceptance.test.ts`: a case with `expectedTeachingIds: ['t1']`
and `teachingRetrievalPassed: false` produces a `teaching_miss` failure; a case with
`teachingRetrievalPassed: true` does not; a case with no expected teachings is unaffected.
Assert the scorecard row includes a Teaching column. Run — expect FAIL.

### Step 2.8: Implement in `scripts/benchmarkAcceptance.ts`

- In `evaluateCase`, mirror the `retrieval_miss` block, gated on
  `arrayOrEmpty(result.expectedTeachingIds).length > 0 && result.teachingRetrievalPassed !== true`,
  pushing `failureClass: 'teaching_miss'` with expected/observed detail. Read observed via
  `arrayOrEmpty(result.observedTeachingIds)`.
- Carry `teachingRetrievalPassed` onto `ReferenceCardCaseAcceptance` and add a `Teaching`
  column to the scorecard header + rows (`boolLabel(item.teachingRetrievalPassed)`), beside
  `Retrieval`.

Run: `npx vitest run tests/scripts/benchmarkAcceptance.test.ts` — expect PASS.

### Step 2.9: Add a committed mock-results fixture

Copy an existing `benchmarks/mock-results/*.json` to a new
`benchmarks/mock-results/2026-06-08-teaching-retrieval.json`, adding to one case:
`expectedTeachingIds: ['t-revenue-grain']`, `observedTeachingIds: ['t-revenue-grain']`,
`teachingRetrievalPassed: true`, `teachingCompliance: 'followed'`, and a populated
`validationHistory`. If an existing test enumerates `mock-results/`, ensure it passes;
otherwise add a focused analyzer test that runs `benchmark-analyze` logic over the fixture
and asserts the teaching column + a clean decision. Keep it template-safe: invented ids
only, no client names.

### Step 2.10: Full gate + commit

Run: `npx vitest run tests/scripts/ tests/agents/grounding.test.ts` + `npm run typecheck`.

```bash
git add src/agents/grounding.ts scripts/benchmark-types.ts scripts/benchmarkSupport.ts \
        scripts/benchmark.ts scripts/benchmarkAcceptance.ts tests/ benchmarks/mock-results/
git commit -m "feat(benchmark): measure teaching retrieval (observed ids + compliance)"
```

---

## Task 3: Complete run provenance (judge model + GCP project)

**Files:**
- Modify: `scripts/benchmarkAcceptance.ts` (two provenance rows)
- Test: `tests/scripts/benchmarkAcceptance.test.ts`

### Step 3.1: Failing test

Assert the provenance table of `formatReferenceCardAcceptanceReport` renders the judge
model and GCP project from metadata:

```ts
expect(report).toContain('| Judge Model | gemini-3.1-flash-lite |');
expect(report).toContain('| GCP Project | my-proj |');
```

(Use a metadata object with `judgeModel: 'gemini-3.1-flash-lite'`, `gcpProjectId: 'my-proj'`.)
Run — expect FAIL.

### Step 3.2: Implement — two `lines.push` after the File Search Store row (`~:151`)

```ts
lines.push(`| Judge Model | ${escapeMarkdown(result.metadata?.judgeModel ?? '(missing)')} |`);
lines.push(`| GCP Project | ${escapeMarkdown(result.metadata?.gcpProjectId ?? '(missing)')} |`);
```

### Step 3.3: Run — expect PASS, then commit

Run: `npx vitest run tests/scripts/benchmarkAcceptance.test.ts` + `npm run typecheck`.

```bash
git add scripts/benchmarkAcceptance.ts tests/scripts/benchmarkAcceptance.test.ts
git commit -m "feat(benchmark): render judge model and GCP project in run provenance"
```

---

## Task 4: Close-out — governance note + final gate

**Files:**
- Modify: `docs/trajectory-governance.md` (Benchmark Hardening implementation note)

### Step 4.1: Record the hardening in governance

Add a dated `As of 2026-06-08:` entry under "Current Implementation Notes" stating: benchmark
records now carry a per-attempt validation trace (which layer failed, when, why; L2 advisory
visible non-blocking), teaching retrieval is measured (observed teaching ids + derived
`teachingCompliance` + `teachingRetrievalPassed`, mirroring references), and run provenance
renders judge model + GCP project — satisfying the "Benchmark Hardening" acceptance criteria.
Cite the design + implementation plan as the evidence source. (Per the Maintenance Protocol,
this is a same-change-set governance update.)

### Step 4.2: Final whole-suite gate

Run: `npm test` then `npm run typecheck`. Both must be green/clean.

### Step 4.3: Commit

```bash
git add docs/trajectory-governance.md
git commit -m "docs(governance): record benchmark hardening (validation trace, teaching, provenance)"
```

### Step 4.4: Final review + finish

Dispatch a final whole-implementation code review, then use
superpowers:finishing-a-development-branch. **Do not push or open a remote PR** — merges
stay local (standing constraint); fast-forward `claude/suspicious-wright-0a0235` into local
`main` only.

---

## Definition of done

- A failing benchmark case's report names the layer, attempt, and error detail; advisory L2
  appears in the trace without blocking.
- A corpus entry with `expectedTeachingIds` yields a non-null `teachingRetrievalPassed`,
  captured `observedTeachingIds`, a meaningful `teachingCompliance`, and a `teaching_miss`
  failure when unmet.
- The provenance table renders judge model + GCP project.
- `npm test` + `npm run typecheck` green; only `benchmarks/mock-results/*` committed (never
  `benchmarks/results/*`); no client identifiers added; governance updated in-set.
