import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import acceptedFixture from '../../benchmarks/mock-results/2026-06-04-referencecard-accepted.json';
import {
  analyzeTablesInSql,
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
  scoreTableSelection,
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

  it('fails table selection when the expected table is only a projected column', () => {
    const expected = ['orders'];
    const observed = extractTablesFromSql('SELECT orders, revenue FROM daily_totals', [...expected, 'daily_totals']);

    expect(observed).toEqual(['daily_totals']);
    expect(tableSelectionPassed(expected, observed)).toBe(false);
    expect(tableSelectionPassed(expected, extractTablesFromSql('SELECT revenue FROM orders', expected))).toBe(true);
  });

  it('matches table names at the qualification level supplied by the expectation', () => {
    const known = ['orders', 'analytics.orders', 'demo-project.analytics.orders', 'other-project.analytics.orders'];

    expect(extractTablesFromSql('SELECT * FROM `demo-project` . `Analytics` . `Orders`', known))
      .toEqual(known.slice(0, 3));
    expect(extractTablesFromSql('SELECT * FROM analytics.orders', known)).toEqual(known.slice(0, 2));
    expect(extractTablesFromSql('SELECT * FROM other_dataset.orders', known)).toEqual(['orders']);
    expect(extractTablesFromSql('SELECT * FROM orders', known)).toEqual(['orders']);
  });

  it('keeps a wildcard relation distinct from a concrete table expectation', () => {
    const sql = 'SELECT id FROM `analytics.orders*` WHERE _TABLE_SUFFIX = "20260101"';

    expect(extractTablesFromSql(sql, ['analytics.orders', 'analytics.orders20260101', 'analytics.orders*']))
      .toEqual(['analytics.orders*']);
  });

  it('ignores qualified columns, aliases, strings and comments', () => {
    const sql = `SELECT analytics.orders, 'JOIN analytics.orders' AS orders
      FROM daily_totals AS analytics /* FROM analytics.orders */
      -- JOIN analytics.orders
      # FROM orders`;

    expect(extractTablesFromSql(sql, ['orders', 'analytics.orders', 'daily_totals'])).toEqual(['daily_totals']);
  });

  it('ignores BigQuery raw, bytes and triple-quoted literal contents', () => {
    const sql = `SELECT r'FROM analytics.orders', br"""this isn't SQL
      JOIN analytics.orders""" AS label FROM daily_totals`;

    expect(extractTablesFromSql(sql, ['analytics.orders', 'daily_totals'])).toEqual(['daily_totals']);
  });

  it('visits CTE bodies, comma joins, expression subqueries and set-operation branches', () => {
    const sql = `WITH recent AS (SELECT id FROM analytics.orders)
      SELECT r.id FROM recent r, analytics.customers c
      WHERE EXISTS (SELECT 1 FROM analytics.daily_totals)
      UNION ALL SELECT id FROM analytics.archived_orders`;
    const tables = ['analytics.orders', 'analytics.customers', 'analytics.daily_totals', 'analytics.archived_orders'];

    expect(extractTablesFromSql(sql, ['recent', ...tables])).toEqual(tables);
  });

  it('honors CTE shadowing without hiding qualified warehouse relations or leaking nested aliases', () => {
    const sql = `SELECT * FROM (
      WITH \`orders\` AS (SELECT * FROM analytics.daily_totals)
      SELECT * FROM \`ORDERS\`
    ) subquery, orders`;

    expect(extractTablesFromSql(sql, ['analytics.daily_totals', 'orders'])).toEqual(['analytics.daily_totals', 'orders']);
    expect(extractTablesFromSql('WITH orders AS (SELECT * FROM daily_totals) SELECT * FROM orders', ['orders']))
      .toEqual([]);
    expect(extractTablesFromSql('WITH orders AS (SELECT 1) SELECT * FROM analytics.orders', ['analytics.orders']))
      .toEqual(['analytics.orders']);
    expect(extractTablesFromSql('WITH orders AS (SELECT * FROM orders) SELECT * FROM orders', ['orders']))
      .toEqual(['orders']);
  });

  it('keeps a quoted CTE identifier intact when it contains a double quote', () => {
    const sql = 'WITH `today"orders` AS (SELECT * FROM daily_totals) SELECT * FROM `today"orders`';

    expect(extractTablesFromSql(sql, ['today"orders', 'daily_totals'])).toEqual(['daily_totals']);
  });

  it('does not count a recursive CTE self-reference as a table', () => {
    const sql = `WITH RECURSIVE orders AS (
      SELECT id FROM analytics.daily_totals
      UNION ALL SELECT id + 1 FROM orders WHERE id < 5
    ) SELECT id FROM orders`;

    expect(extractTablesFromSql(sql, ['orders', 'analytics.daily_totals'])).toEqual(['analytics.daily_totals']);
  });

  it('distinguishes implicit and explicit UNNEST from qualified warehouse paths', () => {
    const sql = `SELECT (SELECT COUNT(*) FROM analytics.orders) AS item_count
      FROM dataset.daily_totals AS \`analytics\`, analytics.customers,
      UNNEST(analytics.items) AS item, \`analytics.shipments\``;

    expect(extractTablesFromSql(sql, [
      'analytics.orders', 'analytics.customers', 'analytics.items', 'dataset.daily_totals', 'analytics.shipments',
    ])).toEqual(['dataset.daily_totals', 'analytics.shipments']);
  });

  it('keeps warehouse references in BigQuery QUALIFY queries', () => {
    const sql = `SELECT * EXCEPT (description) FROM analytics.orders
      QUALIFY ROW_NUMBER() OVER (PARTITION BY id ORDER BY order_date DESC) = 1
        AND EXISTS (SELECT 1 FROM analytics.daily_totals)`;

    const tables = ['analytics.orders', 'analytics.daily_totals'];
    expect(extractTablesFromSql(sql, tables)).toEqual(tables);
  });

  it.each(['TABLE `analytics.orders`', '(SELECT id FROM analytics.orders)'])(
    'observes a BigQuery ML input relation expressed as %s',
    (input) => {
      const sql = `SELECT * FROM ML.DETECT_ANOMALIES(
        MODEL \`analytics.order_model\`, STRUCT(0.95 AS anomaly_prob_threshold), ${input})`;

      expect(extractTablesFromSql(sql, ['analytics.order_model', 'analytics.orders'])).toEqual(['analytics.orders']);
    },
  );

  it('does not credit a model-only forecast or a table function name', () => {
    const sql = 'SELECT * FROM ML.FORECAST(MODEL `analytics.orders`, STRUCT(30 AS horizon))';

    expect(extractTablesFromSql(sql, ['analytics.orders', 'ML.FORECAST'])).toEqual([]);
    expect(extractTablesFromSql('SELECT * FROM analytics.orders(1)', ['analytics.orders'])).toEqual([]);
  });

  it.each([
    'SELECT orders FROM analytics.daily_totals |> WHERE revenue > 0',
    'SELECT * FROM analytics.orders WHERE',
    'SELECT 1; SELECT * FROM analytics.orders',
    'WITH `ord\\u0065rs` AS (SELECT 1) SELECT * FROM orders',
  ])('leaves uncertain or multi-statement SQL uncredited: %s', (sql) => {
    expect(extractTablesFromSql(sql, ['orders', 'analytics.orders', 'analytics.daily_totals'])).toEqual([]);
  });

  it.each([
    'SELECT ARRAY_AGG(source IGNORE NULLS ORDER BY ts DESC LIMIT 1)[OFFSET(0)] FROM analytics.fct_orders GROUP BY user_id',
    'SELECT ARRAY_AGG(source RESPECT NULLS ORDER BY ts DESC NULLS FIRST, id LIMIT 1)[SAFE_OFFSET(0)] FROM analytics.fct_orders',
    'SELECT ARRAY_AGG(source ORDER BY ts) FROM analytics.fct_orders',
    'SELECT ARRAY_AGG(source LIMIT 1) FROM analytics.fct_orders',
    'SELECT ARRAY_AGG(DISTINCT source ORDER BY source) FROM analytics.fct_orders',
    'SELECT ARRAY_AGG(STRUCT(a, b) ORDER BY COALESCE(a, 0) DESC LIMIT 5) FROM analytics.fct_orders',
    'SELECT LAST_VALUE(x IGNORE NULLS) OVER (ORDER BY d) FROM analytics.fct_orders',
    'SELECT * FROM analytics.fct_orders ORDER BY a DESC NULLS LAST',
    'SELECT * FROM analytics.fct_orders ORDER BY a NULLS FIRST',
    'SELECT * FROM analytics.fct_orders QUALIFY ROW_NUMBER() OVER (PARTITION BY a ORDER BY b DESC NULLS LAST) = 1',
    "SELECT STRING_AGG(name, ', ' ORDER BY name) FROM analytics.fct_orders",
    'SELECT * FROM analytics.fct_orders TABLESAMPLE SYSTEM (10 PERCENT)',
    'SELECT * FROM analytics.fct_orders AS o TABLESAMPLE SYSTEM (10 PERCENT)',
    'SELECT * FROM analytics.fct_orders WINDOW w AS (ORDER BY d)',
    'SELECT o.* FROM analytics.fct_orders o JOIN analytics.INFORMATION_SCHEMA.TABLES t ON t.table_name = o.x',
    'SELECT o.* FROM analytics.fct_orders o WHERE EXISTS (SELECT 1 FROM `region-us`.INFORMATION_SCHEMA.JOBS j)',
    'SELECT o.* FROM analytics.fct_orders o, `proj`.`region-us`.INFORMATION_SCHEMA.JOBS j',
    'SELECT o.* FROM analytics.fct_orders o, proj.analytics.INFORMATION_SCHEMA.TABLES t',
  ])('scores BigQuery syntax the parser lacks: %s', (sql) => {
    const known = ['analytics.fct_orders'];

    expect(analyzeTablesInSql(sql, known)).toEqual({ observedTables: known, unscorableReason: null });
    expect(tableSelectionPassed(known, extractTablesFromSql(sql, known))).toBe(true);
  });

  it('keeps tables referenced from subqueries inside aggregate ORDER BY clauses', () => {
    const sql = 'SELECT ARRAY_AGG(x ORDER BY (SELECT MAX(y) FROM analytics.dim_users) DESC LIMIT 1) FROM analytics.fct_orders';

    expect(extractTablesFromSql(sql, ['analytics.fct_orders', 'analytics.dim_users']))
      .toEqual(['analytics.fct_orders', 'analytics.dim_users']);
  });

  it('scores INFORMATION_SCHEMA views as relations at any qualification', () => {
    const known = ['analytics.INFORMATION_SCHEMA.TABLES', 'region-us.INFORMATION_SCHEMA.JOBS', 'analytics.fct_orders'];

    expect(extractTablesFromSql('SELECT table_name FROM analytics.INFORMATION_SCHEMA.TABLES', known))
      .toEqual(['analytics.INFORMATION_SCHEMA.TABLES']);
    expect(extractTablesFromSql('SELECT * FROM proj.analytics.INFORMATION_SCHEMA.TABLES', known))
      .toEqual(['analytics.INFORMATION_SCHEMA.TABLES']);
    expect(extractTablesFromSql('SELECT * FROM `region-us`.INFORMATION_SCHEMA.JOBS', known))
      .toEqual(['region-us.INFORMATION_SCHEMA.JOBS']);
    expect(extractTablesFromSql('SELECT * FROM `proj.region-us.INFORMATION_SCHEMA.JOBS`', known))
      .toEqual(['region-us.INFORMATION_SCHEMA.JOBS']);
  });

  it('leaves parser-gap keywords inside strings and comments untouched', () => {
    const sql = `SELECT 'ORDER BY x LIMIT 1 IGNORE NULLS TABLESAMPLE SYSTEM (1) FROM analytics.dim_users' AS s
      FROM analytics.fct_orders -- NULLS LAST JOIN analytics.dim_users`;

    expect(extractTablesFromSql(sql, ['analytics.fct_orders', 'analytics.dim_users'])).toEqual(['analytics.fct_orders']);
  });

  it('marks unparsable SQL as unscorable instead of a wrong-table miss', () => {
    const known = ['analytics.fct_orders'];
    const sql = 'SELECT 1 FROM analytics.fct_orders |> WHERE x';

    expect(analyzeTablesInSql(sql, known)).toEqual({
      observedTables: [],
      unscorableReason: expect.stringContaining('SQL parser could not resolve table references'),
    });
    expect(scoreTableSelection(known, sql, known)).toEqual({
      observedTables: [],
      tableSelectionPassed: null,
      tableSelectionUnscorableReason: expect.stringContaining('could not resolve'),
    });
    expect(analyzeTablesInSql("SELECT 'open FROM analytics.fct_orders", known).unscorableReason)
      .toContain('unterminated quoted token');
    expect(analyzeTablesInSql('SELECT 1; SELECT * FROM analytics.fct_orders', known).unscorableReason)
      .toBe('SQL is not a single statement');
  });

  it('still fails table selection for missing or wrong SQL and skips entries without expectations', () => {
    const known = ['analytics.fct_orders', 'analytics.dim_users'];

    expect(scoreTableSelection(['analytics.fct_orders'], null, known)).toEqual({
      observedTables: [],
      tableSelectionPassed: false,
    });
    expect(scoreTableSelection(['analytics.fct_orders'], 'SELECT * FROM analytics.dim_users', known)).toEqual({
      observedTables: ['analytics.dim_users'],
      tableSelectionPassed: false,
    });
    expect(scoreTableSelection(undefined, 'SELECT 1 |> WHERE x', known)).toEqual({
      observedTables: [],
      tableSelectionPassed: null,
    });
  });

  it('preserves the observed tables in the accepted benchmark fixture', () => {
    const known = acceptedFixture.results.flatMap(result => result.expectedTables ?? []);

    for (const result of acceptedFixture.results) {
      const observed = extractTablesFromSql(result.generatedSql, known);
      expect(observed).toEqual(result.observedTables);
      expect(tableSelectionPassed(result.expectedTables, observed)).toBe(result.tableSelectionPassed);
    }
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
