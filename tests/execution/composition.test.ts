import { describe, it, expect } from 'vitest';
import { verifyComposition, type CompositionVerdict } from '../../src/execution/composition.js';
import type { QueryResult } from '../../src/types.js';

const T = '`proj.ds.sessions`';

/** Stand-in for the SDK's Big decimal instances (NUMERIC/BIGNUMERIC cells). */
class FakeBig {
  constructor(private readonly text: string) {}
  toString(): string { return this.text; }
}

type Pair = [unknown, unknown];

function result(
  pairs: Pair[],
  opts: { names?: [string, string]; types?: string[] | null; truncated?: boolean; totalRows?: number } = {},
): QueryResult {
  const [d, m] = opts.names ?? ['ch', 'n'];
  const rows = pairs.map(([dv, mv]) => ({ [d]: dv, [m]: mv }));
  const r: QueryResult = {
    rows,
    columnNames: [d, m],
    totalRows: opts.totalRows ?? rows.length,
    bytesProcessed: 0,
    truncated: opts.truncated ?? false,
  };
  if (opts.types !== null) r.columnTypes = opts.types ?? ['STRING', 'INT64'];
  return r;
}

const R2A_CTE = `WITH s AS (SELECT channel AS a, channel AS b FROM ${T}) SELECT a, COUNT(*) AS n FROM s`;
const three: Pair[] = [['Direct', 198], ['Organic', 120], ['Unassigned', 42]];

function verify(sql: string, res: QueryResult, maxDisplayRows = 20): CompositionVerdict {
  return verifyComposition({ sql, result: res, maxDisplayRows });
}

function expectReject(sql: string, res: QueryResult, reason: string): void {
  expect(verify(sql, res)).toEqual({ eligible: false, reason });
}

function expectEligible(sql: string, res: QueryResult) {
  const v = verify(sql, res);
  if (!v.eligible) throw new Error(`expected eligible, got ${v.reason}`);
  return v;
}

function rowsOf(n: number): Pair[] {
  return Array.from({ length: n }, (_, i) => [`c${i}`, i + 1]);
}

describe('verifyComposition: eligible (§6 A-rows)', () => {
  it('A1: COUNT(*) by ordinal with a WHERE on another column', () => {
    const v = expectEligible(
      `SELECT ch, COUNT(*) AS n FROM ${T} WHERE d >= '2024-01-01' GROUP BY 1 ORDER BY 2 DESC`,
      result(three),
    );
    expect(v.measureKind).toBe('count');
    expect(v.dimension).toBe('ch');
    expect(v.measure).toBe('n');
    expect(v.total).toBe('360');
    expect(v.shares.map(s => s.label)).toEqual(['55%', '33%', '12%']);
    expect(v.topIndex).toBe(0);
    expect(v.usedUniqueKeys).toEqual([]);
  });

  it('A2: SUM over NUMERIC Big cells gives an exact total', () => {
    const v = expectEligible(
      `SELECT ch, SUM(revenue) AS revenue FROM ${T} GROUP BY ch`,
      result(
        [['Direct', new FakeBig('100.25')], ['Organic', new FakeBig('50.5')], ['Email', new FakeBig('0.25')]],
        { names: ['ch', 'revenue'], types: ['STRING', 'NUMERIC'] },
      ),
    );
    expect(v.measureKind).toBe('sum');
    expect(v.total).toBe('151.00');
    expect(v.shares.map(s => s.label)).toEqual(['66%', '33%', '<1%']);
  });

  it('A3: COUNTIF is a count', () => {
    const v = expectEligible(`SELECT ch, COUNTIF(is_conv) AS n FROM ${T} GROUP BY ch`, result(three));
    expect(v.measureKind).toBe('count');
    expect(v.total).toBe('360');
  });

  it('A3: COUNT(expr) is a count', () => {
    const v = expectEligible(`SELECT ch, COUNT(user_id) AS n FROM ${T} GROUP BY ch`, result(three));
    expect(v.measureKind).toBe('count');
  });

  it.each([
    'SAFE_CAST(SUM(x) AS NUMERIC)',
    'CAST(SUM(x) AS FLOAT64)',
    'IFNULL(SUM(x), 0)',
    'COALESCE(SUM(x), 0)',
  ])('A4: allow-listed wrapper %s', (measure) => {
    const v = expectEligible(`SELECT ch, ${measure} AS n FROM ${T} GROUP BY ch`, result(three));
    expect(v.measureKind).toBe('sum');
    expect(v.total).toBe('360');
  });

  it.each(['ROUND(COUNT(*))', 'ROUND(COUNT(*), 2)', 'CAST(COUNT(*) AS INT64)', 'ROUND(IFNULL(COUNT(*), 0))'])(
    'A4: a scale-reducing wrapper over a count is a no-op: %s', (measure) => {
      const v = expectEligible(`SELECT ch, ${measure} AS n FROM ${T} GROUP BY ch`, result(three));
      expect(v.measureKind).toBe('count');
    },
  );

  it.each(['ROUND(SUM(x))', 'ROUND(SUM(x), 2)', 'CAST(SUM(x) AS INT64)', 'SAFE_CAST(SUM(x) AS INT64)', 'ROUND(IFNULL(SUM(x), 0), 2)'])(
    'R-11b: a scale-reducing wrapper over a SUM rounds each cell before the shares: %s', (measure) => {
      expectReject(`SELECT ch, ${measure} AS n FROM ${T} GROUP BY ch`, result(three), 'measure_not_additive');
    },
  );

  it('A5: a LIMIT that did not bite', () => {
    const v = expectEligible(
      `SELECT ch, COUNT(*) AS n FROM ${T} GROUP BY ch ORDER BY n DESC LIMIT 10`,
      result(rowsOf(6)),
    );
    expect(v.total).toBe('21');
  });

  it('A6: passthrough CTE', () => {
    const v = expectEligible(
      `WITH s AS (SELECT * FROM ${T} WHERE d >= '2024-01-01') SELECT ch, COUNT(*) AS n FROM s GROUP BY ch`,
      result(three),
    );
    expect(v.total).toBe('360');
  });

  it('A7/A8 labels flow through (>99% / <1%, 33% x3)', () => {
    const big = expectEligible(`SELECT ch, COUNT(*) AS n FROM ${T} GROUP BY ch`, result([['big', 249], ['tiny', 1]]));
    expect(big.shares.map(s => s.label)).toEqual(['>99%', '<1%']);
    const thirds = expectEligible(`SELECT ch, COUNT(*) AS n FROM ${T} GROUP BY ch`, result([['a', 1], ['b', 1], ['c', 1]]));
    expect(thirds.shares.map(s => s.label)).toEqual(['33%', '33%', '33%']);
    expect(thirds.topIndex).toBeNull();
  });

  it('topIndex is null when distinct measures round to the same share (fails safe; do not compare raw values)', () => {
    const v = expectEligible(`SELECT ch, COUNT(*) AS n FROM ${T} GROUP BY ch`, result([['a', 100000], ['b', 100001], ['c', 1]]));
    expect(v.shares.map(s => s.basisPoints).slice(0, 2)).toEqual([5000, 5000]);
    expect(v.topIndex).toBeNull();
  });

  it('A9: INT64 above 2^53 as a string gives an exact BigInt total', () => {
    const v = expectEligible(
      `SELECT ch, SUM(x) AS n FROM ${T} GROUP BY ch`,
      result([['a', '9007199254740993'], ['b', '9007199254740993']]),
    );
    expect(v.total).toBe('18014398509481986');
    expect(v.shares.map(s => s.label)).toEqual(['50%', '50%']);
    expect(v.topIndex).toBeNull();
  });

  it('legacy REST type names (STRING/INTEGER) are eligible', () => {
    const v = expectEligible(`SELECT ch, COUNT(*) AS n FROM ${T} GROUP BY ch`, result(three, { types: ['STRING', 'INTEGER'] }));
    expect(v.total).toBe('360');
  });

  it('DECIMAL/BIGDECIMAL aliases are eligible, matching isNumericColumnType', () => {
    for (const type of ['DECIMAL', 'BIGDECIMAL']) {
      const v = expectEligible(`SELECT ch, COUNT(*) AS n FROM ${T} GROUP BY ch`, result(three, { types: ['STRING', type] }));
      expect(v.total).toBe('360');
    }
  });

  it('legacy REST type names (BOOLEAN/FLOAT) are eligible', () => {
    const v = expectEligible(
      `SELECT is_new, SUM(x) AS n FROM ${T} GROUP BY is_new`,
      result([[true, 1.5], [false, 0.5]], { names: ['is_new', 'n'], types: ['BOOLEAN', 'FLOAT'] }),
    );
    expect(v.total).toBe('2.0');
    expect(v.shares.map(s => s.label)).toEqual(['75%', '25%']);
  });

  it('measure in column 1, dimension in column 2', () => {
    const v = expectEligible(
      `SELECT COUNT(*) AS n, ch FROM ${T} GROUP BY ch`,
      {
        rows: three.map(([d, m]) => ({ n: m, ch: d })),
        columnNames: ['n', 'ch'],
        columnTypes: ['INT64', 'STRING'],
        totalRows: 3, bytesProcessed: 0, truncated: false,
      },
    );
    expect(v.dimension).toBe('ch');
    expect(v.measure).toBe('n');
    expect(v.total).toBe('360');
  });

  it('Review Focus #1: a CTE named like a base table is resolved as the CTE (passthrough stays eligible)', () => {
    expectEligible(`WITH sessions AS (SELECT * FROM ${T}) SELECT ch, COUNT(*) AS n FROM sessions GROUP BY ch`, result(three));
  });

  it('Review Focus #3: a NULL dimension group is eligible', () => {
    const v = expectEligible(`SELECT ch, COUNT(*) AS n FROM ${T} GROUP BY ch`, result([['Direct', 198], [null, 42]]));
    expect(v.total).toBe('240');
  });

  it('R-35: LOWER(ch) grouped by the identical expression is eligible', () => {
    expectEligible(`SELECT LOWER(ch) AS ch, COUNT(*) AS n FROM ${T} GROUP BY LOWER(ch)`, result(three));
  });

  it('group by alias resolves', () => {
    expectEligible(`SELECT LOWER(channel) AS ch, COUNT(*) AS n FROM ${T} GROUP BY ch`, result(three));
  });

  it('a single trailing semicolon is still one statement', () => {
    expectEligible(`SELECT ch, COUNT(*) AS n FROM ${T} GROUP BY ch;`, result(three));
  });

  it('a derived table that is row-preserving is eligible', () => {
    expectEligible(`SELECT ch, COUNT(*) AS n FROM (SELECT ch FROM ${T} WHERE d > '2024') GROUP BY ch`, result(three));
  });

  it('S8: a WHERE on an unrelated column through the same derived table stays eligible', () => {
    expectEligible(
      `SELECT ch, COUNT(*) AS n FROM (SELECT LOWER(channel) AS ch, d FROM ${T}) WHERE d >= '2024-01-01' GROUP BY ch`,
      result(three),
    );
  });

  it.each([
    ['alias', `SELECT s.ch, COUNT(*) AS n FROM ${T} s WHERE s.d >= '2024-01-01' GROUP BY s.ch`],
    ['table name', `SELECT sessions.ch, COUNT(*) AS n FROM ${T} WHERE sessions.d >= '2024-01-01' GROUP BY sessions.ch`],
    ['derived alias', `SELECT t.ch, COUNT(*) AS n FROM (SELECT LOWER(channel) AS ch, d FROM ${T}) t WHERE t.d >= '2024-01-01' GROUP BY t.ch`],
  ])('S8: a WHERE qualified by the select\'s own FROM %s stays eligible', (_id, sql) => {
    expectEligible(sql, result(three));
  });

  it('S8: the R2a CTE without a WHERE is eligible (control for the R2a probe)', () => {
    expectEligible(`${R2A_CTE} GROUP BY a`, result(three, { names: ['a', 'n'] }));
  });

  it('an explicit alias hides the table name: a bare `sessions` under `AS s` is an ordinary column', () => {
    expectEligible(`SELECT s.ch, COUNT(*) AS n FROM ${T} s WHERE sessions IS NOT NULL GROUP BY s.ch`, result(three));
  });
});

