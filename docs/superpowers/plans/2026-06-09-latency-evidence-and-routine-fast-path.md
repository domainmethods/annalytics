# Latency Evidence And Routine Fast Path Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce a fresh local latency evidence slice and add a disabled-by-default routine fast path that can skip supervisor only for well-grounded, low-risk analytics queries.

**Architecture:** Keep measurement and runtime behavior separate. Use existing node-sweep smoke tooling for local evidence, add explicit config flags, isolate fast-path validation and supervisor gating in `src/routineFastPath.ts`, and wire `pipeline.ts` so all ineligible or risky cases fall back to the existing `qualityLoop`.

**Tech Stack:** TypeScript, Vitest, Google GenAI via existing agents, BigQuery dry-run validation, Firestore `ResponseContext`, Slack pipeline orchestration.

---

## File Structure

- Modify `src/config.ts`: parse fast-path rollout flags.
- Modify `.env.example`: document the local clarification override and fast-path flags.
- Modify `src/types.ts`: add optional response-context observability fields.
- Create `src/routineFastPath.ts`: own eligibility, one-shot generation/validation, supervisor gating, and fallback result shape.
- Create `tests/routineFastPath.test.ts`: unit tests for the new fast-path module.
- Modify `src/pipeline.ts`: call the fast path only when enabled; keep `qualityLoop` as fallback.
- Modify `tests/pipeline.test.ts`: mock the fast-path module and verify path selection and persistence.
- Modify `scripts/benchmark-types.ts`: add optional fast-path fields to benchmark records.
- Modify `scripts/benchmark.ts`: populate full-loop defaults for those fields until the benchmark harness intentionally runs the fast path.
- Modify `scripts/benchmarkAcceptance.ts`: render the fast-path fields defensively in the acceptance report.
- Modify `tests/scripts/benchmarkAcceptance.test.ts`: prove old and new benchmark JSON still render.
- Optional local-only output: `/tmp/annalytics-latency-*.log`, never committed.

## Task 1: Run The Latency Evidence Slice

**Files:**
- Read: `/home/souther/eval-corpora/annalytics/corpus.live.json`
- Read: `.env`
- No repository files modified.

- [ ] **Step 1: Verify local corpus and env visibility**

Run:

```bash
test -r /home/souther/eval-corpora/annalytics/corpus.live.json
npx tsx -e "process.loadEnvFile('.env'); const required=['GEMINI_API_KEY','GCP_PROJECT_ID']; const missing=required.filter(k=>!process.env[k]); if (missing.length) { console.error('missing '+missing.join(',')); process.exit(1); } console.log('env ok; corpus external');"
```

Expected:

```text
env ok; corpus external
```

- [ ] **Step 2: Run the default-profile smoke**

Run:

```bash
npx tsx scripts/node-sweep-smoke.ts \
  --env .env \
  --corpus /home/souther/eval-corpora/annalytics/corpus.live.json \
  --passes 2 \
  | tee /tmp/annalytics-latency-default-$(date +%Y%m%dT%H%M%S).log
```

Expected:

```text
Corpus:
Passes: 2
Per-node epsilon
Cost / latency
```

Record, in the task handoff or implementation notes, the actual values printed for `clarification` p95, `sqlGenerator` p95, `supervisor` p95, and `Wall-clock/pass`. Also record each `Pass N/M ... done in Xs` line and compute a smoke P50/P95 from the pass-duration list. With two passes, call this a smoke proxy: the lower pass duration is the median proxy and the higher pass duration is the P95 proxy.

- [ ] **Step 3: Run the clarification-override smoke**

Run:

```bash
NODE_PROFILE_OVERRIDES='{"clarification":{"tier":"flash-lite","version":"3.1","thinkingLevel":"minimal"}}' \
npx tsx scripts/node-sweep-smoke.ts \
  --env .env \
  --corpus /home/souther/eval-corpora/annalytics/corpus.live.json \
  --passes 2 \
  | tee /tmp/annalytics-latency-clarification-override-$(date +%Y%m%dT%H%M%S).log
```

Expected:

```text
Corpus:
Passes: 2
Per-node epsilon
Cost / latency
```

Record whether clarification p95 improves, whether the LOW clarification rate changes materially, and the smoke P50/P95 pass-duration proxy from the `Pass N/M ... done in Xs` lines. Do not copy corpus rows or secret values into any tracked file.

- [ ] **Step 4: Decide whether to run SQL-path bypass smoke**

Run this only if Step 2/3 wall-clock cost is acceptable:

```bash
npx tsx scripts/node-sweep-smoke.ts \
  --env .env \
  --corpus /home/souther/eval-corpora/annalytics/corpus.live.json \
  --passes 2 \
  --bypass-clarification \
  | tee /tmp/annalytics-latency-bypass-$(date +%Y%m%dT%H%M%S).log
```

Expected:

```text
Clarification gate BYPASSED
sqlGenerator
supervisor
```

Stop after this step if the smoke run reports large epsilon for `sqlGenerator` or `supervisor`. That means the full model sweep is still not evidence-worthy.

- [ ] **Step 5: Confirm no evidence files are staged**

Run:

```bash
git status --short
git check-ignore benchmarks/results/node-sweep-test.md benchmarks/corpus.live.json
```

Expected:

```text
benchmarks/results/node-sweep-test.md
benchmarks/corpus.live.json
```

There is no commit for this task unless a tracked docs note is explicitly requested later.

## Task 2: Add Fast-Path Configuration

**Files:**
- Modify: `src/config.ts`
- Modify: `.env.example`
- Test: `tests/config.test.ts`

- [ ] **Step 1: Write failing config tests**

Append to `tests/config.test.ts`:

