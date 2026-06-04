# ReferenceCard Evidence Acceptance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a deterministic acceptance analyzer that turns benchmark JSON into an explicit accept/revise decision for the Revenue ReferenceCard pilot.

**Architecture:** Add a pure `scripts/benchmarkAcceptance.ts` helper for selecting reference-card cases, evaluating acceptance rules, classifying failures, comparing runs, and formatting markdown. Extend `scripts/benchmark-analyze.ts` to preserve existing judge-score output while also writing a dedicated ReferenceCard acceptance report next to the benchmark JSON.

**Tech Stack:** TypeScript, Vitest, existing benchmark JSON types in `scripts/benchmark-types.ts`, Node `fs` CLI helpers, no live Gemini/BigQuery/Firestore/File Search calls.

---

## File Structure

Create:

- `scripts/benchmarkAcceptance.ts` - pure acceptance evaluation, comparison, and markdown formatting helpers.
- `tests/scripts/benchmarkAcceptance.test.ts` - fixture-driven tests for pass/fail rules, failure classes, L2 advisory behavior, missing metadata, and run comparison.

Modify:

- `scripts/benchmark-analyze.ts` - import acceptance helpers, append acceptance context to `generateSummary`, and write `<run>-referencecard-acceptance.md` from the CLI.
- `tests/scripts/benchmark-analyze.test.ts` - verify summaries include acceptance output even when `judgeResults` is empty.
- `docs/trajectory-governance.md` - only after a real live benchmark run, record the first acceptance decision and evidence source.

Do not modify:

- `scripts/benchmark.ts` - it already records expected/observed reference IDs, SQL-derived observed tables, deterministic pass/fail fields, and validation-layer outcomes.
- Runtime SQL generation or Slack response behavior.
- Reference-card YAML content unless the final live report indicates a content failure.

---

## Task 1: Add ReferenceCard Acceptance Evaluation

**Files:**
- Create: `scripts/benchmarkAcceptance.ts`
- Create: `tests/scripts/benchmarkAcceptance.test.ts`

- [ ] **Step 1: Write the failing acceptance evaluation tests**