describe('verifyComposition: rejected (§6 R-rows)', () => {
  it('R-1: LIMIT that bit', () => {
    expectReject(`SELECT ch, COUNT(*) AS n FROM ${T} GROUP BY ch ORDER BY n DESC LIMIT 5`, result(rowsOf(5)), 'limit_applied');
  });

  it('R-2: LIMIT with OFFSET', () => {
    expectReject(`SELECT ch, COUNT(*) AS n FROM ${T} GROUP BY ch LIMIT 5 OFFSET 5`, result(three), 'limit_applied');
  });

  it('R-2b: LIMIT n, m', () => {
    expectReject(`SELECT ch, COUNT(*) AS n FROM ${T} GROUP BY ch LIMIT 5, 5`, result(three), 'limit_applied');
  });

  it('R-3: HAVING', () => {
    expectReject(`SELECT ch, COUNT(*) AS n FROM ${T} GROUP BY ch HAVING COUNT(*) > 10`, result(three), 'outer_shape');
  });

  it('R-4: QUALIFY', () => {
    expectReject(
      `SELECT ch, COUNT(*) AS n FROM ${T} GROUP BY ch QUALIFY ROW_NUMBER() OVER (ORDER BY COUNT(*) DESC) <= 5`,
      result(rowsOf(5)), 'outer_shape',
    );
  });

  it('R-5: CTE with LIMIT', () => {
    expectReject(
      `WITH top AS (SELECT * FROM ${T} ORDER BY d DESC LIMIT 5) SELECT ch, COUNT(*) AS n FROM top GROUP BY ch`,
      result(three), 'row_source',
    );
  });

  it('Review Focus #1: a CTE that shadows a base-table name with LIMIT is rejected', () => {
    expectReject(
      `WITH sessions AS (SELECT * FROM ${T} LIMIT 5) SELECT ch, COUNT(*) AS n FROM sessions GROUP BY ch`,
      result(three), 'row_source',
    );
  });

  it('R-6: WHERE IN (subquery)', () => {
    expectReject(
      `SELECT page, COUNT(*) AS n FROM ${T} WHERE page IN (SELECT page FROM \`proj.ds.pages\` ORDER BY n DESC LIMIT 10) GROUP BY page`,
      result(rowsOf(10), { names: ['page', 'n'] }), 'where_subquery',
    );
  });

  it('R-6b: EXISTS / scalar subquery in a CTE WHERE', () => {
    expectReject(
      `WITH s AS (SELECT * FROM ${T} WHERE EXISTS (SELECT 1 FROM \`proj.ds.u\`)) SELECT ch, COUNT(*) AS n FROM s GROUP BY ch`,
      result(three), 'where_subquery',
    );
  });

  it('R-7: aggregate filtered via an outer subquery (no outer GROUP BY)', () => {
    expectReject(`SELECT * FROM (SELECT ch, COUNT(*) n FROM ${T} GROUP BY ch) WHERE n > 100`, result(three), 'group_by_shape');
  });

  it('R-8: COUNT(DISTINCT user_pseudo_id) without uniqueKeys', () => {
    expectReject(`SELECT ch, COUNT(DISTINCT user_pseudo_id) AS n FROM ${T} GROUP BY ch`, result(three), 'count_distinct');
  });

  it('R-9: COUNT(DISTINCT session_key) by page_path', () => {
    expectReject(
      `SELECT page_path, COUNT(DISTINCT session_key) AS n FROM ${T} GROUP BY page_path`,
      result(three, { names: ['page_path', 'n'] }), 'count_distinct',
    );
  });

  it('R-10: APPROX_COUNT_DISTINCT', () => {
    expectReject(`SELECT ch, APPROX_COUNT_DISTINCT(x) AS n FROM ${T} GROUP BY ch`, result(three), 'count_distinct');
  });

  it.each(['AVG(engagement_time)', 'MAX(x)', 'MIN(x)', 'ROUND(AVG(x), 2)', 'IFNULL(SUM(x), 1)', 'CAST(SUM(x) AS STRING)'])(
    'R-11: %s', (measure) => {
      expectReject(`SELECT ch, ${measure} AS n FROM ${T} GROUP BY ch`, result(three), 'measure_not_additive');
    },
  );

  it.each(['SUM(conversions) / SUM(sessions)', 'SAFE_DIVIDE(SUM(conversions), SUM(sessions))'])('R-12: %s', (measure) => {
    expectReject(
      `SELECT ch, ${measure} AS n FROM ${T} GROUP BY ch`,
      result([['a', 0.5], ['b', 0.25]], { types: ['STRING', 'FLOAT64'] }), 'measure_not_additive',
    );
  });

  it.each(['SUM(conversion_rate)', 'SUM(daily_users)', 'SUM(pct_new)', 'SUM(t.avg_time)', 'SUM(conversionrate)', 'SUM(bounceRate)', 'SUM(generated_revenue)'])('R-13: %s', (measure) => {
    expectReject(`SELECT ch, ${measure} AS n FROM ${T} t GROUP BY ch`, result(three), 'sum_non_additive_column');
  });

  it.each([
    ['a CTE', `WITH t AS (SELECT ch, conversion_rate AS amt FROM ${T}) SELECT ch, SUM(amt) AS n FROM t GROUP BY ch`],
    ['a subquery', `SELECT ch, SUM(amt) AS n FROM (SELECT ch, avg_order_value AS amt FROM ${T}) GROUP BY ch`],
    ['two CTE levels', `WITH a AS (SELECT ch, bounce_rate AS x FROM ${T}), b AS (SELECT ch, x AS amt FROM a) SELECT ch, SUM(amt) AS n FROM b GROUP BY ch`],
  ])('R-13b: a non-additive column renamed in %s', (_label, sql) => {
    expectReject(sql, result(three), 'sum_non_additive_column');
  });

  it('R-13c: an additive column passed through a CTE beside a rate stays eligible', () => {
    expectEligible(`WITH t AS (SELECT ch, revenue AS amt, bounce_rate FROM ${T}) SELECT ch, SUM(amt) AS n FROM t GROUP BY ch`, result(three));
  });

  it('R-14: pre-computed share, 3 columns', () => {
    const res: QueryResult = {
      rows: [{ ch: 'a', n: 1, pct: 0.5 }, { ch: 'b', n: 1, pct: 0.5 }],
      columnNames: ['ch', 'n', 'pct'], columnTypes: ['STRING', 'INT64', 'FLOAT64'],
      totalRows: 2, bytesProcessed: 0, truncated: false,
    };
    expectReject(`SELECT ch, n, n / SUM(n) OVER () AS pct FROM ${T}`, res, 'column_count');
  });

  it('R-14b: windowed measure in 2 columns', () => {
    expectReject(`SELECT ch, SUM(COUNT(*)) OVER () AS n FROM ${T} GROUP BY ch`, result(three), 'outer_shape');
  });

  it('R-15: GROUP BY ROLLUP', () => {
    expectReject(`SELECT ch, COUNT(*) AS n FROM ${T} GROUP BY ROLLUP(ch)`, result([...three, [null, 360]]), 'group_by_shape');
  });

  it('R-15b: GROUP BY CUBE', () => {
    expectReject(`SELECT ch, COUNT(*) AS n FROM ${T} GROUP BY CUBE(ch)`, result(three), 'group_by_shape');
  });

  it('R-16: two dimensions', () => {
    const res: QueryResult = {
      rows: [{ ch: 'a', device: 'm', n: 1 }, { ch: 'b', device: 'd', n: 1 }],
      columnNames: ['ch', 'device', 'n'], columnTypes: ['STRING', 'STRING', 'INT64'],
      totalRows: 2, bytesProcessed: 0, truncated: false,
    };
    expectReject(`SELECT ch, device, COUNT(*) AS n FROM ${T} GROUP BY ch, device`, res, 'column_count');
  });

  it('R-16b: two GROUP BY items with two columns', () => {
    expectReject(`SELECT ch, COUNT(*) AS n FROM ${T} GROUP BY ch, device`, result(three), 'group_by_shape');
  });

  it('R-17: JOIN', () => {
    expectReject(
      `SELECT s.ch, COUNT(*) AS n FROM ${T} s JOIN \`proj.ds.dim_channel\` d USING (id) GROUP BY s.ch`,
      result(three), 'row_source',
    );
  });

  it('R-17b: comma join', () => {
    expectReject(`SELECT ch, COUNT(*) AS n FROM ${T}, \`proj.ds.u\` GROUP BY ch`, result(three), 'row_source');
  });

  it('R-17c: JOIN inside a CTE', () => {
    expectReject(
      `WITH s AS (SELECT a.* FROM ${T} a LEFT JOIN \`proj.ds.u\` b ON a.id = b.id) SELECT ch, COUNT(*) AS n FROM s GROUP BY ch`,
      result(three), 'row_source',
    );
  });

  it('R-18: UNNEST', () => {
    expectReject(
      `SELECT ep.key, COUNT(*) AS n FROM \`proj.ds.events\`, UNNEST(event_params) ep GROUP BY ep.key`,
      result(three, { names: ['key', 'n'] }), 'row_source',
    );
  });

  it('R-19: UNION ALL', () => {
    expectReject(
      `SELECT ch, COUNT(*) AS n FROM \`proj.ds.a\` GROUP BY ch UNION ALL SELECT ch, COUNT(*) AS n FROM \`proj.ds.b\` GROUP BY ch`,
      result(rowsOf(4)), 'outer_shape',
    );
  });

  it('R-20: SELECT DISTINCT with a window', () => {
    expectReject(`SELECT DISTINCT ch, COUNT(*) OVER (PARTITION BY ch) AS n FROM ${T}`, result(three), 'outer_shape');
  });

  it('R-21: INT64 ID dimension', () => {
    expectReject(
      `SELECT customer_id, SUM(amt) AS n FROM ${T} GROUP BY 1`,
      result([[1, 10], [2, 20]], { names: ['customer_id', 'n'], types: ['INT64', 'INT64'] }), 'column_types',
    );
  });

  it('R-22: DATE dimension', () => {
    expectReject(
      `SELECT DATE_TRUNC(d, MONTH) AS m, COUNT(*) AS n FROM ${T} GROUP BY 1`,
      result([['2024-01-01', 10], ['2024-02-01', 20]], { names: ['m', 'n'], types: ['DATE', 'INT64'] }), 'column_types',
    );
  });

  it('R-23: columnTypes absent', () => {
    expectReject(`SELECT ch, COUNT(*) AS n FROM ${T} GROUP BY ch`, result(three, { types: null }), 'column_types');
  });

  it.each([
    [['STRING[]', 'INT64']],
    [['RECORD', 'INT64']],
    [['STRING', 'INT64[]']],
    [['STRING', 'STRING']],
    [['STRING']],
  ])('R4: column types %j reject', (types) => {
    expectReject(`SELECT ch, COUNT(*) AS n FROM ${T} GROUP BY ch`, result(three, { types }), 'column_types');
  });

  it('R-24: a negative row', () => {
    expectReject(`SELECT ch, SUM(net) AS n FROM ${T} GROUP BY ch`, result([['a', 100], ['b', -50]]), 'negative_value');
  });

  it('R-25: all zeros', () => {
    expectReject(`SELECT ch, COUNT(*) AS n FROM ${T} GROUP BY ch`, result([['a', 0], ['b', 0], ['c', 0]]), 'zero_total');
  });

  it('R-26: NULL measure cell', () => {
    expectReject(`SELECT ch, SUM(x) AS n FROM ${T} GROUP BY ch`, result([['a', 1], ['b', null]]), 'measure_value');
  });

  it.each(['Total', 'All', ' grand total ', '(all)', 'SUM', 'overall'])('R-27: dimension value %j', (label) => {
    expectReject(`SELECT ch, COUNT(*) AS n FROM ${T} GROUP BY ch`, result([...three, [label, 360]]), 'total_like_row');
  });

  it('R-28: WHERE on the dimension', () => {
    expectReject(
      `SELECT ch, COUNT(*) AS n FROM ${T} WHERE ch IN ('Direct', 'Organic') GROUP BY ch`,
      result([['Direct', 198], ['Organic', 120]]), 'where_on_dimension',
    );
  });

  it('R-28b: WHERE on the dimension source column of an aliased expression', () => {
    expectReject(
      `SELECT LOWER(channel) AS ch, COUNT(*) AS n FROM ${T} WHERE channel != 'x' GROUP BY 1`,
      result(three), 'where_on_dimension',
    );
  });

  it('R-28c: WHERE on the dimension through a passthrough CTE', () => {
    expectReject(
      `WITH s AS (SELECT channel AS ch, d FROM ${T} WHERE channel != 'x') SELECT ch, COUNT(*) AS n FROM s GROUP BY ch`,
      result(three), 'where_on_dimension',
    );
  });

  it('R-28d: WHERE on the dimension behind SELECT * REPLACE in a CTE', () => {
    expectReject(
      `WITH s AS (SELECT * REPLACE (LOWER(channel) AS ch) FROM ${T} WHERE channel != 'x') SELECT ch, COUNT(*) AS n FROM s GROUP BY ch`,
      result(three), 'where_on_dimension',
    );
  });

  it.each([
    ['P01', `SELECT ch, COUNT(*) AS n FROM (SELECT *, LOWER(channel) AS ch FROM ${T}) WHERE channel IN ('Direct','Organic') GROUP BY ch`],
    ['P02', `WITH s AS (SELECT channel, LOWER(channel) AS ch FROM ${T}) SELECT ch, COUNT(*) AS n FROM s WHERE channel = 'Direct' GROUP BY ch`],
    ['P30', `SELECT ch, COUNT(*) AS n FROM (SELECT channel AS ch, channel FROM ${T}) WHERE channel IN ('a','b') GROUP BY ch`],
    ['P31', `SELECT LOWER(c) AS ch, COUNT(*) AS n FROM (SELECT channel AS c, * FROM ${T}) WHERE channel = 'a' GROUP BY 1`],
    ['P32', `SELECT ch, COUNT(*) AS n FROM (SELECT * REPLACE (LOWER(channel) AS ch) FROM ${T}) WHERE channel='a' GROUP BY ch`],
    ['P46', `WITH a AS (SELECT channel AS c1, channel AS c2 FROM ${T}), b AS (SELECT c1 AS ch, c2 FROM a WHERE c2 = 'Direct') SELECT ch, COUNT(*) AS n FROM b GROUP BY ch`],
    ['P47', `WITH a AS (SELECT * FROM ${T}), b AS (SELECT LOWER(channel) AS ch, channel FROM a) SELECT ch, COUNT(*) AS n FROM b WHERE channel IN ('Direct','Organic') GROUP BY ch`],
    ['R2b', `SELECT ch, COUNT(*) AS n FROM (SELECT * REPLACE (LOWER(channel) AS ch) FROM ${T}) WHERE channel != 'x' GROUP BY ch`],
    ['R2c', `SELECT s.ch, COUNT(*) AS n FROM ${T} s WHERE s.ch = 'Direct' GROUP BY s.ch`],
    ['R2d', `SELECT sessions.ch, COUNT(*) AS n FROM ${T} WHERE sessions.ch = 'Direct' GROUP BY sessions.ch`],
  ])('S8 review probe %s: a WHERE on a sibling of the dimension\'s base column', (_id, sql) => {
    expectReject(sql, result(three), 'where_on_dimension');
  });

  it.each([
    ['C2-1', `SELECT ch, COUNT(*) AS n FROM ${T} s WHERE TO_JSON_STRING(s) LIKE '%Direct%' GROUP BY ch`],
    ['C2-2', `SELECT ch, COUNT(*) AS n FROM ${T} WHERE TO_JSON_STRING(sessions) LIKE '%Direct%' GROUP BY ch`],
    ['C2-3', `SELECT ch, COUNT(*) AS n FROM (SELECT LOWER(channel) AS ch FROM ${T}) t WHERE TO_JSON_STRING(t) LIKE '%direct%' GROUP BY ch`],
    ['C2-4', `SELECT ch, COUNT(*) AS n FROM (SELECT TO_JSON_STRING(t) AS j, LOWER(channel) AS ch FROM ${T} t) WHERE j LIKE '%Direct%' GROUP BY ch`],
    ['C2-5', `SELECT s.ch, COUNT(*) AS n FROM ${T} s WHERE TO_JSON_STRING(s) LIKE '%Direct%' GROUP BY s.ch`],
    ['C2-6', `SELECT sessions.ch, COUNT(*) AS n FROM ${T} WHERE TO_JSON_STRING(sessions) LIKE '%Direct%' GROUP BY sessions.ch`],
    ['C2-7', `WITH c AS (SELECT s AS r, channel AS ch FROM ${T} s) SELECT ch, COUNT(*) AS n FROM c WHERE TO_JSON_STRING(r) LIKE '%Direct%' GROUP BY ch`],
    ['C2-8', `SELECT s.ch, COUNT(*) AS n FROM ${T} s WHERE sessions.ch = 'Direct' GROUP BY s.ch`],
  ])('S8 review probe %s: a WHERE on a whole-row range variable', (_id, sql) => {
    expectReject(sql, result(three), 'where_on_dimension');
  });

  it.each([
    ['C3-1', `SELECT JSON_VALUE(TO_JSON_STRING(s), '$.channel') AS ch, COUNT(*) AS n FROM ${T} s WHERE channel != 'Direct' GROUP BY ch`],
    ['C3-2', `SELECT JSON_VALUE(TO_JSON_STRING(sessions), '$.channel') AS ch, COUNT(*) AS n FROM ${T} WHERE channel != 'Direct' GROUP BY ch`],
    ['C3-3', `SELECT JSON_VALUE(TO_JSON_STRING(t), '$.channel') AS ch, COUNT(*) AS n FROM (SELECT channel, d FROM ${T}) t WHERE channel = 'Direct' GROUP BY ch`],
    ['C3-4', `SELECT JSON_VALUE(TO_JSON_STRING(t), '$.channel') AS ch, COUNT(*) AS n FROM (SELECT channel, d FROM ${T} WHERE channel = 'Direct') t GROUP BY ch`],
    ['C3-5', `SELECT JSON_VALUE(TO_JSON_STRING(STRUCT(s.*)), '$.channel') AS ch, COUNT(*) AS n FROM ${T} s WHERE channel != 'Direct' GROUP BY ch`],
  ])('S8 review probe %s: a whole-row reference in the dimension expression', (_id, sql) => {
    expectReject(sql, result(three), 'where_on_dimension');
  });

  it('S4 review probe C3-S4: a whole-row reference inside SUM fails closed', () => {
    expectReject(
      `SELECT ch, SUM(CAST(JSON_VALUE(TO_JSON_STRING(s), '$.bounce_rate') AS INT64)) AS n FROM ${T} s GROUP BY ch`,
      result(three), 'sum_non_additive_column',
    );
  });

  it('S8 review probe R2a: a WHERE on a second alias of the dimension\'s base column', () => {
    expectReject(`${R2A_CTE} WHERE b != 'Direct' GROUP BY a`, result(three, { names: ['a', 'n'] }), 'where_on_dimension');
  });

  it('S8: a qualifier that is not the FROM item (struct access) stays tracked', () => {
    expectReject(
      `SELECT ch, COUNT(*) AS n FROM ${T} WHERE ch.x = 'a' GROUP BY ch`,
      result(three), 'where_on_dimension',
    );
  });

  it('R-29: one row', () => {
    expectReject(`SELECT ch, COUNT(*) AS n FROM ${T} GROUP BY ch`, result([['a', 1]]), 'row_count');
  });

  it('R-30: 25 rows, not truncated (display cap)', () => {
    expectReject(`SELECT ch, COUNT(*) AS n FROM ${T} GROUP BY ch`, result(rowsOf(25)), 'row_count');
  });

  it('R-31: runner cap hit', () => {
    expectReject(
      `SELECT ch, COUNT(*) AS n FROM ${T} GROUP BY ch`,
      result(rowsOf(20), { truncated: true, totalRows: 5000 }), 'result_truncated',
    );
  });

  it('R1: rows.length !== totalRows even without truncated', () => {
    expectReject(`SELECT ch, COUNT(*) AS n FROM ${T} GROUP BY ch`, result(rowsOf(3), { totalRows: 4 }), 'result_truncated');
  });

  it('R-32: unparseable SQL (pipe syntax)', () => {
    expectReject(`FROM ${T} |> AGGREGATE COUNT(*) AS n GROUP BY ch`, result(three), 'parse_failed');
  });

  it('R-32b: TABLESAMPLE fails to parse', () => {
    expectReject(`SELECT ch, COUNT(*) AS n FROM ${T} TABLESAMPLE SYSTEM (10 PERCENT) GROUP BY ch`, result(three), 'parse_failed');
  });

  it('R-32c: PIVOT parses but is not a plain row source', () => {
    expectReject(`SELECT ch, COUNT(*) AS n FROM ${T} PIVOT (SUM(x) FOR k IN ('a')) GROUP BY ch`, result(three), 'row_source');
  });

  it('SUM(DISTINCT x) does not parse on 5.4.0 and so is rejected', () => {
    expectReject(`SELECT ch, SUM(DISTINCT x) AS n FROM ${T} GROUP BY ch`, result(three), 'parse_failed');
  });

  it('R-33: a column already named share', () => {
    expectReject(`SELECT ch, COUNT(*) AS share FROM ${T} GROUP BY ch`, result(three, { names: ['ch', 'Share'] }), 'column_name_collision');
  });

  it('duplicate column names collide', () => {
    const res: QueryResult = {
      rows: [{ ch: 'a' }, { ch: 'b' }], columnNames: ['ch', 'ch'], columnTypes: ['STRING', 'INT64'],
      totalRows: 2, bytesProcessed: 0, truncated: false,
    };
    expectReject(`SELECT ch, COUNT(*) AS ch FROM ${T} GROUP BY 1`, res, 'column_name_collision');
  });

  it('R-34: an internal throw returns internal_error', () => {
    const res = result(three);
    Object.defineProperty(res, 'rows', { get() { throw new Error('boom'); } });
    expectReject(`SELECT ch, COUNT(*) AS n FROM ${T} GROUP BY ch`, res, 'internal_error');
  });

  it('R-36: two statements', () => {
    expectReject(`SELECT ch, COUNTIF(x) AS n FROM ${T} GROUP BY ch; SELECT 1`, result(three), 'parse_failed');
  });

  it('R-37: scalar subquery in the select list', () => {
    expectReject(`SELECT ch, (SELECT COUNT(*) FROM \`proj.ds.u\`) AS n FROM ${T} GROUP BY ch`, result(three), 'measure_not_additive');
  });

  it('a user-defined (dataset-qualified) COUNTIF is not trusted', () => {
    expectReject(`SELECT ch, myds.COUNTIF(x) AS n FROM ${T} GROUP BY ch`, result(three), 'measure_not_additive');
  });

  it('a CTE that aggregates without GROUP BY is not row-preserving', () => {
    expectReject(
      `WITH s AS (SELECT ch, COUNTIF(x) AS c FROM ${T}) SELECT ch, COUNT(*) AS n FROM s GROUP BY ch`,
      result(three), 'row_source',
    );
  });

  it('a CTE with a window function is not row-preserving', () => {
    expectReject(
      `WITH s AS (SELECT ch, ROW_NUMBER() OVER (ORDER BY d) AS rn FROM ${T}) SELECT ch, COUNT(*) AS n FROM s GROUP BY ch`,
      result(three), 'row_source',
    );
  });

  it('a CTE with GROUP BY is not row-preserving', () => {
    expectReject(
      `WITH s AS (SELECT ch, d FROM ${T} GROUP BY ch, d) SELECT ch, COUNT(*) AS n FROM s GROUP BY ch`,
      result(three), 'row_source',
    );
  });

  it('a CTE with a user-defined function is not trusted', () => {
    expectReject(
      `WITH s AS (SELECT ch, myds.agg(x) AS a FROM ${T}) SELECT ch, COUNT(*) AS n FROM s GROUP BY ch`,
      result(three), 'row_source',
    );
  });

  it('an alias that disagrees with the result column name', () => {
    expectReject(`SELECT ch AS channel, COUNT(*) AS n FROM ${T} GROUP BY 1`, result(three), 'group_by_shape');
  });

  it('the AST dimension must be the column the types call the dimension', () => {
    const res: QueryResult = {
      rows: three.map(([d, m]) => ({ n: d, ch: m })),
      columnNames: ['ch', 'n'], columnTypes: ['INT64', 'STRING'],
      totalRows: 3, bytesProcessed: 0, truncated: false,
    };
    expectReject(`SELECT ch, COUNT(*) AS n FROM ${T} GROUP BY ch`, res, 'group_by_shape');
  });

  it('an out-of-range GROUP BY ordinal', () => {
    expectReject(`SELECT ch, COUNT(*) AS n FROM ${T} GROUP BY 3`, result(three), 'group_by_shape');
  });

  it('a non-literal LIMIT', () => {
    expectReject(`SELECT ch, COUNT(*) AS n FROM ${T} GROUP BY ch LIMIT @n`, result(three), 'limit_applied');
  });
});