```ts
describe('loadConfig fastPath', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    baseEnv();
  });

  it('defaults the routine fast path off with a 1GB fast-path limit and forced supervisor review', () => {
    const config = loadConfig();
    expect(config.fastPath).toEqual({
      enabled: false,
      maxBytesProcessed: 1_073_741_824,
      requireSupervisor: true,
    });
  });

  it('parses routine fast-path flags from env', () => {
    vi.stubEnv('FAST_PATH_ENABLED', 'true');
    vi.stubEnv('FAST_PATH_MAX_BYTES', '524288000');
    vi.stubEnv('FAST_PATH_REQUIRE_SUPERVISOR', 'false');

    const config = loadConfig();

    expect(config.fastPath).toEqual({
      enabled: true,
      maxBytesProcessed: 524_288_000,
      requireSupervisor: false,
    });
  });

  it('throws on invalid routine fast-path booleans', () => {
    vi.stubEnv('FAST_PATH_ENABLED', 'yes');
    expect(() => loadConfig()).toThrow(/FAST_PATH_ENABLED must be "true" or "false"/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npx vitest run tests/config.test.ts
```

Expected: fail with a TypeScript/runtime error because `fastPath` does not exist on `AppConfig`.

- [ ] **Step 3: Implement config parsing**

In `src/config.ts`, add this property to `AppConfig`:

```ts
  fastPath: {
    enabled: boolean;
    maxBytesProcessed: number;
    requireSupervisor: boolean;
  };
```

In `loadConfig()`, add this object before `port`:

```ts
    fastPath: {
      enabled: parseEnvBool('FAST_PATH_ENABLED', false),
      maxBytesProcessed: parseEnvInt('FAST_PATH_MAX_BYTES', 1_073_741_824),
      requireSupervisor: parseEnvBool('FAST_PATH_REQUIRE_SUPERVISOR', true),
    },
```

- [ ] **Step 4: Document flags in `.env.example`**

Add after the app limits section:

```bash
# Routine fast path (disabled by default). This path keeps deterministic SQL
# validation and can skip supervisor only for well-grounded low-risk queries.
FAST_PATH_ENABLED=false
FAST_PATH_MAX_BYTES=1073741824
# true = pilot mode: eligible fast-path candidates still run supervisor.
# false = skip supervisor when no risk triggers fire.
FAST_PATH_REQUIRE_SUPERVISOR=true
```

- [ ] **Step 5: Run config tests**

Run:

```bash
npx vitest run tests/config.test.ts
```

Expected: all tests in `tests/config.test.ts` pass.

- [ ] **Step 6: Commit config changes**

Run:

```bash
git add src/config.ts tests/config.test.ts .env.example
git commit -m "feat: add routine fast path config"
```

## Task 3: Add Routine Fast-Path Unit

**Files:**
- Create: `src/routineFastPath.ts`
- Create: `tests/routineFastPath.test.ts`
- Modify: `src/types.ts`

- [ ] **Step 1: Write failing fast-path tests**

