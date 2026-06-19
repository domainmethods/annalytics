import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import {
  buildBenchmarkMetadata,
  clarificationPassed,
  combineReferenceIds,
  corpusHashMatches,
  extractTablesFromSql,
  extractReferenceIdsFromCitations,
  formatValidationTrace,
  referenceRetrievalSource,
  resolveCollisionFreeResultPath,
  resolveCorpusPath,
  sqlShapePassed,
  tableSelectionPassed,
  referenceRetrievalPassed,
  extractTeachingIdsFromCitations,
  teachingRetrievalPassed,
  teachingComplianceLabel,
  validationResultsFromFailures,
} from '../../scripts/benchmarkSupport.js';
import type { FailureRecord, ValidationLayerRecord } from '../../src/qualityLoop.js';

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

describe('validationResultsFromFailures', () => {
  it('reports final SQL validation as passing when a retry succeeds', () => {
    const validationHistory: ValidationLayerRecord[] = [
      { attempt: 0, layer: 'l1', valid: false, detail: 'DML is blocked' },
      { attempt: 1, layer: 'l1', valid: true },
      { attempt: 1, layer: 'l2', valid: true },
      { attempt: 1, layer: 'l3', valid: true, bytesProcessed: 1000 },
      { attempt: 1, layer: 'l4', valid: true, bytesProcessed: 1000 },
    ];

    expect(validationResultsFromFailures([], 'fail_then_pass', validationHistory)).toEqual({
      l1: true,
      l2: true,
      l3: true,
      l4: true,
    });
  });

  it('treats fail_then_pass fallback history as final SQL passing', () => {
    const failures: FailureRecord[] = [
      { attempt: 0, failureType: 'structural', detail: 'DML is blocked' },
      { attempt: 1, failureType: 'dry_run', detail: 'Table not found' },
    ];

    expect(validationResultsFromFailures(failures, 'fail_then_pass')).toEqual({
      l1: true,
      l2: true,
      l3: true,
      l4: true,
    });
  });

  it('records cost gate failures independently of retry history', () => {
    expect(validationResultsFromFailures([], 'cost_exceeded')).toEqual({
      l1: true,
      l2: true,
      l3: true,
      l4: false,
    });
  });

  it('prefers validation trace when advisory L2 failures are available', () => {
    const validationHistory: ValidationLayerRecord[] = [
      { attempt: 0, layer: 'l1', valid: true },
      { attempt: 0, layer: 'l2', valid: false, detail: 'Parse warning' },
      { attempt: 0, layer: 'l3', valid: true, bytesProcessed: 1000 },
      { attempt: 0, layer: 'l4', valid: true, bytesProcessed: 1000 },
    ];

    expect(validationResultsFromFailures([], 'pass', validationHistory)).toEqual({
      l1: true,
      l2: false,
      l3: true,
      l4: true,
    });
  });

  it('uses only the final validation attempt when reporting advisory L2 state', () => {
    const validationHistory: ValidationLayerRecord[] = [
      { attempt: 0, layer: 'l1', valid: true },
      { attempt: 0, layer: 'l2', valid: false, detail: 'Parse warning' },
      { attempt: 0, layer: 'l3', valid: false, detail: 'Table not found' },
      { attempt: 1, layer: 'l1', valid: true },
      { attempt: 1, layer: 'l2', valid: true },
      { attempt: 1, layer: 'l3', valid: true, bytesProcessed: 1000 },
      { attempt: 1, layer: 'l4', valid: true, bytesProcessed: 1000 },
    ];

    expect(validationResultsFromFailures([], 'fail_then_pass', validationHistory)).toEqual({
      l1: true,
      l2: true,
      l3: true,
      l4: true,
    });
  });
});