const F = '`proj.ds.fact`';
const D = '`proj.ds.dim`';
const SK = 'proj.ds.sessions.session_key';
const DK = 'proj.ds.dim.k';
const FSK = 'proj.ds.fact.session_key';
const lab = (pairs: Pair[] = three) => result(pairs, { names: ['label', 'n'] });

function verifyK(sql: string, res: QueryResult, uniqueKeys: string[]): CompositionVerdict {
  return verifyComposition({ sql, result: res, maxDisplayRows: 20, uniqueKeys });
}

function expectRejectK(sql: string, res: QueryResult, keys: string[], reason: string): void {
  expect(verifyK(sql, res, keys)).toEqual({ eligible: false, reason });
}

function expectEligibleK(sql: string, res: QueryResult, keys: string[]) {
  const v = verifyK(sql, res, keys);
  if (!v.eligible) throw new Error(`expected eligible, got ${v.reason}`);
  return v;
}

describe('verifyComposition v1.1: COUNT(DISTINCT unique key)', () => {
  const CD = (from: string, col = 'session_key') => `SELECT ch, COUNT(DISTINCT ${col}) n FROM ${from} GROUP BY ch`;

  it('U1: COUNT(DISTINCT unique key) is a count and records the key', () => {
    const v = expectEligibleK(CD(T), result(three), [SK]);
    expect(v.measureKind).toBe('count');
    expect(v.total).toBe('360');
    expect(v.usedUniqueKeys).toEqual([SK]);
  });

  it('U1: column names match case-insensitively; usedUniqueKeys carries the column lower-cased', () => {
    const v = expectEligibleK(CD(T, 'Session_Key'), result(three), ['proj.ds.sessions.SESSION_KEY']);
    expect(v.usedUniqueKeys).toEqual([SK]);
  });

  it('U1: table names are case-sensitive (BigQuery), so a key on a differently cased table never vouches', () => {
    expectRejectK(CD('`Proj.DS.Sessions`'), result(three), [SK], 'count_distinct');
    expectRejectK(CD(T), result(three), ['PROJ.DS.SESSIONS.session_key'], 'count_distinct');
    expect(expectEligibleK(CD('`proj.ds.Sessions`'), result(three), ['proj.ds.Sessions.session_key']).usedUniqueKeys)
      .toEqual(['proj.ds.Sessions.session_key']);
    expectRejectK(CD('proj.ds.Sessions'), result(three), [SK], 'count_distinct');
    expectEligibleK(CD('proj.ds.Sessions'), result(three), ['proj.ds.Sessions.session_key']);
  });

  it('U1: an unquoted 3-part name and an own-qualified column match', () => {
    expectEligibleK('SELECT ch, COUNT(DISTINCT s.session_key) n FROM proj.ds.sessions s GROUP BY ch', result(three), [SK]);
  });

  it('U2: without the key it stays count_distinct', () => {
    expectRejectK(CD(T), result(three), [], 'count_distinct');
  });

  it('U3: the key on a different table stays count_distinct', () => {
    expectRejectK(CD(T), result(three), ['proj.ds.events.session_key'], 'count_distinct');
  });

  it.each([
    ['SELECT * with a WHERE', `WITH s AS (SELECT * FROM ${T} WHERE d >= '2024-01-01') ${CD('s')}`],
    ['the column un-renamed with a WHERE', `WITH s AS (SELECT ch, session_key FROM ${T} WHERE d >= '2024-01-01') ${CD('s')}`],
    ['a derived table, qualified', `SELECT ch, COUNT(DISTINCT t.session_key) n FROM (SELECT ch, session_key AS session_key FROM ${T}) t GROUP BY ch`],
    ['two passthrough CTEs', `WITH a AS (SELECT * FROM ${T}), b AS (SELECT ch, a.session_key FROM a) ${CD('b')}`],
  ])('U4: the key through a passthrough source (%s) is eligible', (_id, sql) => {
    expect(expectEligibleK(sql, result(three), [SK]).usedUniqueKeys).toEqual([SK]);
  });

  it.each([
    ['renames', `WITH s AS (SELECT ch, user_id AS session_key FROM ${T}) ${CD('s')}`],
    ['transforms', `WITH s AS (SELECT ch, LOWER(session_key) AS session_key FROM ${T}) ${CD('s')}`],
    ['produces it twice', `WITH s AS (SELECT *, user_id AS session_key FROM ${T}) ${CD('s')}`],
    ['drops it', `WITH s AS (SELECT ch FROM ${T}) ${CD('s')}`],
    ['takes it from another qualifier', `WITH s AS (SELECT ch, x.session_key FROM ${T} t) ${CD('s')}`],
  ])('U4: a CTE that %s the key gives count_distinct', (_id, sql) => {
    expectRejectK(sql, result(three), [SK], 'count_distinct');
  });

  it('U4: a CTE with GROUP BY gives row_source', () => {
    expectRejectK(`WITH s AS (SELECT ch, session_key FROM ${T} GROUP BY ch, session_key) ${CD('s')}`, result(three), [SK], 'row_source');
  });

  it('U5: a 2-part reference never matches', () => {
    expectRejectK(CD('`ds.sessions`'), result(three), [SK], 'count_distinct');
    expectRejectK(CD('ds.sessions'), result(three), [SK], 'count_distinct');
    expectRejectK(CD('sessions'), result(three), [SK], 'count_distinct');
  });

  it.each([
    ['an expression', CD(T, 'LOWER(session_key)')],
    ['a struct-field (foreign qualifier)', CD(T, 'x.session_key')],
  ])('COUNT(DISTINCT %s) stays count_distinct', (_id, sql) => {
    expectRejectK(sql, result(three), [SK], 'count_distinct');
  });

  // A case-insensitive collation merges distinct key values ('A', 'a') that may sit in different groups.
  it.each([
    ['on the COUNT(DISTINCT) argument', CD(T, "session_key COLLATE 'und:ci'")],
    ['in a passthrough CTE, aliased', `WITH s AS (SELECT ch, session_key COLLATE 'und:ci' AS session_key FROM ${T}) ${CD('s')}`],
    ['in a passthrough CTE, unaliased', `WITH s AS (SELECT ch, session_key COLLATE 'und:ci' FROM ${T}) ${CD('s')}`],
  ])('COLLATE %s gives count_distinct', (_id, sql) => {
    expectRejectK(sql, result(three), [SK], 'count_distinct');
  });

  it('U10: a CTE named like a unique-keyed base table never matches the key', () => {
    expectRejectK(`WITH sessions AS (SELECT * FROM \`proj.ds.events\`) ${CD('sessions')}`, result(three), [SK], 'count_distinct');
  });

  it('R-8/R-9/R-10 with keys present: other columns and APPROX stay count_distinct', () => {
    expectRejectK(`SELECT ch, COUNT(DISTINCT user_pseudo_id) AS n FROM ${T} GROUP BY ch`, result(three), [SK], 'count_distinct');
    expectRejectK(`SELECT ch, APPROX_COUNT_DISTINCT(session_key) AS n FROM ${T} GROUP BY ch`, result(three), [SK], 'count_distinct');
  });

  it('a plain COUNT(*) records no keys even when keys are supplied', () => {
    expect(expectEligibleK(`SELECT ch, COUNT(*) n FROM ${T} GROUP BY ch`, result(three), [SK]).usedUniqueKeys).toEqual([]);
  });
});