Create `tests/routineFastPath.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runRoutineFastPath } from '../src/routineFastPath.js';
import type { SqlGenerationResult, ThreadMessage } from '../src/types.js';
import type { TableContext } from '../src/dbt/types.js';
import type { KnowledgeSummary } from '../src/teachings/types.js';

vi.mock('../src/agents/sqlGenerator.js', () => ({ generateSql: vi.fn() }));
vi.mock('../src/agents/supervisorAgent.js', () => ({ reviewSql: vi.fn() }));
vi.mock('../src/validation/staticAnalysis.js', () => ({ staticAnalysis: vi.fn() }));
vi.mock('../src/validation/astValidation.js', () => ({ astValidation: vi.fn() }));
vi.mock('../src/validation/dryRun.js', () => ({ dryRunValidation: vi.fn() }));
vi.mock('../src/validation/costGate.js', () => ({ costGate: vi.fn() }));

import { generateSql } from '../src/agents/sqlGenerator.js';
import { reviewSql } from '../src/agents/supervisorAgent.js';
import { staticAnalysis } from '../src/validation/staticAnalysis.js';
import { astValidation } from '../src/validation/astValidation.js';
import { dryRunValidation } from '../src/validation/dryRun.js';
import { costGate } from '../src/validation/costGate.js';

const tables: TableContext[] = [{
  name: 'analytics.fct_orders',
  description: 'Orders fact table',
  columns: [],
  sampleDDL: 'CREATE TABLE analytics.fct_orders (total_amount NUMERIC)',
}];

const knowledgeSummaries: KnowledgeSummary[] = [{
  kind: 'reference_card',
  id: 'revenue-monthly-grain',
  term: 'Revenue',
  definition: 'Canonical revenue',
  canonical_table: 'analytics.fct_orders',
  canonical_metric: 'total_amount',
  aliases: ['revenue'],
  routing_triggers: ['total revenue'],
}];

const sqlResult: SqlGenerationResult = {
  sql: 'SELECT SUM(total_amount) AS revenue FROM `analytics.fct_orders`',
  explanation: 'Sums revenue.',
  headline: 'total revenue',
  tablesUsed: ['analytics.fct_orders'],
  confidence: 'high',
  assumptions: [],
  reasoningChain: 'Used the revenue reference card.',
  groundingCitations: [{
    sourceFile: 'reference_card:revenue-monthly-grain',
    chunkText: 'ReferenceCard: revenue-monthly-grain',
    relevanceScore: 1,
  }],
};

function baseInput(overrides: Partial<Parameters<typeof runRoutineFastPath>[0]> = {}) {
  return {
    enabled: true,
    requireSupervisor: false,
    question: 'total revenue?',
    clarifiedQuestion: 'total revenue?',
    clarificationConfidence: 'high' as const,
    route: 'data_query' as const,
    tables,
    threadContext: [] as ThreadMessage[],
    apiKey: 'key',
    fileSearchStoreId: 'stores/test',
    knowledgeSummaries,
    maxBytesProcessed: 10_737_418_240,
    fastPathMaxBytes: 1_073_741_824,
    sampleRows: undefined,
    negativeExample: undefined,
    previousAttempt: undefined,
    bqml_hint: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(generateSql).mockResolvedValue(sqlResult);
  vi.mocked(staticAnalysis).mockReturnValue({ valid: true, layer: 'L1-static' });
  vi.mocked(astValidation).mockReturnValue({ valid: true, layer: 'L2-ast' });
  vi.mocked(dryRunValidation).mockResolvedValue({ valid: true, layer: 'L3-dryrun', bytesProcessed: 1000 });
  vi.mocked(costGate).mockReturnValue({ valid: true, layer: 'L4-cost', bytesProcessed: 1000 });
  vi.mocked(reviewSql).mockResolvedValue({
    verdict: 'PASS',
    confidence: 'high',
    issues: [],
    suggestions: [],
    teaching_compliance: 'compliant',
  });
});

describe('runRoutineFastPath', () => {
  it('returns ineligible without generating SQL when disabled', async () => {
    const result = await runRoutineFastPath(baseInput({ enabled: false }));
    expect(result.kind).toBe('ineligible');
    expect(result.ineligibleReasons).toContain('fast_path_disabled');
    expect(generateSql).not.toHaveBeenCalled();
  });

  it('completes without supervisor for a grounded low-risk query', async () => {
    const result = await runRoutineFastPath(baseInput());
    expect(result.kind).toBe('complete');
    if (result.kind !== 'complete') throw new Error('expected complete');
    expect(result.supervisorDecision).toBe('skipped');
    expect(result.quality.verdict).toBe('pass');
    expect(result.quality.supervisorNotes).toBe('Routine fast path: supervisor skipped');
    expect(reviewSql).not.toHaveBeenCalled();
  });

  it('requires full-loop fallback when generated SQL has no grounding citation', async () => {
    vi.mocked(generateSql).mockResolvedValue({ ...sqlResult, groundingCitations: [] });
    const result = await runRoutineFastPath(baseInput());
    expect(result.kind).toBe('fallback');
    expect(result.reasons).toContain('missing_grounding_citation');
  });

  it('falls back when generated tables are outside the retrieved schema', async () => {
    vi.mocked(generateSql).mockResolvedValue({
      ...sqlResult,
      sql: 'SELECT SUM(total_amount) FROM `analytics.rogue_orders`',
      tablesUsed: ['analytics.rogue_orders'],
    });
    const result = await runRoutineFastPath(baseInput());
    expect(result.kind).toBe('fallback');
    expect(result.kind === 'fallback' ? result.reasons : []).toContain('table_outside_retrieved_schema');
  });

  it('runs supervisor in pilot mode and completes on PASS', async () => {
    const result = await runRoutineFastPath(baseInput({ requireSupervisor: true }));
    expect(result.kind).toBe('complete');
    if (result.kind !== 'complete') throw new Error('expected complete');
    expect(result.supervisorDecision).toBe('required');
    expect(result.supervisorTriggers).toContain('pilot_requires_supervisor');
    expect(reviewSql).toHaveBeenCalledTimes(1);
  });

  it('falls back when required supervisor fails', async () => {
    vi.mocked(reviewSql).mockResolvedValue({
      verdict: 'FAIL',
      confidence: 'low',
      issues: ['Missing date filter'],
      suggestions: ['Add WHERE clause'],
      teaching_compliance: 'deviated',
    });
    const result = await runRoutineFastPath(baseInput({ requireSupervisor: true }));
    expect(result.kind).toBe('fallback');
    if (result.kind !== 'fallback') throw new Error('expected fallback');
    expect(result.previousAttempt?.error).toContain('Supervisor review failed');
  });

  it('falls back with previousAttempt when dry run fails', async () => {
    vi.mocked(dryRunValidation).mockResolvedValue({ valid: false, layer: 'L3-dryrun', error: 'Dry run failed: Table not found' });
    const result = await runRoutineFastPath(baseInput());
    expect(result.kind).toBe('fallback');
    if (result.kind !== 'fallback') throw new Error('expected fallback');
    expect(result.previousAttempt).toEqual({
      sql: sqlResult.sql,
      error: 'Dry run failed: Table not found',
    });
  });

  it('requires supervisor when bytes exceed the fast-path threshold but stay under the global cost gate', async () => {
    vi.mocked(dryRunValidation).mockResolvedValue({ valid: true, layer: 'L3-dryrun', bytesProcessed: 2_000_000_000 });
    vi.mocked(costGate).mockReturnValue({ valid: true, layer: 'L4-cost', bytesProcessed: 2_000_000_000 });
    const result = await runRoutineFastPath(baseInput());
    expect(result.kind).toBe('complete');
    if (result.kind !== 'complete') throw new Error('expected complete');
    expect(result.supervisorTriggers).toContain('fast_path_bytes_exceeded');
    expect(reviewSql).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npx vitest run tests/routineFastPath.test.ts
```

Expected: fail because `src/routineFastPath.ts` does not exist.

- [ ] **Step 3: Add response-context observability types**

In `src/types.ts`, add these optional fields to `ResponseContext` after `supervisorNotes`:

```ts
  pipelineMode?: 'full_quality_loop' | 'routine_fast_path';
  supervisorDecision?: 'skipped' | 'required';
  supervisorTriggers?: string[];
  fastPathIneligibleReasons?: string[];
```

This maps the design's `mode` field to `pipelineMode`; `eligible` is derived from `pipelineMode === 'routine_fast_path'` and an empty `fastPathIneligibleReasons` list. Do not add `nodeUsage` to `ResponseContext`: the design marks it benchmark-only telemetry, and the smoke/benchmark tooling remains the place to report per-node model usage.

- [ ] **Step 4: Implement `src/routineFastPath.ts`**