Create `tests/scripts/benchmarkAcceptance.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import {
  evaluateReferenceCardAcceptance,
  isReferenceCardAcceptanceCase,
} from '../../scripts/benchmarkAcceptance.js';
import type { BenchmarkMetadata, BenchmarkResult, BenchmarkRun } from '../../scripts/benchmark-types.js';

const metadata: BenchmarkMetadata = {
  runId: 'benchmark_2026-06-04T10-00-00-000Z',
  runStartedAt: '2026-06-04T10:00:00.000Z',
  gitSha: 'abc123',
  gitDirty: false,
  packageVersion: '1.0.0',
  corpusHash: 'corpus-hash',
  dbtManifestHash: null,
  dbtCatalogHash: null,
  geminiModel: 'gemini-3.0-pro',
  judgeModel: 'gemini-3.0-pro',
  fileSearchStoreId: 'fileSearchStores/revenue',
  gcpProjectId: 'analytics-prod',
};

function result(overrides: Partial<BenchmarkResult> = {}): BenchmarkResult {
  return {
    corpusId: 'revenue-ref-001',
    question: 'What was total revenue last month?',
    generatedSql: 'SELECT SUM(total_amount) FROM `analytics.fct_orders` WHERE order_status = "completed"',
    confidence: 'high',
    qualityVerdict: 'pass',
    retryCount: 0,
    validationResults: { l1: true, l2: true, l3: true, l4: true },
    bytesProcessed: 1024,
    supervisorNotes: 'ok',
    teachingCompliance: 'no_relevant_teaching',
    expectedReferenceIds: ['revenue-canonical-definition'],
    observedReferenceIds: ['revenue-canonical-definition'],
    referenceRetrievalPassed: true,
    expectedTables: ['analytics.fct_orders'],
    observedTables: ['analytics.fct_orders'],
    tableSelectionPassed: true,
    expectedSqlContains: ['analytics.fct_orders', 'order_status = "completed"'],
    sqlShapePassed: true,
    expectedClarificationConfidence: undefined,
    clarificationPassed: null,
    latencyMs: {
      clarification: 10,
      generation: 20,
      validation: 0,
      supervisor: 0,
      total: 30,
    },
    groundingCitations: ['reference_card:revenue-canonical-definition'],
    ...overrides,
  };
}

function run(results: BenchmarkResult[], runMetadata: BenchmarkMetadata | undefined = metadata): BenchmarkRun {
  return {
    runDate: '2026-06-04',
    metadata: runMetadata as BenchmarkMetadata,
    corpusSize: results.length,
    results,
    judgeResults: [],
  };
}

describe('isReferenceCardAcceptanceCase', () => {
  it('selects revenue reference cases and cases with expected reference IDs', () => {
    expect(isReferenceCardAcceptanceCase(result({ corpusId: 'revenue-ref-005', expectedReferenceIds: undefined }))).toBe(true);
    expect(isReferenceCardAcceptanceCase(result({ corpusId: 'seed-001', expectedReferenceIds: ['revenue-canonical-definition'] }))).toBe(true);
    expect(isReferenceCardAcceptanceCase(result({ corpusId: 'seed-003', expectedReferenceIds: undefined }))).toBe(false);
  });
});

describe('evaluateReferenceCardAcceptance', () => {
  it('accepts a passing revenue reference-card run', () => {
    const acceptance = evaluateReferenceCardAcceptance(run([
      result(),
      result({
        corpusId: 'revenue-ref-005',
        question: 'revenue',
        generatedSql: null,
        confidence: 'low',
        qualityVerdict: 'exhausted',
        expectedReferenceIds: undefined,
        observedReferenceIds: [],
        referenceRetrievalPassed: null,
        expectedTables: undefined,
        observedTables: [],
        tableSelectionPassed: null,
        expectedSqlContains: undefined,
        sqlShapePassed: null,
        expectedClarificationConfidence: 'low',
        clarificationPassed: true,
        validationResults: { l1: false, l2: false, l3: false, l4: false },
      }),
    ]));

    expect(acceptance.decision).toBe('ACCEPTED');
    expect(acceptance.failures).toEqual([]);
    expect(acceptance.cases).toHaveLength(2);
  });

  it('classifies retrieval misses', () => {
    const acceptance = evaluateReferenceCardAcceptance(run([
      result({ observedReferenceIds: [], referenceRetrievalPassed: false }),
    ]));

    expect(acceptance.decision).toBe('NEEDS_REVISION');
    expect(acceptance.failures).toContainEqual(expect.objectContaining({
      corpusId: 'revenue-ref-001',
      failureClass: 'retrieval_miss',
    }));
  });

  it('classifies SQL-derived table mismatches', () => {
    const acceptance = evaluateReferenceCardAcceptance(run([
      result({ observedTables: ['analytics.fct_revenue'], tableSelectionPassed: false }),
    ]));

    expect(acceptance.failures).toContainEqual(expect.objectContaining({
      corpusId: 'revenue-ref-001',
      failureClass: 'table_mismatch',
    }));
  });

  it('classifies SQL-shape mismatches', () => {
    const acceptance = evaluateReferenceCardAcceptance(run([
      result({ sqlShapePassed: false }),
    ]));

    expect(acceptance.failures).toContainEqual(expect.objectContaining({
      corpusId: 'revenue-ref-001',
      failureClass: 'sql_shape_mismatch',
    }));
  });

  it('keeps advisory L2 failures visible without failing acceptance', () => {
    const acceptance = evaluateReferenceCardAcceptance(run([
      result({ validationResults: { l1: true, l2: false, l3: true, l4: true } }),
    ]));

    expect(acceptance.decision).toBe('ACCEPTED');
    expect(acceptance.cases[0].advisoryL2Passed).toBe(false);
    expect(acceptance.failures).toEqual([]);
  });

  it('classifies blocking validation failures', () => {
    const acceptance = evaluateReferenceCardAcceptance(run([
      result({ validationResults: { l1: true, l2: true, l3: false, l4: true } }),
    ]));

    expect(acceptance.failures).toContainEqual(expect.objectContaining({
      failureClass: 'validation_failure',
      detail: expect.stringContaining('L3'),
    }));
  });

  it('classifies ambiguous intake clarification mismatches without treating skipped SQL as pipeline failure', () => {
    const acceptance = evaluateReferenceCardAcceptance(run([
      result({
        corpusId: 'revenue-ref-005',
        question: 'revenue',
        generatedSql: null,
        confidence: 'high',
        qualityVerdict: 'exhausted',
        expectedReferenceIds: undefined,
        observedReferenceIds: [],
        referenceRetrievalPassed: null,
        expectedTables: undefined,
        observedTables: [],
        tableSelectionPassed: null,
        expectedSqlContains: undefined,
        sqlShapePassed: null,
        expectedClarificationConfidence: 'low',
        clarificationPassed: false,
        validationResults: { l1: false, l2: false, l3: false, l4: false },
      }),
    ]));

    expect(acceptance.failures).toEqual([
      expect.objectContaining({ failureClass: 'clarification_mismatch' }),
    ]);
  });

  it('fails acceptance when required provenance metadata is missing', () => {
    const incompleteMetadata = { ...metadata, gitSha: null, fileSearchStoreId: null };
    const acceptance = evaluateReferenceCardAcceptance(run([result()], incompleteMetadata));

    expect(acceptance.decision).toBe('NEEDS_REVISION');
    expect(acceptance.metadataFailures).toEqual([
      'metadata.gitSha is required',
      'metadata.fileSearchStoreId is required',
    ]);
    expect(acceptance.failures).toContainEqual(expect.objectContaining({
      corpusId: '__metadata__',
      failureClass: 'missing_metadata',
    }));
  });
});
```

- [ ] **Step 2: Run the acceptance tests to verify they fail**

Run:

```bash
npx vitest run tests/scripts/benchmarkAcceptance.test.ts
```

Expected: FAIL with an import error for `../../scripts/benchmarkAcceptance.js`.

- [ ] **Step 3: Add the acceptance helper implementation**

Create `scripts/benchmarkAcceptance.ts`:

```typescript
import type { BenchmarkMetadata, BenchmarkResult, BenchmarkRun } from './benchmark-types.js';

export type ReferenceCardDecision = 'ACCEPTED' | 'NEEDS_REVISION';

export type ReferenceCardFailureClass =
  | 'missing_metadata'
  | 'retrieval_miss'
  | 'table_mismatch'
  | 'sql_shape_mismatch'
  | 'validation_failure'
  | 'clarification_mismatch'
  | 'pipeline_failure';

export interface ReferenceCardAcceptanceFailure {
  corpusId: string;
  failureClass: ReferenceCardFailureClass;
  detail: string;
}

export interface ReferenceCardCaseAcceptance {
  corpusId: string;
  question: string;
  status: 'pass' | 'fail';
  expectedReferenceIds: string[];
  observedReferenceIds: string[];
  referenceRetrievalPassed: boolean | null;
  expectedTables: string[];
  observedTables: string[];
  tableSelectionPassed: boolean | null;
  sqlShapePassed: boolean | null;
  clarificationPassed: boolean | null;
  qualityVerdict: BenchmarkResult['qualityVerdict'];
  validationResults: BenchmarkResult['validationResults'];
  advisoryL2Passed: boolean;
  failures: ReferenceCardAcceptanceFailure[];
}

export interface ReferenceCardAcceptanceComparison {
  newlyFailing: string[];
  newlyPassing: string[];
}

export interface ReferenceCardAcceptanceResult {
  runDate: string;
  decision: ReferenceCardDecision;
  metadata: BenchmarkMetadata | null;
  metadataFailures: string[];
  cases: ReferenceCardCaseAcceptance[];
  failures: ReferenceCardAcceptanceFailure[];
  comparison?: ReferenceCardAcceptanceComparison;
}

export function isReferenceCardAcceptanceCase(result: BenchmarkResult): boolean {
  return result.corpusId.startsWith('revenue-ref-') || (result.expectedReferenceIds?.length ?? 0) > 0;
}

export function evaluateReferenceCardAcceptance(
  run: BenchmarkRun,
  previous?: BenchmarkRun,
): ReferenceCardAcceptanceResult {
  const metadata = run.metadata ?? null;
  const metadataFailures = validateMetadata(metadata);
  const cases = run.results
    .filter(isReferenceCardAcceptanceCase)
    .map(evaluateCase);
  const failures = [
    ...metadataFailures.map(detail => ({
      corpusId: '__metadata__',
      failureClass: 'missing_metadata' as const,
      detail,
    })),
    ...cases.flatMap(item => item.failures),
  ];

  const result: ReferenceCardAcceptanceResult = {
    runDate: run.runDate,
    decision: failures.length === 0 ? 'ACCEPTED' : 'NEEDS_REVISION',
    metadata,
    metadataFailures,
    cases,
    failures,
  };

  if (previous) {
    result.comparison = compareReferenceCardAcceptance(previous, run);
  }

  return result;
}

export function compareReferenceCardAcceptance(
  previous: BenchmarkRun,
  current: BenchmarkRun,
): ReferenceCardAcceptanceComparison {
  const previousCases = new Map(
    evaluateReferenceCardAcceptance(previous).cases.map(item => [item.corpusId, item.status]),
  );
  const currentCases = evaluateReferenceCardAcceptance(current).cases;
  const newlyFailing: string[] = [];
  const newlyPassing: string[] = [];

  for (const item of currentCases) {
    const previousStatus = previousCases.get(item.corpusId);
    if (previousStatus === 'pass' && item.status === 'fail') newlyFailing.push(item.corpusId);
    if (previousStatus === 'fail' && item.status === 'pass') newlyPassing.push(item.corpusId);
  }

  return { newlyFailing, newlyPassing };
}

function evaluateCase(result: BenchmarkResult): ReferenceCardCaseAcceptance {
  const failures: ReferenceCardAcceptanceFailure[] = [];
  const isClarificationOnly = result.expectedClarificationConfidence != null && result.expectedReferenceIds == null;

  if ((result.expectedReferenceIds?.length ?? 0) > 0 && result.referenceRetrievalPassed !== true) {
    failures.push({
      corpusId: result.corpusId,
      failureClass: 'retrieval_miss',
      detail: `Expected references ${formatList(result.expectedReferenceIds ?? [])}; observed ${formatList(result.observedReferenceIds)}`,
    });
  }

  if ((result.expectedTables?.length ?? 0) > 0 && result.tableSelectionPassed !== true) {
    failures.push({
      corpusId: result.corpusId,
      failureClass: 'table_mismatch',
      detail: `Expected tables ${formatList(result.expectedTables ?? [])}; observed ${formatList(result.observedTables)}`,
    });
  }

  if ((result.expectedSqlContains?.length ?? 0) > 0 && result.sqlShapePassed !== true) {
    failures.push({
      corpusId: result.corpusId,
      failureClass: 'sql_shape_mismatch',
      detail: `Generated SQL did not contain all expected fragments: ${formatList(result.expectedSqlContains ?? [])}`,
    });
  }

  if (!isClarificationOnly && (result.qualityVerdict === 'exhausted' || result.qualityVerdict === 'cost_exceeded')) {
    failures.push({
      corpusId: result.corpusId,
      failureClass: 'pipeline_failure',
      detail: `Quality loop ended with verdict ${result.qualityVerdict}`,
    });
  }

  const blockingValidationFailures = blockingValidationFailuresFor(result.validationResults);
  if (!isClarificationOnly && blockingValidationFailures.length > 0) {
    failures.push({
      corpusId: result.corpusId,
      failureClass: 'validation_failure',
      detail: `Final SQL failed ${blockingValidationFailures.join(', ')}`,
    });
  }

  if (result.expectedClarificationConfidence && result.clarificationPassed !== true) {
    failures.push({
      corpusId: result.corpusId,
      failureClass: 'clarification_mismatch',
      detail: `Expected clarification confidence ${result.expectedClarificationConfidence}`,
    });
  }

  return {
    corpusId: result.corpusId,
    question: result.question,
    status: failures.length === 0 ? 'pass' : 'fail',
    expectedReferenceIds: result.expectedReferenceIds ?? [],
    observedReferenceIds: result.observedReferenceIds,
    referenceRetrievalPassed: result.referenceRetrievalPassed,
    expectedTables: result.expectedTables ?? [],
    observedTables: result.observedTables,
    tableSelectionPassed: result.tableSelectionPassed,
    sqlShapePassed: result.sqlShapePassed,
    clarificationPassed: result.clarificationPassed,
    qualityVerdict: result.qualityVerdict,
    validationResults: result.validationResults,
    advisoryL2Passed: result.validationResults.l2,
    failures,
  };
}

function validateMetadata(metadata: BenchmarkMetadata | null): string[] {
  if (!metadata) return ['metadata is required'];
  const failures: string[] = [];
  if (!metadata.runId) failures.push('metadata.runId is required');
  if (!metadata.runStartedAt) failures.push('metadata.runStartedAt is required');
  if (!metadata.gitSha) failures.push('metadata.gitSha is required');
  if (typeof metadata.gitDirty !== 'boolean') failures.push('metadata.gitDirty is required');
  if (!metadata.corpusHash) failures.push('metadata.corpusHash is required');
  if (!metadata.geminiModel) failures.push('metadata.geminiModel is required');
  if (!metadata.fileSearchStoreId) failures.push('metadata.fileSearchStoreId is required');
  return failures;
}

function blockingValidationFailuresFor(validation: BenchmarkResult['validationResults']): string[] {
  const failures: string[] = [];
  if (!validation.l1) failures.push('L1');
  if (!validation.l3) failures.push('L3');
  if (!validation.l4) failures.push('L4');
  return failures;
}

function formatList(values: string[]): string {
  return values.length > 0 ? values.join(', ') : '(none)';
}
```