describe('verifyComposition v1.1: many-to-one LEFT JOIN', () => {
  const J = (join: string, tail = 'GROUP BY d.label', measure = 'COUNT(*)') =>
    `SELECT d.label, ${measure} AS n FROM ${F} f ${join} ${tail}`;
  const ON = `LEFT JOIN ${D} d ON f.k = d.k`;

  it.each([
    ['right-side column', 'SUM(d.credit_limit)'],
    ['right-side column inside an expression', 'SUM(f.amount + d.credit_limit)'],
    ['unqualified column', 'SUM(amount)'],
  ])('U6b: a SUM over a %s in a join query rejects (a right value repeats once per left row)', (_n, measure) => {
    const v = verifyComposition({ sql: J(ON, 'GROUP BY d.label', measure), result: lab(), uniqueKeys: [DK] });
    expect(v).toEqual({ eligible: false, reason: 'sum_joined_column' });
  });

  it('U6c: a SUM over a left-side column in a join query stays eligible', () => {
    expect(expectEligibleK(J(ON, 'GROUP BY d.label', 'SUM(f.amount)'), lab(), [DK]).measureKind).toBe('sum');
  });

  it('U6: LEFT JOIN on a unique right key is eligible and records the key', () => {
    const v = expectEligibleK(J(ON), lab(), [DK]);
    expect(v.measureKind).toBe('count');
    expect(v.usedUniqueKeys).toEqual([DK]);
  });

  it.each([
    ['USING', `LEFT JOIN ${D} d USING (k)`],
    ['LEFT OUTER JOIN', `LEFT OUTER JOIN ${D} d ON f.k = d.k`],
    ['reversed ON', `LEFT JOIN ${D} d ON d.k = f.k`],
    ['parenthesised ON', `LEFT JOIN ${D} d ON (f.k = d.k)`],
    ['unquoted 3-part names', `LEFT JOIN proj.ds.dim d ON f.k = d.k`],
  ])('U7: %s is eligible', (_id, join) => {
    expect(expectEligibleK(J(join), lab(), [DK]).usedUniqueKeys).toEqual([DK]);
  });

  it('U6: SUM across the join and an ordinal GROUP BY are eligible', () => {
    const v = expectEligibleK(J(ON, 'GROUP BY 1', 'SUM(f.revenue)'), lab(), [DK]);
    expect(v.measureKind).toBe('sum');
  });

  it('Ruling 3: a NULL label from unmatched rows is a legitimate group', () => {
    expect(expectEligibleK(J(ON), lab([['a', 3], [null, 2]]), [DK]).total).toBe('5');
  });

  it.each([
    ['right key not unique', ON, []],
    ['only the left key unique', ON, ['proj.ds.fact.k']],
    ['INNER JOIN', `INNER JOIN ${D} d ON f.k = d.k`, [DK]],
    ['plain JOIN', `JOIN ${D} d ON f.k = d.k`, [DK]],
    ['RIGHT JOIN', `RIGHT JOIN ${D} d ON f.k = d.k`, [DK]],
    ['FULL JOIN', `FULL OUTER JOIN ${D} d ON f.k = d.k`, [DK]],
    ['CROSS JOIN', `CROSS JOIN ${D} d`, [DK]],
    ['comma join', `, ${D} d`, [DK]],
    ['AND-compound ON', `LEFT JOIN ${D} d ON f.k = d.k AND f.x = d.x`, [DK]],
    ['<> ON', `LEFT JOIN ${D} d ON f.k <> d.k`, [DK]],
    ['ON on two right columns', `LEFT JOIN ${D} d ON d.k = d.k2`, [DK]],
    ['ON on two left columns', `LEFT JOIN ${D} d ON f.k = f.k2`, [DK]],
    ['ON on a struct field of the key', `LEFT JOIN ${D} d ON f.k = d.k.x`, [DK]],
    ['ON on an unqualified column', `LEFT JOIN ${D} d ON k = d.k`, [DK]],
    ['ON against a literal', `LEFT JOIN ${D} d ON d.k = 'a'`, [DK]],
    ['USING two columns', `LEFT JOIN ${D} d USING (k, j)`, [DK, 'proj.ds.dim.j']],
    ['a subquery on the right side', `LEFT JOIN (SELECT * FROM ${D}) d ON f.k = d.k`, [DK]],
    ['a 2-part right table', `LEFT JOIN \`ds.dim\` d ON f.k = d.k`, [DK]],
    ['a second join whose right key is not unique', `${ON} LEFT JOIN \`proj.ds.e\` e ON d.e = e.id`, [DK]],
    ['a second join keyed on a later source', `LEFT JOIN ${D} d ON e.id = d.k LEFT JOIN \`proj.ds.e\` e ON f.e = e.id`, [DK, 'proj.ds.e.id']],
    ['an UNNEST join', `LEFT JOIN UNNEST(f.arr) d`, [DK]],
    ['a right table cased differently from its declared key', `LEFT JOIN \`proj.ds.Dim\` d ON f.k = d.k`, [DK]],
  ])('U8: %s gives row_source', (_id, join, keys) => {
    expectRejectK(J(join), lab(), keys, 'row_source');
  });

  it.each(['proj.rec.arr', '`proj.rec.arr`', 'PROJ.rec.arr'])('U8: a correlated array path %s (head = an earlier alias) gives row_source', (path) => {
    expectRejectK(
      `SELECT x.label, COUNT(*) n FROM ${F} proj LEFT JOIN ${path} x ON proj.k = x.k GROUP BY x.label`,
      lab(), ['proj.rec.arr.k'], 'row_source',
    );
  });

  it('U8: a right side that is a CTE name gives row_source', () => {
    expectRejectK(`WITH dim AS (SELECT * FROM ${D}) ${J('LEFT JOIN dim d ON f.k = d.k')}`, lab(), [DK], 'row_source');
  });

  it('U8: a join inside a CTE still gives row_source', () => {
    expectRejectK(
      `WITH s AS (SELECT f.*, d.label FROM ${F} f LEFT JOIN ${D} d ON f.k = d.k) SELECT label, COUNT(*) n FROM s GROUP BY label`,
      lab(), [DK], 'row_source',
    );
  });

  it('a second join on a unique key is eligible; usedUniqueKeys is sorted', () => {
    const v = expectEligibleK(J(`${ON} LEFT JOIN \`proj.ds.e\` e ON d.e = e.id`), lab(), [DK, 'proj.ds.e.id']);
    expect(v.usedUniqueKeys).toEqual([DK, 'proj.ds.e.id']);
  });

  it('Ruling 5: usedUniqueKeys is deduped, column lower-cased and sorted', () => {
    const v = expectEligibleK(
      J(`LEFT JOIN ${D} d ON f.k = d.k LEFT JOIN ${D} d2 ON f.k2 = d2.k`, 'GROUP BY d.label', 'COUNT(DISTINCT f.session_key)'),
      lab(), ['proj.ds.fact.SESSION_KEY', DK],
    );
    expect(v.usedUniqueKeys).toEqual([DK, FSK]);
  });

  it('U9: COUNT(DISTINCT f.session_key) across a valid LEFT JOIN with both keys unique', () => {
    const v = expectEligibleK(J(ON, 'GROUP BY d.label', 'COUNT(DISTINCT f.session_key)'), lab(), [FSK, DK]);
    expect(v.measureKind).toBe('count');
    expect(v.usedUniqueKeys).toEqual([DK, FSK]);
  });

  it.each([
    ['the left key not unique', 'COUNT(DISTINCT f.session_key)', [DK]],
    ['a right-side unique key (repeats across fact rows)', 'COUNT(DISTINCT d.k)', [FSK, DK]],
    ['an unqualified column in a join', 'COUNT(DISTINCT session_key)', [FSK, DK]],
  ])('U9: COUNT(DISTINCT) with %s gives count_distinct', (_id, measure, keys) => {
    expectRejectK(J(ON, 'GROUP BY d.label', measure), lab(), keys, 'count_distinct');
  });

  it('U9: the left source may be a passthrough CTE', () => {
    const v = expectEligibleK(
      `WITH s AS (SELECT * FROM ${F} WHERE d >= '2024') SELECT d.label, COUNT(DISTINCT f.session_key) n FROM s f ${ON} GROUP BY d.label`,
      lab(), [FSK, DK],
    );
    expect(v.usedUniqueKeys).toEqual([DK, FSK]);
  });

  it.each([
    ['WHERE f.d', "WHERE f.d >= '2024-01-01'"],
    ['WHERE f.label (a different base column)', "WHERE f.label = 'x'"],
  ])('Ruling 2: %s with dimension d.label is eligible', (_id, where) => {
    expectEligibleK(J(ON, `${where} GROUP BY d.label`), lab(), [DK]);
  });

  // I1: the right row is a function of the join key, so a unique-joined namespace (all its columns plus the
  // left columns ON/USING-linked to it) is one dimension group: a WHERE reaching the group rejects.
  it.each([
    ['WHERE on a right sibling', "WHERE d.region = 'EU'"],
    ['WHERE on the join key', "WHERE f.k IN ('a', 'b')"],
    ['WHERE on the right key', "WHERE d.k IN ('a', 'b')"],
  ])('I1: %s with dimension d.label rejects with where_on_dimension', (_id, where) => {
    expectRejectK(J(ON, `${where} GROUP BY d.label`), lab(), [DK], 'where_on_dimension');
  });

  describe('I1: a unique-joined namespace is one dimension group', () => {
    const SJ = 'FROM `proj.ds.sessions` s LEFT JOIN `proj.ds.countries` c ON s.country_code = c.code';
    const CK = ['proj.ds.countries.code'];

    it.each([
      ['row 1: left join-key dimension, WHERE on a right column', "SELECT s.country_code AS label, COUNT(*) n " + SJ + " WHERE c.continent = 'Europe' GROUP BY 1"],
      ['row 2: right key dimension, WHERE on a right column', "SELECT c.code AS label, COUNT(*) n " + SJ + " WHERE c.continent = 'Europe' GROUP BY 1"],
      ['row 3: right dimension, WHERE on the left join key', "SELECT c.country_name AS label, COUNT(*) n " + SJ + " WHERE s.country_code IN ('US', 'CA') GROUP BY 1"],
      ['row 4: right dimension, WHERE on the right key', "SELECT c.country_name AS label, COUNT(*) n " + SJ + " WHERE c.code IN ('US', 'CA') GROUP BY 1"],
      ['a right sibling', "SELECT c.country_name AS label, COUNT(*) n " + SJ + " WHERE c.continent = 'Europe' GROUP BY 1"],
      ['USING: right dimension, WHERE on the left key', "SELECT c.country_name AS label, COUNT(*) n FROM `proj.ds.sessions` s LEFT JOIN `proj.ds.countries` c USING (code) WHERE s.code IN ('US') GROUP BY 1"],
      ['a left CTE WHERE on the join key', "WITH t AS (SELECT * FROM `proj.ds.sessions` WHERE country_code != 'US') SELECT c.country_name AS label, COUNT(*) n FROM t s LEFT JOIN `proj.ds.countries` c ON s.country_code = c.code GROUP BY 1"],
    ])('%s rejects with where_on_dimension', (_id, sql) => {
      expectRejectK(sql, lab(), CK, 'where_on_dimension');
    });

    describe('a second namespace linked through the first is in the same group', () => {
      const CHAIN = 'FROM `proj.ds.sessions` s'
        + ' LEFT JOIN `proj.ds.countries` c ON s.country_code = c.code'
        + ' LEFT JOIN `proj.ds.regions` r ON c.region_id = r.id';
      const RK = [...CK, 'proj.ds.regions.id'];

      it.each([
        ['a far-table dimension, WHERE on the middle table', "SELECT r.name AS label, COUNT(*) n " + CHAIN + " WHERE c.continent = 'Europe' GROUP BY 1"],
        ['a middle-table dimension, WHERE on the far table', "SELECT c.country_name AS label, COUNT(*) n " + CHAIN + " WHERE r.zone = 'x' GROUP BY 1"],
        ['a far-table dimension, WHERE on the left join key', "SELECT r.name AS label, COUNT(*) n " + CHAIN + " WHERE s.country_code IN ('US') GROUP BY 1"],
      ])('%s rejects with where_on_dimension', (_id, sql) => {
        expectRejectK(sql, lab(), RK, 'where_on_dimension');
      });

      it('a left non-key dimension with a WHERE on the far table stays eligible', () => {
        expectEligibleK(`SELECT s.channel AS label, COUNT(*) n ${CHAIN} WHERE r.zone = 'x' GROUP BY 1`, lab(), RK);
      });
    });

    it.each([
      ['a right-column WHERE', "WHERE c.continent = 'Europe'"],
      ['a left join-key WHERE', "WHERE s.country_code IN ('US', 'CA')"],
      ['another left column WHERE', "WHERE s.device = 'mobile'"],
    ])('a left non-key dimension (s.channel) with %s stays eligible (a row filter)', (_id, where) => {
      expectEligibleK(`SELECT s.channel AS label, COUNT(*) n ${SJ} ${where} GROUP BY 1`, lab(), CK);
    });

    it('a right dimension with a WHERE on an unlinked left column stays eligible', () => {
      expectEligibleK(`SELECT c.country_name AS label, COUNT(*) n ${SJ} WHERE s.device = 'mobile' GROUP BY 1`, lab(), CK);
    });
  });

  it.each([
    ['WHERE d.label', "WHERE d.label = 'x' GROUP BY d.label"],
    ['an unqualified WHERE label', "WHERE label = 'x' GROUP BY d.label"],
    ['an unqualified WHERE on any column', "WHERE region = 'x' GROUP BY d.label"],
    ['a foreign qualifier (struct access)', "WHERE label.x = 'x' GROUP BY d.label"],
    ['Ruling 1: TO_JSON_STRING(d) in a WHERE', "WHERE TO_JSON_STRING(d) LIKE '%x%' GROUP BY d.label"],
    ['Ruling 1: TO_JSON_STRING(f) in a WHERE', "WHERE TO_JSON_STRING(f) LIKE '%x%' GROUP BY d.label"],
  ])('Ruling 2: %s rejects with where_on_dimension', (_id, tail) => {
    expectRejectK(J(ON, tail), lab(), [DK], 'where_on_dimension');
  });

  it('Ruling 1: TO_JSON_STRING(d) inside the dimension rejects', () => {
    expectRejectK(
      `SELECT JSON_VALUE(TO_JSON_STRING(d), '$.label') AS label, COUNT(*) n FROM ${F} f ${ON} WHERE d.region = 'x' GROUP BY 1`,
      lab(), [DK], 'where_on_dimension',
    );
  });

  it('an unqualified dimension in a join rejects', () => {
    expectRejectK(`SELECT label, COUNT(*) n FROM ${F} f ${ON} GROUP BY label`, lab(), [DK], 'where_on_dimension');
  });

  it('the join key equality links the dimension: WHERE f.k with dimension d.k rejects', () => {
    expectRejectK(
      `SELECT d.k, COUNT(*) n FROM ${F} f ${ON} WHERE f.k IN ('a', 'b') GROUP BY d.k`,
      result(three, { names: ['k', 'n'] }), [DK], 'where_on_dimension',
    );
  });

  it('the join key equality links through the left CTE WHERE', () => {
    expectRejectK(
      `WITH s AS (SELECT * FROM ${F} WHERE k != 'a') SELECT d.k, COUNT(*) n FROM s f ${ON} GROUP BY d.k`,
      result(three, { names: ['k', 'n'] }), [DK], 'where_on_dimension',
    );
  });

  it('a left-side dimension traced through a CTE WHERE rejects', () => {
    expectRejectK(
      `WITH s AS (SELECT k, channel AS ch FROM ${F} WHERE channel != 'x') SELECT f.ch, COUNT(*) n FROM s f ${ON} GROUP BY f.ch`,
      result(three), [DK], 'where_on_dimension',
    );
  });

  describe('Ruling 4: self-join', () => {
    const SELF = 'FROM `proj.ds.t` c LEFT JOIN `proj.ds.t` p ON c.parent_id = p.id';
    const TK = ['proj.ds.t.id'];

    // The left and right rows may be the same row (`c.id = p.id`), so a WHERE on c could filter p's
    // dimension; the left base table also appearing on the right fails closed.
    it.each([
      ['a WHERE on the other row', "WHERE c.label = 'x'"],
      ['a WHERE on the dimension side', "WHERE p.label = 'x'"],
      ['no WHERE', ''],
    ])('a self-join on a unique right key with %s gives row_source (no crash, no bypass)', (_id, where) => {
      expectRejectK(`SELECT p.label, COUNT(*) n ${SELF} ${where} GROUP BY p.label`, lab(), TK, 'row_source');
    });

    it('the left base table reached through a CTE and joined again gives row_source', () => {
      expectRejectK(
        `WITH c AS (SELECT * FROM \`proj.ds.t\`) SELECT p.label, COUNT(*) n FROM c LEFT JOIN \`proj.ds.t\` p ON c.id = p.id WHERE c.label = 'x' GROUP BY p.label`,
        lab(), TK, 'row_source',
      );
    });

    it('the same right table joined twice shares one namespace: a WHERE on d2.label rejects', () => {
      expectRejectK(
        `SELECT d.label, COUNT(*) n FROM ${F} f LEFT JOIN ${D} d ON f.k = d.k LEFT JOIN ${D} d2 ON f.k = d2.k WHERE d2.label = 'x' GROUP BY d.label`,
        lab(), [DK], 'where_on_dimension',
      );
    });

    it('the same right table joined twice is eligible with a WHERE on an unrelated column', () => {
      expectEligibleK(
        `SELECT d.label, COUNT(*) n FROM ${F} f LEFT JOIN ${D} d ON f.k = d.k LEFT JOIN ${D} d2 ON f.k2 = d2.k WHERE f.x = 'x' GROUP BY d.label`,
        lab(), [DK],
      );
    });

    it('a self-join whose right key is not unique gives row_source', () => {
      expectRejectK(
        'SELECT p.label, COUNT(*) n FROM `proj.ds.t` c LEFT JOIN `proj.ds.t` p ON c.id = p.parent_id GROUP BY p.label',
        lab(), TK, 'row_source',
      );
    });

    it('an unaliased self-join (colliding qualifiers) gives row_source', () => {
      expectRejectK(
        'SELECT t.label, COUNT(*) n FROM `proj.ds.t` LEFT JOIN `proj.ds.t` ON t.parent_id = t.id GROUP BY t.label',
        lab(), TK, 'row_source',
      );
    });

    it('an alias that collides with the other table name gives row_source', () => {
      expectRejectK(
        `SELECT fact.label, COUNT(*) n FROM ${F} LEFT JOIN ${D} fact ON fact.k = fact.k GROUP BY fact.label`,
        lab(), [DK], 'row_source',
      );
    });
  });
});