Create `src/routineFastPath.ts` with these exported types and functions:

Runtime cannot know the corpus's `expectedReferenceIds`; keep that check in benchmark reporting. The runtime equivalent is fail-closed grounding: fall back when generated SQL lacks a `reference_card:*` citation, cites an unknown reference card, drifts from the cited card's canonical table, or references a table outside the retrieved schema.

```ts
import type { ClarificationResult, SupervisorVerdict } from './agents/types.js';
import type { GenerateSqlOptions } from './agents/sqlGenerator.js';
import { generateSql } from './agents/sqlGenerator.js';
import { reviewSql } from './agents/supervisorAgent.js';
import { extractReferenceIdsFromCitations } from './agents/grounding.js';
import type { TableContext } from './dbt/types.js';
import type { KnowledgeSummary } from './teachings/types.js';
import type { ThreadMessage } from './types.js';
import type { FailureRecord, QualityResult, ValidationLayerRecord } from './qualityLoop.js';
import { staticAnalysis } from './validation/staticAnalysis.js';
import { astValidation } from './validation/astValidation.js';
import { dryRunValidation } from './validation/dryRun.js';
import { costGate } from './validation/costGate.js';

export type SupervisorDecision = 'skipped' | 'required';

export type RoutineFastPathResult =
  | { kind: 'ineligible'; ineligibleReasons: string[] }
  | {
      kind: 'fallback';
      reasons: string[];
      previousAttempt?: { sql: string; error: string };
      failureHistory: FailureRecord[];
      validationHistory: ValidationLayerRecord[];
      sqlResult?: QualityResult['sqlResult'];
      bytesProcessed?: number;
    }
  | {
      kind: 'complete';
      quality: QualityResult;
      supervisorDecision: SupervisorDecision;
      supervisorTriggers: string[];
      ineligibleReasons: string[];
    };

export interface RoutineFastPathInput {
  enabled: boolean;
  requireSupervisor: boolean;
  question: string;
  clarifiedQuestion: string;
  clarificationConfidence: ClarificationResult['confidence'];
  route: ClarificationResult['route'];
  tables: TableContext[];
  threadContext: ThreadMessage[];
  apiKey: string;
  fileSearchStoreId?: string;
  knowledgeSummaries: KnowledgeSummary[];
  maxBytesProcessed: number;
  fastPathMaxBytes: number;
  sampleRows?: GenerateSqlOptions['sampleRows'];
  negativeExample?: GenerateSqlOptions['negativeExample'];
  previousAttempt?: GenerateSqlOptions['previousAttempt'];
  bqml_hint?: GenerateSqlOptions['bqml_hint'];
}

export async function runRoutineFastPath(input: RoutineFastPathInput): Promise<RoutineFastPathResult> {
  const initialReasons = initialIneligibleReasons(input);
  if (initialReasons.length > 0) return { kind: 'ineligible', ineligibleReasons: initialReasons };

  const sqlResult = await generateSql({
    question: input.clarifiedQuestion,
    tables: input.tables,
    threadContext: input.threadContext,
    apiKey: input.apiKey,
    fileSearchStoreId: input.fileSearchStoreId,
    sampleRows: input.sampleRows,
    bqml_hint: input.bqml_hint,
  });

  const validationHistory: ValidationLayerRecord[] = [];
  const failureHistory: FailureRecord[] = [];
  const fallback = (reason: string, error: string): RoutineFastPathResult => ({
    kind: 'fallback',
    reasons: [reason],
    previousAttempt: { sql: sqlResult.sql, error },
    failureHistory,
    validationHistory,
    sqlResult,
  });

  const l1 = staticAnalysis(sqlResult.sql);
  validationHistory.push(toLayerRecord('l1', l1));
  if (!l1.valid) {
    failureHistory.push({ attempt: 0, failureType: 'structural', detail: l1.error || 'L1 static analysis blocked' });
    return fallback('l1_failed', l1.error || 'L1 static analysis blocked');
  }

  const l2 = astValidation(sqlResult.sql);
  validationHistory.push(toLayerRecord('l2', l2));

  const l3 = await dryRunValidation(sqlResult.sql);
  validationHistory.push(toLayerRecord('l3', l3));
  if (!l3.valid) {
    failureHistory.push({ attempt: 0, failureType: 'dry_run', detail: l3.error || 'Dry-run validation failed' });
    return fallback('l3_failed', l3.error || 'Dry-run validation failed');
  }

  const bytesProcessed = l3.bytesProcessed ?? 0;
  const l4 = costGate(bytesProcessed, input.maxBytesProcessed);
  validationHistory.push(toLayerRecord('l4', l4));
  if (!l4.valid) {
    return {
      kind: 'complete',
      quality: qualityFrom(sqlResult, 'cost_exceeded', 'Global cost gate exceeded', 'low', validationHistory, failureHistory, bytesProcessed),
      supervisorDecision: 'required',
      supervisorTriggers: ['global_cost_gate_exceeded'],
      ineligibleReasons: [],
    };
  }

  const tableReasons = tableIneligibleReasons(sqlResult, input.tables);
  if (tableReasons.length > 0) {
    return { kind: 'fallback', reasons: tableReasons, failureHistory, validationHistory, sqlResult, bytesProcessed };
  }

  const groundingReasons = groundingIneligibleReasons(sqlResult, input.knowledgeSummaries);
  if (groundingReasons.length > 0) {
    return { kind: 'fallback', reasons: groundingReasons, failureHistory, validationHistory, sqlResult, bytesProcessed };
  }

  const supervisorTriggers = supervisorTriggersFor(sqlResult, input, bytesProcessed);
  if (input.requireSupervisor && !supervisorTriggers.includes('pilot_requires_supervisor')) {
    supervisorTriggers.push('pilot_requires_supervisor');
  }

  if (supervisorTriggers.length > 0) {
    const verdict = await reviewSql({
      userQuestion: input.question,
      clarifiedQuestion: input.clarifiedQuestion,
      generatedSql: sqlResult.sql,
      explanation: sqlResult.explanation,
      reasoningChain: sqlResult.reasoningChain,
      groundingCitations: sqlResult.groundingCitations,
      apiKey: input.apiKey,
      dryRunMetadata: { bytesProcessed },
    });

    if (verdict.verdict === 'FAIL') {
      const error = supervisorError(verdict);
      failureHistory.push({ attempt: 0, failureType: 'semantic', detail: verdict.issues.join('; ') });
      return {
        kind: 'fallback',
        reasons: ['supervisor_failed'],
        previousAttempt: { sql: sqlResult.sql, error },
        failureHistory,
        validationHistory,
        sqlResult,
        bytesProcessed,
      };
    }

    return {
      kind: 'complete',
      quality: qualityFrom(sqlResult, 'pass', verdict.issues.join('; ') || 'Approved', verdict.confidence, validationHistory, failureHistory, bytesProcessed),
      supervisorDecision: 'required',
      supervisorTriggers,
      ineligibleReasons: [],
    };
  }

  return {
    kind: 'complete',
    quality: qualityFrom(sqlResult, 'pass', 'Routine fast path: supervisor skipped', sqlResult.confidence, validationHistory, failureHistory, bytesProcessed),
    supervisorDecision: 'skipped',
    supervisorTriggers: [],
    ineligibleReasons: [],
  };
}

function initialIneligibleReasons(input: RoutineFastPathInput): string[] {
  const reasons: string[] = [];
  if (!input.enabled) reasons.push('fast_path_disabled');
  if (input.route !== 'data_query') reasons.push('not_data_query');
  if (input.clarificationConfidence === 'low') reasons.push('low_clarification_confidence');
  if (input.negativeExample) reasons.push('negative_feedback_recovery');
  if (input.previousAttempt) reasons.push('refinement_or_retry');
  if (!input.fileSearchStoreId) reasons.push('missing_file_search_store');
  return reasons;
}

function tableIneligibleReasons(sqlResult: QualityResult['sqlResult'], tables: TableContext[]): string[] {
  const allowed = new Set(normalizeTables(tables.map(table => table.name)));
  const reported = normalizeTables(sqlResult.tablesUsed);
  if (reported.length === 0) return ['missing_tables_used'];
  return reported.every(table => allowed.has(table)) ? [] : ['table_outside_retrieved_schema'];
}

function groundingIneligibleReasons(sqlResult: QualityResult['sqlResult'], summaries: KnowledgeSummary[]): string[] {
  if (sqlResult.groundingCitations.length === 0) return ['missing_grounding_citation'];
  const referenceIds = extractReferenceIdsFromCitations(sqlResult.groundingCitations);
  if (referenceIds.length === 0) return [];
  const byId = new Map(summaries.filter(s => s.id).map(s => [s.id!, s]));
  const observedTables = new Set(normalizeTables(sqlResult.tablesUsed));
  const mismatched = referenceIds.some(id => {
    const summary = byId.get(id);
    return summary?.kind === 'reference_card'
      && !!summary.canonical_table
      && !observedTables.has(normalizeTable(summary.canonical_table));
  });
  return mismatched ? ['reference_canonical_table_mismatch'] : [];
}

function supervisorTriggersFor(sqlResult: QualityResult['sqlResult'], input: RoutineFastPathInput, bytesProcessed: number): string[] {
  const triggers: string[] = [];
  if (sqlResult.confidence === 'low') triggers.push('low_sql_confidence');
  if (bytesProcessed > input.fastPathMaxBytes) triggers.push('fast_path_bytes_exceeded');
  if (usesComplexSql(sqlResult.sql, sqlResult.tablesUsed)) triggers.push('complex_sql_shape');
  if (input.bqml_hint) triggers.push('bqml_hint');
  return triggers;
}

function usesComplexSql(sql: string, tablesUsed: string[]): boolean {
  const lower = sql.toLowerCase();
  if (/\bml\./i.test(sql)) return true;
  if (/\bover\s*\(/i.test(sql)) return true;
  if (/\bwith\b/i.test(sql)) return true;
  if (/\(\s*select\b/i.test(lower)) return true;
  const factTables = tablesUsed.filter(table => /\bfct_/i.test(table));
  return factTables.length > 1 || (lower.match(/\bjoin\b/g) ?? []).length > 1;
}

function qualityFrom(
  sqlResult: QualityResult['sqlResult'],
  verdict: QualityResult['verdict'],
  supervisorNotes: string,
  finalConfidence: QualityResult['finalConfidence'],
  validationHistory: ValidationLayerRecord[],
  failureHistory: FailureRecord[],
  bytesProcessed?: number,
): QualityResult {
  return {
    sqlResult,
    verdict,
    supervisorNotes,
    finalConfidence,
    retryCount: 0,
    failureHistory,
    validationHistory,
    bytesProcessed,
  };
}

function toLayerRecord(layer: ValidationLayerRecord['layer'], result: { valid: boolean; error?: string; bytesProcessed?: number }): ValidationLayerRecord {
  return { attempt: 0, layer, valid: result.valid, detail: result.error, bytesProcessed: result.bytesProcessed };
}

function supervisorError(verdict: SupervisorVerdict): string {
  return [
    'Supervisor review failed:',
    ...verdict.issues.map(issue => `- ${issue}`),
    'Suggestions:',
    ...verdict.suggestions.map(suggestion => `- ${suggestion}`),
  ].join('\n');
}

function normalizeTables(tables: string[]): string[] {
  return tables.map(normalizeTable);
}

function normalizeTable(table: string): string {
  return table.toLowerCase().replace(/`/g, '').trim();
}
```

- [ ] **Step 5: Run fast-path tests**

Run:

```bash
npx vitest run tests/routineFastPath.test.ts
```

Expected: pass.

- [ ] **Step 6: Commit fast-path module**

Run:

```bash
git add src/routineFastPath.ts tests/routineFastPath.test.ts src/types.ts
git commit -m "feat: add routine fast path evaluator"
```

## Task 4: Wire The Fast Path Into The Pipeline

**Files:**
- Modify: `src/pipeline.ts`
- Modify: `tests/pipeline.test.ts`

- [ ] **Step 1: Write failing pipeline tests**

In `tests/pipeline.test.ts`, add a module mock near the other mocks:

```ts
vi.mock('../src/routineFastPath.js');
```

Add imports and mocks:

```ts
import { runRoutineFastPath } from '../src/routineFastPath.js';