- [ ] **Step 4: Run the acceptance tests to verify they pass**

Run:

```bash
npx vitest run tests/scripts/benchmarkAcceptance.test.ts
```

Expected: PASS with all `benchmarkAcceptance` tests green.

- [ ] **Step 5: Commit Task 1**

```bash
git add scripts/benchmarkAcceptance.ts tests/scripts/benchmarkAcceptance.test.ts
git commit -m "feat: add reference card acceptance evaluation"
```

---

## Task 2: Add Markdown Report Formatting

**Files:**
- Modify: `scripts/benchmarkAcceptance.ts`
- Modify: `tests/scripts/benchmarkAcceptance.test.ts`

- [ ] **Step 1: Add failing report-format tests**

Update the existing `../../scripts/benchmarkAcceptance.js` import in `tests/scripts/benchmarkAcceptance.test.ts` to include `formatReferenceCardAcceptanceReport`:

```typescript
import {
  evaluateReferenceCardAcceptance,
  formatReferenceCardAcceptanceReport,
  isReferenceCardAcceptanceCase,
} from '../../scripts/benchmarkAcceptance.js';
```

Add this `describe` block after the evaluation tests:

```typescript
describe('formatReferenceCardAcceptanceReport', () => {
  it('formats an accepted report with provenance and scorecard rows', () => {
    const acceptance = evaluateReferenceCardAcceptance(run([result()]));
    const report = formatReferenceCardAcceptanceReport(acceptance);

    expect(report).toContain('# ReferenceCard Acceptance - 2026-06-04');
    expect(report).toContain('**Decision:** `ACCEPTED`');
    expect(report).toContain('| Git SHA | abc123 |');
    expect(report).toContain('| revenue-ref-001 | pass | true | true | true | true | pass |');
    expect(report).toContain('Expand to one next high-confusion domain.');
  });

  it('formats failure rows when acceptance needs revision', () => {
    const acceptance = evaluateReferenceCardAcceptance(run([
      result({ observedReferenceIds: [], referenceRetrievalPassed: false }),
    ]));
    const report = formatReferenceCardAcceptanceReport(acceptance);

    expect(report).toContain('**Decision:** `NEEDS_REVISION`');
    expect(report).toContain('| revenue-ref-001 | retrieval_miss | Expected references revenue-canonical-definition; observed (none) |');
    expect(report).toContain('Tighten the failing layer before expanding domain scope.');
  });
});
```

- [ ] **Step 2: Run report tests to verify they fail**

Run:

```bash
npx vitest run tests/scripts/benchmarkAcceptance.test.ts
```

