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
  schema: 'analytics',
  description: 'Orders fact table',
  materialization: 'table',
  columns: [],
  sampleDDL: 'CREATE TABLE analytics.fct_orders (total_amount NUMERIC)',
  dependsOn: [],
  tags: ['finance'],
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

  it('fails closed before SQL generation when no knowledge summary is available', async () => {
    const result = await runRoutineFastPath(baseInput({ knowledgeSummaries: [] }));
    expect(result.kind).toBe('ineligible');
    expect(result.ineligibleReasons).toContain('missing_knowledge_summary');
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

  it('records l1, l2, l3, l4 in validationHistory for a completed query (attempt 0)', async () => {
    const result = await runRoutineFastPath(baseInput());

    expect(result.kind).toBe('complete');
    if (result.kind !== 'complete') return;
    const layers = result.quality.validationHistory.map(r => r.layer);
    expect(layers).toEqual(['l1', 'l2', 'l3', 'l4']);
    expect(result.quality.validationHistory.every(r => r.attempt === 0)).toBe(true);
    expect(result.quality.validationHistory.find(r => r.layer === 'l3')?.bytesProcessed)
      .toBeTypeOf('number');
  });

  it('falls back with previousAttempt when generated SQL has no grounding citation', async () => {
    vi.mocked(generateSql).mockResolvedValue({ ...sqlResult, groundingCitations: [] });
    const result = await runRoutineFastPath(baseInput());
    expect(result.kind).toBe('fallback');
    if (result.kind !== 'fallback') throw new Error('expected fallback');
    expect(result.reasons).toContain('missing_grounding_citation');
    expect(result.previousAttempt).toEqual({
      sql: sqlResult.sql,
      error: 'Missing recognized ReferenceCard or teaching grounding citation',
    });
  });

  it('falls back when generated tables are outside the retrieved schema', async () => {
    vi.mocked(generateSql).mockResolvedValue({
      ...sqlResult,
      sql: 'SELECT SUM(total_amount) FROM `analytics.rogue_orders`',
      tablesUsed: ['analytics.rogue_orders'],
    });
    const result = await runRoutineFastPath(baseInput());
    expect(result.kind).toBe('fallback');
    if (result.kind !== 'fallback') throw new Error('expected fallback');
    expect(result.reasons).toContain('table_outside_retrieved_schema');
    expect(result.previousAttempt).toEqual({
      sql: 'SELECT SUM(total_amount) FROM `analytics.rogue_orders`',
      error: 'Generated SQL referenced a table outside the retrieved schema',
    });
  });

  it('falls back when SQL references an unreported table outside the retrieved schema', async () => {
    vi.mocked(generateSql).mockResolvedValue({
      ...sqlResult,
      sql: 'SELECT COUNT(*) FROM `analytics.rogue_orders`',
      tablesUsed: ['analytics.fct_orders'],
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

  it('requires supervisor for complex SQL shapes', async () => {
    vi.mocked(generateSql).mockResolvedValue({
      ...sqlResult,
      sql: 'SELECT total_amount, SUM(total_amount) OVER () AS total_revenue FROM `analytics.fct_orders`',
    });
    const result = await runRoutineFastPath(baseInput());
    expect(result.kind).toBe('complete');
    if (result.kind !== 'complete') throw new Error('expected complete');
    expect(result.supervisorTriggers).toContain('complex_sql_shape');
    expect(reviewSql).toHaveBeenCalledTimes(1);
  });
});