const mockRunRoutineFastPath = vi.mocked(runRoutineFastPath);
```

In `setupHappyPath()`, add:

```ts
  mockRunRoutineFastPath.mockResolvedValue({
    kind: 'ineligible',
    ineligibleReasons: ['fast_path_disabled'],
  });
```

Add tests inside `describe('runPipeline')`:

```ts
  it('does not call routine fast path when disabled', async () => {
    await runPipeline(baseInput);

    expect(mockRunRoutineFastPath).not.toHaveBeenCalled();
    expect(mockQualityLoop).toHaveBeenCalledTimes(1);
  });

  it('uses routine fast path when enabled and complete', async () => {
    mockRunRoutineFastPath.mockResolvedValue({
      kind: 'complete',
      quality: baseQualityResult,
      supervisorDecision: 'skipped',
      supervisorTriggers: [],
      ineligibleReasons: [],
    });

    await runPipeline({
      ...baseInput,
      config: {
        ...baseInput.config,
        fastPath: {
          enabled: true,
          maxBytesProcessed: 1_073_741_824,
          requireSupervisor: false,
        },
      },
    });

    expect(mockRunRoutineFastPath).toHaveBeenCalledTimes(1);
    expect(mockQualityLoop).not.toHaveBeenCalled();
    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect(mockSaveCtx).toHaveBeenCalledWith(expect.objectContaining({
      pipelineMode: 'routine_fast_path',
      supervisorDecision: 'skipped',
      supervisorTriggers: [],
    }));
  });

  it('falls back to qualityLoop when routine fast path requests fallback', async () => {
    mockRunRoutineFastPath.mockResolvedValue({
      kind: 'fallback',
      reasons: ['missing_grounding_citation'],
      previousAttempt: {
        sql: 'SELECT bad FROM `analytics.fct_orders`',
        error: 'missing grounding',
      },
      failureHistory: [],
      validationHistory: [],
      sqlResult: baseQualityResult.sqlResult,
      bytesProcessed: 100,
    });

    await runPipeline({
      ...baseInput,
      config: {
        ...baseInput.config,
        fastPath: {
          enabled: true,
          maxBytesProcessed: 1_073_741_824,
          requireSupervisor: false,
        },
      },
    });

    expect(mockQualityLoop).toHaveBeenCalledTimes(1);
    expect(mockQualityLoop.mock.calls[0][0].previousAttempt).toEqual({
      sql: 'SELECT bad FROM `analytics.fct_orders`',
      error: 'missing grounding',
    });
    expect(mockSaveCtx).toHaveBeenCalledWith(expect.objectContaining({
      pipelineMode: 'full_quality_loop',
      fastPathIneligibleReasons: ['missing_grounding_citation'],
    }));
  });