describe('buildBenchmarkMetadata', () => {
  it('captures reproducible run provenance and artifact hashes', () => {
    const metadata = buildBenchmarkMetadata({
      packageJson: JSON.stringify({ version: '1.2.3' }),
      corpusRaw: '[]',
      manifestRaw: '{"nodes":{}}',
      catalogRaw: '{"nodes":{}}',
      gitSha: 'abc123',
      gitDirty: true,
      geminiModel: 'gemini-test',
      judgeModel: 'judge-test',
      fileSearchStoreId: 'stores/test',
      gcpProjectId: 'analytics-prod',
    });

    expect(metadata.gitSha).toBe('abc123');
    expect(metadata.gitDirty).toBe(true);
    expect(metadata.packageVersion).toBe('1.2.3');
    expect(metadata.geminiModel).toBe('gemini-test');
    expect(metadata.judgeModel).toBe('judge-test');
    expect(metadata.fileSearchStoreId).toBe('stores/test');
    expect(metadata.gcpProjectId).toBe('analytics-prod');
    expect(metadata.corpusHash).toBe(createHash('sha256').update('[]').digest('hex'));
    expect(metadata.dbtManifestHash).toBe(createHash('sha256').update('{"nodes":{}}').digest('hex'));
    expect(metadata.dbtCatalogHash).toBe(createHash('sha256').update('{"nodes":{}}').digest('hex'));
  });
});

describe('reference retrieval helpers', () => {
  it('extracts reference IDs from source names and chunk text', () => {
    const ids = extractReferenceIdsFromCitations([
      {
        sourceFile: 'reference_card:revenue-canonical-definition',
        chunkText: 'Canonical table: analytics.fct_orders',
        relevanceScore: 1,
      },
      {
        sourceFile: 'file-123',
        chunkText: '# ReferenceCard: revenue-monthly-grain\nDomain: revenue',
        relevanceScore: 1,
      },
    ]);

    expect(ids).toEqual([
      'revenue-canonical-definition',
      'revenue-monthly-grain',
    ]);
  });

  it('reports whether all expected reference IDs were observed', () => {
    expect(referenceRetrievalPassed(
      ['revenue-canonical-definition'],
      ['revenue-canonical-definition', 'revenue-monthly-grain'],
    )).toBe(true);

    expect(referenceRetrievalPassed(
      ['revenue-canonical-definition', 'revenue-monthly-grain'],
      ['revenue-canonical-definition'],
    )).toBe(false);

    expect(referenceRetrievalPassed(undefined, [])).toBeNull();
  });

  it('combines explicit probe and SQL grounding reference IDs deterministically', () => {
    expect(combineReferenceIds(
      ['revenue-monthly-grain', 'revenue-canonical-definition'],
      ['revenue-canonical-definition'],
      undefined,
    )).toEqual([
      'revenue-canonical-definition',
      'revenue-monthly-grain',
    ]);
  });

  it('reports the strongest retrieval evidence source', () => {
    expect(referenceRetrievalSource(
      ['revenue-canonical-definition'],
      ['revenue-monthly-grain'],
    )).toBe('explicit_probe');
    expect(referenceRetrievalSource([], ['revenue-monthly-grain'])).toBe('sql_grounding');
    expect(referenceRetrievalSource([], [])).toBe('none');
  });
});