Expected: FAIL because `formatReferenceCardAcceptanceReport` is not exported.

- [ ] **Step 3: Implement markdown formatting**

Append this function to `scripts/benchmarkAcceptance.ts`:

```typescript
export function formatReferenceCardAcceptanceReport(result: ReferenceCardAcceptanceResult): string {
  const lines: string[] = [];
  lines.push(`# ReferenceCard Acceptance - ${result.runDate}`);
  lines.push('');
  lines.push(`**Decision:** \`${result.decision}\``);
  lines.push('');
  lines.push('## Run Provenance');
  lines.push('');
  lines.push('| Field | Value |');
  lines.push('|-------|-------|');
  lines.push(`| Run ID | ${escapeMarkdown(result.metadata?.runId ?? '(missing)')} |`);
  lines.push(`| Started | ${escapeMarkdown(result.metadata?.runStartedAt ?? '(missing)')} |`);
  lines.push(`| Git SHA | ${escapeMarkdown(result.metadata?.gitSha ?? '(missing)')} |`);
  lines.push(`| Dirty | ${String(result.metadata?.gitDirty ?? '(missing)')} |`);
  lines.push(`| Corpus Hash | ${escapeMarkdown(result.metadata?.corpusHash ?? '(missing)')} |`);
  lines.push(`| dbt Manifest Hash | ${escapeMarkdown(result.metadata?.dbtManifestHash ?? '(not available)')} |`);
  lines.push(`| dbt Catalog Hash | ${escapeMarkdown(result.metadata?.dbtCatalogHash ?? '(not available)')} |`);
  lines.push(`| Gemini Model | ${escapeMarkdown(result.metadata?.geminiModel ?? '(missing)')} |`);
  lines.push(`| File Search Store | ${escapeMarkdown(result.metadata?.fileSearchStoreId ?? '(missing)')} |`);
  lines.push('');

  lines.push('## Revenue Scorecard');
  lines.push('');
  lines.push('| Corpus ID | Status | Retrieval | Tables | SQL Shape | L1/L3/L4 | L2 |');
  lines.push('|-----------|--------|-----------|--------|-----------|----------|----|');
  for (const item of result.cases) {
    lines.push([
      item.corpusId,
      item.status,
      boolLabel(item.referenceRetrievalPassed),
      boolLabel(item.tableSelectionPassed),
      boolLabel(item.sqlShapePassed),
      blockingValidationLabel(item.validationResults),
      item.advisoryL2Passed ? 'pass' : 'advisory_fail',
    ].join(' | ').replace(/^/, '| ').replace(/$/, ' |'));
  }
  lines.push('');

  lines.push('## Failures');
  lines.push('');
  if (result.failures.length === 0) {
    lines.push('No acceptance failures.');
  } else {
    lines.push('| Corpus ID | Class | Detail |');
    lines.push('|-----------|-------|--------|');
    for (const failure of result.failures) {
      lines.push(`| ${failure.corpusId} | ${failure.failureClass} | ${escapeMarkdown(failure.detail)} |`);
    }
  }
  lines.push('');

  if (result.comparison) {
    lines.push('## Comparison');
    lines.push('');
    lines.push(`Newly failing: ${formatList(result.comparison.newlyFailing)}`);
    lines.push('');
    lines.push(`Newly passing: ${formatList(result.comparison.newlyPassing)}`);
    lines.push('');
  }

  lines.push('## Suggested Next Action');
  lines.push('');
  lines.push(
    result.decision === 'ACCEPTED'
      ? 'Expand to one next high-confusion domain.'
      : 'Tighten the failing layer before expanding domain scope.',
  );

  return lines.join('\n');
}

function boolLabel(value: boolean | null): string {
  if (value === true) return 'true';
  if (value === false) return 'false';
  return 'n/a';
}

function blockingValidationLabel(validation: BenchmarkResult['validationResults']): string {
  return validation.l1 && validation.l3 && validation.l4 ? 'true' : 'false';
}

function escapeMarkdown(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}
```

- [ ] **Step 4: Run report tests to verify they pass**

Run:

```bash
npx vitest run tests/scripts/benchmarkAcceptance.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit Task 2**

```bash
git add scripts/benchmarkAcceptance.ts tests/scripts/benchmarkAcceptance.test.ts
git commit -m "feat: format reference card acceptance report"
```

---

## Task 3: Add Run Comparison Coverage

**Files:**
- Modify: `tests/scripts/benchmarkAcceptance.test.ts`

- [ ] **Step 1: Add failing comparison tests**

Append this test to the `evaluateReferenceCardAcceptance` describe block in `tests/scripts/benchmarkAcceptance.test.ts`:

```typescript
  it('compares previous and current acceptance case status', () => {
    const previous = run([
      result({ corpusId: 'revenue-ref-001' }),
      result({
        corpusId: 'revenue-ref-002',
        observedTables: ['analytics.fct_revenue'],
        tableSelectionPassed: false,
      }),
    ]);
    const current = run([
      result({
        corpusId: 'revenue-ref-001',
        observedReferenceIds: [],
        referenceRetrievalPassed: false,
      }),
      result({ corpusId: 'revenue-ref-002' }),
    ]);

    const acceptance = evaluateReferenceCardAcceptance(current, previous);

    expect(acceptance.comparison).toEqual({
      newlyFailing: ['revenue-ref-001'],
      newlyPassing: ['revenue-ref-002'],
    });
  });
```