```

- [ ] **Step 2: Run test to verify failure**

Run:

```bash
npx vitest run tests/pipeline.test.ts
```

Expected: fail because `PipelineConfig.fastPath` and pipeline fast-path wiring do not exist.

- [ ] **Step 3: Update pipeline config conversion**

In `src/pipeline.ts`, add `fastPath` to `PipelineConfig`:

```ts
  fastPath?: {
    enabled: boolean;
    maxBytesProcessed: number;
    requireSupervisor: boolean;
  };
```

In `toPipelineConfig()`, add:

```ts
    fastPath: config.fastPath,
```

- [ ] **Step 4: Import the fast path**

In `src/pipeline.ts`, add:

```ts
import { runRoutineFastPath } from './routineFastPath.js';
```

- [ ] **Step 5: Replace the direct `qualityLoop` call with fast-path selection**

In `runPipeline`, after `negativeExample` is loaded, introduce these variables before calling `qualityLoop`:

```ts
    let pipelineMode: 'full_quality_loop' | 'routine_fast_path' = 'full_quality_loop';
    let supervisorDecision: 'skipped' | 'required' | undefined;
    let supervisorTriggers: string[] = [];
    let fastPathIneligibleReasons: string[] = [];
    let fastPathPreviousAttempt: { sql: string; error: string } | undefined;
    let fastPathResultKind: 'complete' | 'fallback' | 'ineligible' | 'not_attempted' = 'not_attempted';
    let fastPathValidationOutcome: { layer: string; valid: boolean; detail?: string; bytesProcessed?: number } | undefined;
    let fastPathBytesProcessed: number | undefined;
    let fastPathElapsedMs: number | undefined;