describe('teaching retrieval helpers', () => {
  it('extracts teaching ids from source files and chunk text', () => {
    expect(extractTeachingIdsFromCitations([
      { sourceFile: 'teaching:revenue-grain', chunkText: '', relevanceScore: 1 },
      { sourceFile: 'x', chunkText: 'Teaching: session-window', relevanceScore: 1 },
      { sourceFile: 'reference_card:rev-001', chunkText: '', relevanceScore: 1 },
    ])).toEqual(['revenue-grain', 'session-window']);
  });

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

describe('deterministic benchmark expectation helpers', () => {
  it('extracts observed tables from generated SQL using known table names', () => {
    const sql = `
      SELECT c.customer_id, SUM(o.total_amount) AS lifetime_value
      FROM \`analytics.fct_orders\` o
      JOIN analytics.dim_customers c ON c.customer_id = o.customer_id
      WHERE o.order_status = 'completed'
    `;

    expect(extractTablesFromSql(sql, [
      'analytics.fct_orders',
      'analytics.dim_customers',
      'analytics.fct_revenue',
    ])).toEqual(['analytics.fct_orders', 'analytics.dim_customers']);
  });

  it('does not infer expected tables from self-reported metadata or substrings', () => {
    const sql = 'SELECT * FROM `analytics.fct_orders_archive`';

    expect(extractTablesFromSql(sql, [
      'analytics.fct_orders',
      'analytics.fct_orders_archive',
    ])).toEqual(['analytics.fct_orders_archive']);
  });

  it('reports whether all expected tables were observed', () => {
    expect(tableSelectionPassed(
      ['analytics.fct_orders'],
      ['analytics.fct_orders', 'analytics.dim_customers'],
    )).toBe(true);

    expect(tableSelectionPassed(
      ['analytics.fct_orders', 'analytics.dim_customers'],
      ['analytics.fct_orders'],
    )).toBe(false);

    expect(tableSelectionPassed(undefined, [])).toBeNull();
  });

  it('checks SQL snippets case-insensitively with whitespace normalization', () => {
    const sql = `
      SELECT DATE_TRUNC(order_date, MONTH) AS revenue_month
      FROM \`analytics.fct_orders\`
      WHERE order_status = 'completed'
    `;

    expect(sqlShapePassed(
      ["date_trunc(order_date, month)", "order_status = 'completed'"],
      sql,
    )).toBe(true);
    expect(sqlShapePassed(['analytics.fct_revenue'], sql)).toBe(false);
    expect(sqlShapePassed(undefined, sql)).toBeNull();
    expect(sqlShapePassed(['select'], null)).toBe(false);
  });

  it('matches column fragments when generated SQL qualifies identifiers with aliases', () => {
    const sql = `
      SELECT COUNT(DISTINCT sessions.client_key) AS unique_visitors
      FROM \`analytics.fct_sessions\` AS sessions
    `;

    expect(sqlShapePassed(['COUNT(DISTINCT client_key)'], sql)).toBe(true);
    expect(sqlShapePassed(['analytics.fct_sessions'], sql)).toBe(true);
    expect(sqlShapePassed(['analytics.fct_orders'], sql)).toBe(false);
  });

  it('checks expected clarification confidence when a corpus case declares it', () => {
    expect(clarificationPassed('low', 'low')).toBe(true);
    expect(clarificationPassed('low', 'high')).toBe(false);
    expect(clarificationPassed(undefined, 'low')).toBeNull();
  });
});

describe('resolveCorpusPath', () => {
  it('prefers benchmarks/corpus.live.json when it exists', async () => {
    const path = await resolveCorpusPath('/repo', async p => p.endsWith('corpus.live.json'));
    expect(path).toBe(join('/repo', 'benchmarks', 'corpus.live.json'));
  });

  it('falls back to benchmarks/corpus.json when no live corpus exists', async () => {
    const path = await resolveCorpusPath('/repo', async () => false);
    expect(path).toBe(join('/repo', 'benchmarks', 'corpus.json'));
  });
});

describe('resolveCollisionFreeResultPath', () => {
  it('uses the bare date path when nothing exists', async () => {
    const p = await resolveCollisionFreeResultPath('/r', '2026-06-12', async () => false);
    expect(p).toBe('/r/2026-06-12.json');
  });

  it('suffixes -run2 when the dated file already exists', async () => {
    const existing = new Set(['/r/2026-06-12.json']);
    const p = await resolveCollisionFreeResultPath('/r', '2026-06-12', async path => existing.has(path));
    expect(p).toBe('/r/2026-06-12-run2.json');
  });

  it('increments past consecutive collisions', async () => {
    const existing = new Set(['/r/2026-06-12.json', '/r/2026-06-12-run2.json']);
    const p = await resolveCollisionFreeResultPath('/r', '2026-06-12', async path => existing.has(path));
    expect(p).toBe('/r/2026-06-12-run3.json');
  });
});

describe('corpusHashMatches', () => {
  const corpusRaw = '[{"id":"live-easy-001"}]';
  const corpusHash = createHash('sha256').update(corpusRaw).digest('hex');

  it('accepts a corpus whose hash matches the run metadata', () => {
    expect(corpusHashMatches(corpusRaw, corpusHash)).toBe(true);
  });

  it('rejects a corpus that differs from the one the run recorded', () => {
    expect(corpusHashMatches('[{"id":"other"}]', corpusHash)).toBe(false);
  });

  it('accepts runs with no recorded hash (nothing to verify against)', () => {
    expect(corpusHashMatches(corpusRaw, undefined)).toBe(true);
    expect(corpusHashMatches(corpusRaw, null)).toBe(true);
  });
});