- [ ] **Step 2: Run comparison test**

Run:

```bash
npx vitest run tests/scripts/benchmarkAcceptance.test.ts -t "compares previous and current"
```

Expected: PASS if Task 1 implemented `compareReferenceCardAcceptance` exactly as specified. If it fails, update `compareReferenceCardAcceptance` to compare case status by `corpusId` and return sorted arrays in current-run order.

- [ ] **Step 3: Commit Task 3**

```bash
git add scripts/benchmarkAcceptance.ts tests/scripts/benchmarkAcceptance.test.ts
git commit -m "test: cover reference card acceptance comparisons"
```

---

## Task 4: Integrate Acceptance Output Into Benchmark Analyzer

**Files:**
- Modify: `scripts/benchmark-analyze.ts`
- Modify: `tests/scripts/benchmark-analyze.test.ts`

- [ ] **Step 1: Write failing analyzer integration tests**

Replace `tests/scripts/benchmark-analyze.test.ts` with:

```typescript
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  detectRegressions,
  generateSummary,
  writeBenchmarkAnalysisOutputs,
} from '../../scripts/benchmark-analyze.js';
import type { BenchmarkMetadata, BenchmarkResult, BenchmarkRun, JudgeResult } from '../../scripts/benchmark-types.js';

const makeJudge = (id: string, correctness: number): JudgeResult => ({
  corpusId: id,
  scores: { correctness, efficiency: 3, readability: 3, teachingCompliance: 3, safety: 3 },
  overallScore: correctness,
  rationale: 'test',
  flaggedForReview: false,
});

const metadata: BenchmarkMetadata = {
  runId: 'benchmark_2026-06-04T10-00-00-000Z',
  runStartedAt: '2026-06-04T10:00:00.000Z',
  gitSha: 'abc123',
  gitDirty: false,
  packageVersion: '1.0.0',
  corpusHash: 'corpus-hash',
  dbtManifestHash: null,
  dbtCatalogHash: null,
  geminiModel: 'gemini-3.0-pro',
  judgeModel: 'gemini-3.0-pro',
  fileSearchStoreId: 'fileSearchStores/revenue',
  gcpProjectId: 'analytics-prod',
};

function result(overrides: Partial<BenchmarkResult> = {}): BenchmarkResult {
  return {
    corpusId: 'revenue-ref-001',
    question: 'What was total revenue last month?',
    generatedSql: 'SELECT 1 FROM `analytics.fct_orders`',
    confidence: 'high',
    qualityVerdict: 'pass',
    retryCount: 0,
    validationResults: { l1: true, l2: true, l3: true, l4: true },
    bytesProcessed: 1000,
    supervisorNotes: 'ok',
    teachingCompliance: 'no_relevant_teaching',
    expectedReferenceIds: ['revenue-canonical-definition'],
    observedReferenceIds: ['revenue-canonical-definition'],
    referenceRetrievalPassed: true,
    expectedTables: ['analytics.fct_orders'],
    observedTables: ['analytics.fct_orders'],
    tableSelectionPassed: true,
    expectedSqlContains: ['analytics.fct_orders'],
    sqlShapePassed: true,
    expectedClarificationConfidence: undefined,
    clarificationPassed: null,
    latencyMs: { clarification: 1, generation: 1, validation: 0, supervisor: 0, total: 2 },
    groundingCitations: ['reference_card:revenue-canonical-definition'],
    ...overrides,
  };
}

function run(overrides: Partial<BenchmarkRun> = {}): BenchmarkRun {
  return {
    runDate: '2026-06-04',
    metadata,
    corpusSize: 1,
    results: [result()],
    judgeResults: [],
    ...overrides,
  };
}

describe('detectRegressions', () => {
  it('detects regression when correctness drops by 2+', () => {
    const previous = [makeJudge('q1', 5), makeJudge('q2', 4)];
    const current = [makeJudge('q1', 2), makeJudge('q2', 4)];
    const regressions = detectRegressions(previous, current);
    expect(regressions).toHaveLength(1);
    expect(regressions[0].corpusId).toBe('q1');
  });

  it('returns empty when no regressions', () => {
    const previous = [makeJudge('q1', 3)];
    const current = [makeJudge('q1', 4)];
    expect(detectRegressions(previous, current)).toHaveLength(0);
  });
});

describe('generateSummary', () => {
  it('includes reference-card acceptance output even without judge results', () => {
    const summary = generateSummary(run());

    expect(summary).toContain('# Benchmark Summary - 2026-06-04');
    expect(summary).toContain('No judge results available yet.');
    expect(summary).toContain('## ReferenceCard Acceptance');
    expect(summary).toContain('**Decision:** `ACCEPTED`');
  });
});

describe('writeBenchmarkAnalysisOutputs', () => {
  it('writes both benchmark summary and reference-card acceptance markdown files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'annalytics-benchmark-analysis-'));
    const currentPath = join(dir, '2026-06-04.json');
    await import('node:fs/promises').then(fs =>
      fs.writeFile(currentPath, JSON.stringify(run(), null, 2), 'utf-8'),
    );

    const outputs = writeBenchmarkAnalysisOutputs(currentPath);

    expect(outputs.summaryPath).toBe(join(dir, '2026-06-04-summary.md'));
    expect(outputs.acceptancePath).toBe(join(dir, '2026-06-04-referencecard-acceptance.md'));
    await expect(readFile(outputs.summaryPath, 'utf-8')).resolves.toContain('ReferenceCard Acceptance');
    await expect(readFile(outputs.acceptancePath, 'utf-8')).resolves.toContain('**Decision:** `ACCEPTED`');
  });
});
```