```

Then wrap the existing `qualityLoop` call like this:

```ts
    let qualityResult;
    if (config.fastPath?.enabled) {
      const fastPathStartedAt = Date.now();
      const fastPath = await runRoutineFastPath({
        enabled: config.fastPath.enabled,
        requireSupervisor: config.fastPath.requireSupervisor,
        question,
        clarifiedQuestion: resolvedQuestion,
        clarificationConfidence: clarification.confidence,
        route: clarification.route,
        tables: pipelineTables,
        threadContext,
        apiKey: config.geminiApiKey,
        fileSearchStoreId: config.fileSearchStoreId,
        knowledgeSummaries: teachingSummaries,
        maxBytesProcessed: config.maxBytesProcessed,
        fastPathMaxBytes: config.fastPath.maxBytesProcessed,
        sampleRows: sampleRowsMap.size > 0 ? sampleRowsMap : undefined,
        negativeExample: negativeExample ? {
          sql: negativeExample.sql,
          explanation: negativeExample.explanation,
          userFeedback: threadContext[threadContext.length - 1]?.content || '',
        } : undefined,
        previousAttempt: input.refinementHint
          ? { sql: input.refinementHint.previousSql, error: '', refinement: resolvedQuestion }
          : undefined,
        bqml_hint: clarification.bqml_hint,
      });
      fastPathElapsedMs = Date.now() - fastPathStartedAt;
      fastPathResultKind = fastPath.kind;

      if (fastPath.kind === 'complete') {
        qualityResult = fastPath.quality;
        pipelineMode = 'routine_fast_path';
        supervisorDecision = fastPath.supervisorDecision;
        supervisorTriggers = fastPath.supervisorTriggers;
        fastPathIneligibleReasons = fastPath.ineligibleReasons;
        const lastValidationLayer = fastPath.quality.validationHistory?.slice(-1)[0];
        fastPathValidationOutcome = lastValidationLayer
          ? {
              layer: lastValidationLayer.layer,
              valid: lastValidationLayer.valid,
              detail: lastValidationLayer.detail,
              bytesProcessed: lastValidationLayer.bytesProcessed,
            }
          : undefined;
        fastPathBytesProcessed = fastPath.quality.bytesProcessed;
      } else {
        fastPathIneligibleReasons = fastPath.kind === 'ineligible'
          ? fastPath.ineligibleReasons
          : fastPath.reasons;
        fastPathPreviousAttempt = fastPath.kind === 'fallback' ? fastPath.previousAttempt : undefined;
        fastPathBytesProcessed = fastPath.kind === 'fallback' ? fastPath.bytesProcessed : undefined;
      }

      logger.info({
        traceId,
        selectedPath: pipelineMode,
        fastPathResult: fastPathResultKind,
        eligible: pipelineMode === 'routine_fast_path',
        ineligibleReasons: fastPathIneligibleReasons,
        supervisorDecision,
        supervisorTriggers,
        validationOutcome: fastPathValidationOutcome,
        bytesProcessed: fastPathBytesProcessed,
        durationMs: fastPathElapsedMs,
      }, 'pipeline.fast_path_decision');
    }

    if (!qualityResult) {
      qualityResult = await qualityLoop(
        {
          question: resolvedQuestion,
          tables: pipelineTables,
          threadContext,
          apiKey: config.geminiApiKey,
          fileSearchStoreId: config.fileSearchStoreId,
          sampleRows: sampleRowsMap.size > 0 ? sampleRowsMap : undefined,
          negativeExample: negativeExample ? {
            sql: negativeExample.sql,
            explanation: negativeExample.explanation,
            userFeedback: threadContext[threadContext.length - 1]?.content || '',
          } : undefined,
          previousAttempt: fastPathPreviousAttempt
            ?? (input.refinementHint
              ? { sql: input.refinementHint.previousSql, error: '', refinement: resolvedQuestion }
              : undefined),
          bqml_hint: clarification.bqml_hint,
        },
        config.geminiApiKey,
        resolvedQuestion,
        config.maxBytesProcessed,
        {
          onGenerate: () => updateStatus('Researching the best approach...'),
          onValidate: () => updateStatus('Verifying the approach...'),
          onReview: () => updateStatus('Reviewing for accuracy...'),
          onRetry: () => updateStatus('Refining the approach...'),
        },
      );
    }
```

Keep the existing status callbacks in the fallback `qualityLoop`. If the fast path completes, its own `runRoutineFastPath` has already generated and validated SQL; the later execution/format/persist stages stay shared.

- [ ] **Step 6: Persist fast-path observability**

In the normal `saveResponseContext` call, add:

```ts
      pipelineMode,
      supervisorDecision,
      supervisorTriggers,
      fastPathIneligibleReasons,
```

In the dbt-status `saveResponseContext`, add:

```ts
        pipelineMode: 'full_quality_loop',
        supervisorDecision: 'required',
        supervisorTriggers: ['dbt_status_route'],
        fastPathIneligibleReasons: ['not_data_query'],
```

- [ ] **Step 7: Run pipeline tests**

Run:

```bash
npx vitest run tests/pipeline.test.ts
```

Expected: pass.

- [ ] **Step 8: Commit pipeline wiring**

Run:

```bash
git add src/pipeline.ts tests/pipeline.test.ts
git commit -m "feat: route routine queries through fast path"
```

## Task 5: Add Benchmark Observability Fields

**Files:**
- Modify: `scripts/benchmark-types.ts`
- Modify: `scripts/benchmark.ts`
- Modify: `scripts/benchmarkAcceptance.ts`
- Modify: `tests/scripts/benchmarkAcceptance.test.ts`

- [ ] **Step 1: Add failing acceptance report test**

In `tests/scripts/benchmarkAcceptance.test.ts`, add:

```ts
  it('renders fast-path observability when present', () => {
    const acceptance = evaluateReferenceCardAcceptance(run([
      result({
        pipelineMode: 'routine_fast_path',
        supervisorDecision: 'skipped',
        supervisorTriggers: [],
        fastPathIneligibleReasons: [],
      }),
    ]));

    const report = formatReferenceCardAcceptanceReport(acceptance);

    expect(report).toContain('| routine_fast_path | 1 | skipped |');
    expect(report).toContain('Ineligible reasons: none');
  });
