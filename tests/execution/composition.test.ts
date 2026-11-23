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
    'ROUND(SUM(x), 2)',
    'CAST(SUM(x) AS INT64)',
    'SAFE_CAST(SUM(x) AS NUMERIC)',
    'IFNULL(SUM(x), 0)',
    'COALESCE(SUM(x), 0)',
    'ROUND(IFNULL(SUM(x), 0), 2)',
  ])('A4: allow-listed wrapper %s', (measure) => {
    const v = expectEligible(`SELECT ch, ${measure} AS n FROM ${T} GROUP BY ch`, result(three));
    expect(v.measureKind).toBe('sum');
    expect(v.total).toBe('360');
  });

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

  it.each(['SUM(conversion_rate)', 'SUM(daily_users)', 'SUM(pct_new)', 'SUM(t.avg_time)'])('R-13: %s', (measure) => {
    expectReject(`SELECT ch, ${measure} AS n FROM ${T} t GROUP BY ch`, result(three), 'sum_non_additive_column');
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
  ])('S8 review probe %s: a WHERE on a whole-row range variable', (_id, sql) => {
    expectReject(sql, result(three), 'where_on_dimension');
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