- [ ] **Step 2: Run analyzer tests to verify they fail**

Run:

```bash
npx vitest run tests/scripts/benchmark-analyze.test.ts
```

Expected: FAIL because `writeBenchmarkAnalysisOutputs` is not exported and `generateSummary` does not include acceptance output.

- [ ] **Step 3: Modify `scripts/benchmark-analyze.ts`**

Update imports at the top:

```typescript
import { readFileSync, writeFileSync } from 'node:fs';
import type { JudgeResult, BenchmarkRun } from './benchmark-types.js';
import {
  evaluateReferenceCardAcceptance,
  formatReferenceCardAcceptanceReport,
} from './benchmarkAcceptance.js';
```

Replace `generateSummary` with this implementation:

```typescript
export function generateSummary(
  current: BenchmarkRun,
  previous?: BenchmarkRun,
): string {
  const judges = current.judgeResults ?? [];
  const lines: string[] = [];

  lines.push(`# Benchmark Summary - ${current.runDate}`);
  lines.push('');

  if (judges.length === 0) {
    lines.push('No judge results available yet.');
    lines.push('');
  } else {
    const overallScores = judges.map(j => j.overallScore).sort((a, b) => a - b);
    const avg = mean(overallScores);
    const med = percentile(overallScores, 50);
    const p25 = percentile(overallScores, 25);
    const p75 = percentile(overallScores, 75);
    const failureCount = current.results.filter(
      r => r.qualityVerdict === 'exhausted' || r.qualityVerdict === 'cost_exceeded',
    ).length;
    const flagged = judges.filter(j => j.flaggedForReview);
    const regressions = previous?.judgeResults
      ? detectRegressions(previous.judgeResults, judges)
      : [];

    lines.push('## Score Distribution');
    lines.push('');
    lines.push('| Metric | Value |');
    lines.push('|--------|-------|');
    lines.push(`| Mean   | ${avg.toFixed(2)} |`);
    lines.push(`| Median | ${med.toFixed(2)} |`);
    lines.push(`| P25    | ${p25.toFixed(2)} |`);
    lines.push(`| P75    | ${p75.toFixed(2)} |`);
    lines.push(`| N      | ${judges.length} |`);
    lines.push('');
    lines.push('## Pipeline Failures');
    lines.push('');
    lines.push(`**${failureCount}** queries ended in \`exhausted\` or \`cost_exceeded\`.`);
    lines.push('');

    if (regressions.length > 0) {
      lines.push('## Regressions');
      lines.push('');
      lines.push('| Corpus ID | Criterion | Previous | Current | Delta |');
      lines.push('|-----------|-----------|----------|---------|-------|');
      for (const r of regressions) {
        lines.push(
          `| ${r.corpusId} | ${r.criterion} | ${r.previousScore} | ${r.currentScore} | -${r.delta} |`,
        );
      }
      lines.push('');
    } else if (previous) {
      lines.push('## Regressions');
      lines.push('');
      lines.push('No regressions detected.');
      lines.push('');
    }

    if (flagged.length > 0) {
      lines.push('## Flagged for Review');
      lines.push('');
      for (const j of flagged) {
        lines.push(`- **${j.corpusId}** (overall: ${j.overallScore}) - ${j.rationale}`);
      }
      lines.push('');
    }
  }

  const acceptance = evaluateReferenceCardAcceptance(current, previous);
  lines.push('## ReferenceCard Acceptance');
  lines.push('');
  lines.push(`**Decision:** \`${acceptance.decision}\``);
  lines.push('');
  lines.push(`Cases evaluated: ${acceptance.cases.length}`);
  lines.push('');
  if (acceptance.failures.length > 0) {
    lines.push('| Corpus ID | Class | Detail |');
    lines.push('|-----------|-------|--------|');
    for (const failure of acceptance.failures) {
      lines.push(`| ${failure.corpusId} | ${failure.failureClass} | ${failure.detail.replace(/\|/g, '\\|')} |`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
```

Add this exported helper above the CLI entry point:

```typescript
export interface BenchmarkAnalysisOutputs {
  summaryPath: string;
  acceptancePath: string;
}

export function writeBenchmarkAnalysisOutputs(
  currentPath: string,
  previousPath?: string,
): BenchmarkAnalysisOutputs {
  const current: BenchmarkRun = JSON.parse(readFileSync(currentPath, 'utf-8'));
  const previous: BenchmarkRun | undefined = previousPath
    ? JSON.parse(readFileSync(previousPath, 'utf-8'))
    : undefined;
  const summary = generateSummary(current, previous);
  const acceptance = evaluateReferenceCardAcceptance(current, previous);
  const acceptanceReport = formatReferenceCardAcceptanceReport(acceptance);
  const summaryPath = currentPath.replace('.json', '-summary.md');
  const acceptancePath = currentPath.replace('.json', '-referencecard-acceptance.md');

  writeFileSync(summaryPath, summary, 'utf-8');
  writeFileSync(acceptancePath, acceptanceReport, 'utf-8');

  return { summaryPath, acceptancePath };
}
```

Replace the CLI body after argument parsing with:

```typescript
  const outputs = writeBenchmarkAnalysisOutputs(currentPath, previousPath);
  console.log(`Summary written to ${outputs.summaryPath}`);
  console.log(`ReferenceCard acceptance written to ${outputs.acceptancePath}`);
```

- [ ] **Step 4: Run analyzer tests to verify they pass**

Run:

```bash
npx vitest run tests/scripts/benchmark-analyze.test.ts tests/scripts/benchmarkAcceptance.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit Task 4**

```bash
git add scripts/benchmark-analyze.ts tests/scripts/benchmark-analyze.test.ts
git commit -m "feat: write reference card acceptance reports"
```

---

## Task 5: Add Fixture Coverage for Malformed Inputs and Empty Judge Results

**Files:**
- Modify: `tests/scripts/benchmarkAcceptance.test.ts`
- Modify: `tests/scripts/benchmark-analyze.test.ts`

- [ ] **Step 1: Add missing metadata and empty judge result assertions**

Add this test to `tests/scripts/benchmarkAcceptance.test.ts`:

```typescript
  it('allows empty judge results because acceptance is deterministic', () => {
    const benchmarkRun = run([result()]);
    benchmarkRun.judgeResults = [];

    const acceptance = evaluateReferenceCardAcceptance(benchmarkRun);

    expect(acceptance.decision).toBe('ACCEPTED');
  });
```

Add this test to `tests/scripts/benchmark-analyze.test.ts`:

```typescript
  it('throws on malformed benchmark JSON', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'annalytics-benchmark-analysis-'));
    const currentPath = join(dir, 'broken.json');
    await import('node:fs/promises').then(fs =>
      fs.writeFile(currentPath, '{not valid json', 'utf-8'),
    );

    expect(() => writeBenchmarkAnalysisOutputs(currentPath)).toThrow(SyntaxError);
  });
```

- [ ] **Step 2: Run fixture tests**

Run:

```bash
npx vitest run tests/scripts/benchmarkAcceptance.test.ts tests/scripts/benchmark-analyze.test.ts
```

Expected: PASS.

- [ ] **Step 3: Commit Task 5**

```bash
git add tests/scripts/benchmarkAcceptance.test.ts tests/scripts/benchmark-analyze.test.ts
git commit -m "test: cover reference card acceptance edge cases"
```

---

## Task 6: Final Verification and Handoff

**Files:**
- Review: `scripts/benchmarkAcceptance.ts`
- Review: `scripts/benchmark-analyze.ts`
- Review: `docs/superpowers/specs/2026-06-04-referencecard-evidence-acceptance-design.md`

- [ ] **Step 1: Run focused tests**

Run:

```bash
npx vitest run tests/scripts/benchmarkAcceptance.test.ts tests/scripts/benchmark-analyze.test.ts tests/scripts/benchmarkSupport.test.ts tests/scripts/benchmark.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run repository verification**

Run:

```bash
npm run typecheck
npm test
npx tsx scripts/validate-knowledge.ts
git diff --check
```

Expected:

- `npm run typecheck`: exit 0.
- `npm test`: all Vitest files pass.
- `npx tsx scripts/validate-knowledge.ts`: prints `Knowledge validation passed`.
- `git diff --check`: exit 0 with no output.

- [ ] **Step 3: Run the analyzer on an existing benchmark JSON when available**

If `benchmarks/results/<run>.json` exists, run:

```bash
npx tsx scripts/benchmark-analyze.ts benchmarks/results/<run>.json
```

Expected:

- `benchmarks/results/<run>-summary.md` is written.
- `benchmarks/results/<run>-referencecard-acceptance.md` is written.

If there is no benchmark result JSON yet, do not fabricate one in `benchmarks/results/`. Report that live benchmark execution is the next operational step.

- [ ] **Step 4: Record governance only after a real benchmark run**

If a real benchmark result was analyzed, update `docs/trajectory-governance.md` under `Current Implementation Notes` with a dated bullet:

```markdown
- On 2026-06-04, ReferenceCard Evidence Acceptance analyzed `<benchmark-result-path>` and returned `<ACCEPTED-or-NEEDS_REVISION>` for the revenue pilot; next scope is `<expand-one-domain-or-repair-failing-layer>`.
```

If no real benchmark result was available, leave governance unchanged and state that the acceptance decision is pending a live benchmark run.

- [ ] **Step 5: Commit final governance update if applicable**

If Step 4 changed governance:

```bash
git add docs/trajectory-governance.md
git commit -m "docs: record reference card acceptance decision"
```

If Step 4 did not change governance, do not create an empty commit.