```

- [ ] **Step 2: Run test to verify failure**

Run:

```bash
npx vitest run tests/scripts/benchmarkAcceptance.test.ts
```

Expected: fail because `BenchmarkResult` and the report do not include fast-path fields.

- [ ] **Step 3: Add benchmark result fields**

In `scripts/benchmark-types.ts`, add to `BenchmarkResult` after `qualityVerdict`:

```ts
  pipelineMode?: 'full_quality_loop' | 'routine_fast_path';
  supervisorDecision?: 'skipped' | 'required';
  supervisorTriggers?: string[];
  fastPathIneligibleReasons?: string[];
```

- [ ] **Step 4: Populate full-loop defaults in `scripts/benchmark.ts`**

In every `BenchmarkResult` object literal in `scripts/benchmark.ts`, add:

```ts
          pipelineMode: 'full_quality_loop',
          supervisorDecision: 'required',
          supervisorTriggers: ['benchmark_quality_loop'],
          fastPathIneligibleReasons: ['benchmark_quality_loop'],
```

Use the same four fields for LOW-clarification skipped results and error results so the JSON shape is consistent.

- [ ] **Step 5: Render fields defensively in acceptance report**

In `scripts/benchmarkAcceptance.ts`, after the Run Provenance table and before Calibration, add:

```ts
  const fastPathRows = result.cases
    .map(item => ({
      mode: item.pipelineMode ?? 'full_quality_loop',
      decision: item.supervisorDecision ?? 'required',
      reasons: item.fastPathIneligibleReasons ?? [],
    }));
  const modeSummary = summarizeFastPath(fastPathRows);
  const reasonSummary = summarizeReasonCounts(fastPathRows.flatMap(row => row.reasons));
  lines.push('## Fast Path');
  lines.push('');
  lines.push('| Mode | Count | Supervisor Decision |');
  lines.push('|------|-------|---------------------|');
  for (const row of modeSummary) {
    lines.push(`| ${row.mode} | ${row.count} | ${row.supervisorDecision} |`);
  }
  lines.push('');
  lines.push(`Ineligible reasons: ${formatReasonSummary(reasonSummary)}`);
  lines.push('');
```

Add fields to `ReferenceCardCaseAcceptance`:

```ts
  pipelineMode?: BenchmarkResult['pipelineMode'];
  supervisorDecision?: BenchmarkResult['supervisorDecision'];
  supervisorTriggers?: string[];
  fastPathIneligibleReasons?: string[];
```

Set them in `evaluateCase` from the source `BenchmarkResult`.

Add helper:

```ts
function summarizeFastPath(rows: Array<{ mode: string; decision: string; reasons: string[] }>): Array<{ mode: string; count: number; supervisorDecision: string }> {
  const counts = new Map<string, { mode: string; count: number; supervisorDecision: string }>();
  for (const row of rows) {
    const key = `${row.mode}:${row.decision}`;
    const existing = counts.get(key) ?? { mode: row.mode, count: 0, supervisorDecision: row.decision };
    existing.count++;
    counts.set(key, existing);
  }
  return [...counts.values()].sort((a, b) => a.mode.localeCompare(b.mode) || a.supervisorDecision.localeCompare(b.supervisorDecision));
}

function summarizeReasonCounts(reasons: string[]): Array<{ reason: string; count: number }> {
  const counts = new Map<string, number>();
  for (const reason of reasons) counts.set(reason, (counts.get(reason) ?? 0) + 1);
  return [...counts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
}

function formatReasonSummary(rows: Array<{ reason: string; count: number }>): string {
  if (rows.length === 0) return 'none';
  return rows.map(row => `${row.reason} (${row.count})`).join(', ');
}
```

- [ ] **Step 6: Run benchmark tests**

Run:

```bash
npx vitest run tests/scripts/benchmarkAcceptance.test.ts tests/scripts/benchmark-analyze.test.ts
```

Expected: pass.

- [ ] **Step 7: Commit benchmark observability**

Run:

```bash
git add scripts/benchmark-types.ts scripts/benchmark.ts scripts/benchmarkAcceptance.ts tests/scripts/benchmarkAcceptance.test.ts
git commit -m "feat: report fast path benchmark metadata"
```

## Task 6: Full Verification

**Files:**
- All modified files.

- [ ] **Step 1: Run focused tests**

Run:

```bash
npx vitest run tests/config.test.ts tests/routineFastPath.test.ts tests/pipeline.test.ts tests/scripts/benchmarkAcceptance.test.ts tests/scripts/benchmark-analyze.test.ts
```

Expected: all listed tests pass.

- [ ] **Step 2: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected:

```text
tsc --noEmit
```

Exit code 0.

- [ ] **Step 3: Run full test suite**

Run:

```bash
npm test
```

Expected: Vitest exits 0 with all tests passing.

- [ ] **Step 4: Confirm no local evidence artifacts are tracked**

Run:

```bash
git status --short
git check-ignore benchmarks/results/node-sweep-test.md benchmarks/corpus.live.json
```

Expected:

```text
benchmarks/results/node-sweep-test.md
benchmarks/corpus.live.json
```

No `/tmp/annalytics-latency-*.log` file should be staged.

- [ ] **Step 5: Review governance impact**

If the implementation enables the fast path by default or changes the active product trajectory, update `docs/trajectory-governance.md` in the same change set. If the flag remains default-off and no client evidence is committed, no governance update is required.

- [ ] **Step 6: Final commit if verification changed docs or cleanup**

Run only if Step 5 modified a tracked file:

```bash
git add docs/trajectory-governance.md
git commit -m "docs: record fast path rollout boundary"
```

## Execution Notes

- Do not commit `/home/souther/eval-corpora/annalytics/corpus.live.json`.
- Do not commit `benchmarks/results/*`.
- Do not print `.env` values or Secret Manager values.
- Keep `FAST_PATH_ENABLED=false` in `.env.example`.
- Use `NODE_PROFILE_OVERRIDES` for the clarification downsize in deployment config only after Task 1 shows acceptable local evidence.
