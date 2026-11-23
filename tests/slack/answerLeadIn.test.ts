import { describe, it, expect } from 'vitest';
import { computeLeadIn, buildAnswerCaptionBlocks } from '../../src/slack/answerLeadIn.js';

// The caption needs the BigQuery schema. The *WithInferredTypes helpers give fixtures that don't pass one the
// types BigQuery would report for their cells: numeric-shaped → NUMERIC, else STRING.
type WithTypes = { rows: Record<string, unknown>[]; columnNames: string[]; columnTypes?: string[] };
const isNumericCell = (v: unknown) => typeof v === 'number' || typeof v === 'bigint' || (typeof v === 'object' && v !== null) || (typeof v === 'string' && /^\d+(\.\d+)?$/.test(v));
function typed<T extends WithTypes>(input: T): T {
  if ('columnTypes' in input) return input;
  return { ...input, columnTypes: input.columnNames.map((c) => (input.rows.every((r) => isNumericCell(r[c])) ? 'NUMERIC' : 'STRING')) };
}
const leadInWithInferredTypes = (input: Parameters<typeof computeLeadIn>[0]) => computeLeadIn(typed(input));
const captionWithInferredTypes = (input: Parameters<typeof buildAnswerCaptionBlocks>[0]) => buildAnswerCaptionBlocks(typed(input));

const COLS = ['session_default_channel_grouping', 'session_count'];
const channelRows = [
  { session_default_channel_grouping: 'Direct', session_count: 198 },
  { session_default_channel_grouping: 'Unassigned', session_count: 42 },
  { session_default_channel_grouping: 'Organic Search', session_count: 7 },
  { session_default_channel_grouping: 'Organic Social', session_count: 2 },
  { session_default_channel_grouping: 'Referral', session_count: 1 },
];
const SQL = 'SELECT session_default_channel_grouping, COUNT(DISTINCT session_key) AS session_count FROM t GROUP BY 1 ORDER BY 2 DESC';

const lead = (rows: Record<string, unknown>[], cols = COLS, opts: { truncated?: boolean; sql?: string } = {}) =>
  leadInWithInferredTypes({ rows, columnNames: cols, truncated: opts.truncated ?? false, sql: opts.sql ?? SQL });

describe('computeLeadIn — eligible shapes', () => {
  it('names the top row and the runner-up with their values', () => {
    expect(lead(channelRows)).toBe('*Direct* has the highest session count (198), followed by Unassigned (42).');
  });

  it('ranks across all rows, not just the first (unsorted input)', () => {
    const shuffled = [channelRows[2], channelRows[0], channelRows[4], channelRows[1]];
    expect(lead(shuffled)).toBe('*Direct* has the highest session count (198), followed by Unassigned (42).');
  });

  it('accepts the measure in either column position', () => {
    const rows = channelRows.map((r) => ({ session_count: r.session_count, session_default_channel_grouping: r.session_default_channel_grouping }));
    expect(lead(rows, ['session_count', 'session_default_channel_grouping'])).toMatch(/^\*Direct\* has the highest session count \(198\)/);
  });

  it('accepts numeric strings (INT64 / NUMERIC as text) and keeps the original text', () => {
    const rows = [
      { channel: 'Email', revenue: '1200.50' },
      { channel: 'Paid Search', revenue: '980' },
    ];
    expect(lead(rows, ['channel', 'revenue'])).toBe('*Email* has the highest revenue (1200.50), followed by Paid Search (980).');
  });

  it('accepts big.js-like numeric objects via their string form', () => {
    const big = (s: string) => ({ toString: () => s, toJSON: () => s });
    const rows = [
      { channel: 'Email', revenue: big('15.25') },
      { channel: 'Paid', revenue: big('3') },
    ];
    expect(lead(rows, ['channel', 'revenue'])).toBe('*Email* has the highest revenue (15.25), followed by Paid (3).');
  });

  it('drops the runner-up clause when second place is tied', () => {
    const rows = [
      { channel: 'A', sessions: 10 },
      { channel: 'B', sessions: 5 },
      { channel: 'C', sessions: 5 },
    ];
    expect(lead(rows, ['channel', 'sessions'])).toBe('*A* has the highest sessions (10).');
  });

  it('does not bold a label containing mrkdwn control characters, and escapes &<>', () => {
    const rows = [
      { page: 'a_b*c <x> & y', views: 9 },
      { page: 'home', views: 1 },
    ];
    expect(lead(rows, ['page', 'views'])).toBe('a_b*c &lt;x&gt; &amp; y has the highest views (9), followed by home (1).');
  });

  it.each([
    ['a bold-pair leader', '*Acme*', 'home'],
    ['an italic-pair leader', '_promo_', 'home'],
    ['a bold-pair runner-up', 'home', '*Acme*'],
    ['a strike-pair runner-up', 'home', '~old~'],
    ['a backtick label', 'a`b`c', 'home'],
  ])('stays silent for %s that would render as formatting', (_label, top, next) => {
    expect(lead([{ page: top, views: 9 }, { page: next, views: 1 }], ['page', 'views'])).toBeNull();
  });

  it('keeps the caption for intraword underscores, which render literally', () => {
    expect(lead([{ page: 'spring_sale_2026', views: 9 }, { page: 'home', views: 1 }], ['page', 'views']))
      .toBe('spring_sale_2026 has the highest views (9), followed by home (1).');
  });

  it('allows a LIMIT when the query orders descending (a genuine top-N)', () => {
    expect(lead(channelRows, COLS, { sql: `${SQL} LIMIT 5` })).toMatch(/^\*Direct\*/);
  });

  it('allows a top-N by measure name (qualified), with a tiebreaker and a trailing semicolon', () => {
    expect(lead(channelRows, COLS, { sql: `SELECT a, b FROM t ORDER BY t.session_count DESC, 1 ASC LIMIT 5;` })).toMatch(/^\*Direct\*/);
  });

  it('trims label whitespace so the bold renders', () => {
    expect(lead([{ c: ' Email ', n: 9 }, { c: 'Paid', n: 2 }], ['c', 'n'])).toBe('*Email* has the highest n (9), followed by Paid (2).');
  });

  it('allows a LIMIT that did not cut anything (fewer rows than the limit)', () => {
    expect(lead(channelRows, COLS, { sql: 'SELECT a, b FROM t GROUP BY 1 LIMIT 100' })).toMatch(/^\*Direct\*/);
  });
});

describe('computeLeadIn — stays silent when it cannot prove the claim', () => {
  it('fewer than two rows', () => {
    expect(lead(channelRows.slice(0, 1))).toBeNull();
  });

  it('not exactly two columns', () => {
    const rows = [{ a: 'x', b: 1, c: 2 }, { a: 'y', b: 2, c: 1 }];
    expect(lead(rows, ['a', 'b', 'c'])).toBeNull();
  });

  it('result truncated by the row cap (the true top may be missing)', () => {
    expect(lead(channelRows, COLS, { truncated: true })).toBeNull();
  });

  it('a LIMIT that may have cut rows without a descending order', () => {
    expect(lead(channelRows, COLS, { sql: 'SELECT a, b FROM t GROUP BY 1 LIMIT 5' })).toBeNull();
  });

  it('a bottom-N LIMIT whose only DESC sits in a CTE window', () => {
    const sql = `WITH s AS (SELECT channel, ROW_NUMBER() OVER (PARTITION BY u ORDER BY ts DESC) AS rn FROM t)
      SELECT session_default_channel_grouping, COUNT(*) AS session_count FROM s GROUP BY 1 ORDER BY session_count ASC LIMIT 5`;
    expect(lead(channelRows, COLS, { sql })).toBeNull();
  });

  it('a LIMIT ordered DESC by the label, or with DESC only on a tiebreaker', () => {
    expect(lead(channelRows, COLS, { sql: `SELECT a, b FROM t ORDER BY session_default_channel_grouping DESC LIMIT 5` })).toBeNull();
    expect(lead(channelRows, COLS, { sql: `SELECT a, b FROM t ORDER BY 1 ASC, session_count DESC LIMIT 5` })).toBeNull();
    expect(lead(channelRows, COLS, { sql: `SELECT a, b FROM t ORDER BY 1 DESC LIMIT 5` })).toBeNull();
  });

  it('an OFFSET (it may skip the real top row)', () => {
    expect(lead(channelRows, COLS, { sql: `${SQL} LIMIT 5 OFFSET 5` })).toBeNull();
    expect(lead(channelRows, COLS, { sql: `${SQL} LIMIT 100 OFFSET 1` })).toBeNull();
  });

  it('a QUALIFY or window filter (it can keep a bottom-N with no LIMIT)', () => {
    expect(lead(channelRows, COLS, { sql: `SELECT a, b FROM t GROUP BY 1 QUALIFY ROW_NUMBER() OVER (ORDER BY b ASC) <= 4` })).toBeNull();
    expect(lead(channelRows, COLS, { sql: `SELECT a, b FROM (SELECT a, b, ROW_NUMBER() OVER(ORDER BY b) AS rn FROM t) WHERE rn <= 4` })).toBeNull();
    expect(lead(channelRows, COLS, { sql: `SELECT a, b FROM t GROUP BY 1 QUALIFY RANK() OVER w <= 4 WINDOW w AS (ORDER BY b)` })).toBeNull();
    expect(lead(channelRows, COLS, { sql: `SELECT a, b FROM (SELECT a, b, ROW_NUMBER() OVER w AS rn FROM t WINDOW w AS (ORDER BY b)) WHERE rn <= 4` })).toBeNull();
    // A window keyword only inside a string or comment is inert.
    expect(lead(channelRows, COLS, { sql: `${SQL} -- QUALIFY OVER (` })).not.toBeNull();
    expect(lead(channelRows, COLS, { sql: SQL.replace('FROM t', "FROM t WHERE note != 'QUALIFY OVER w WINDOW'") })).not.toBeNull();
  });

  it('a DESC that exists only in a comment', () => {
    expect(lead(channelRows, COLS, { sql: `SELECT a, b FROM t ORDER BY 2 -- DESC\n LIMIT 5` })).toBeNull();
  });

  it('a cutting LIMIT inside a subquery', () => {
    const sql = `SELECT * FROM (SELECT a, b FROM t ORDER BY 2 DESC LIMIT 5) ORDER BY 2 DESC`;
    expect(lead(channelRows, COLS, { sql })).toBeNull();
  });

  it('a LIMIT inside a CTE, even one larger than the final row count', () => {
    const cte = `WITH s AS (SELECT * FROM t LIMIT 100)
      SELECT session_default_channel_grouping, COUNT(*) AS session_count FROM s GROUP BY 1`;
    expect(lead(channelRows, COLS, { sql: cte })).toBeNull();
    expect(lead(channelRows, COLS, { sql: `${cte} ORDER BY 2 DESC LIMIT 5` })).toBeNull();
  });

  it('a non-literal LIMIT bound', () => {
    expect(lead(channelRows, COLS, { sql: `${SQL} LIMIT @n` })).toBeNull();
    expect(lead(channelRows, COLS, { sql: `${SQL} LIMIT (5)` })).toBeNull();
  });

  it('an apostrophe in a comment does not hide a later cutting LIMIT', () => {
    const sql = `SELECT a, b FROM t WHERE c = 'x' -- don't include bots\n GROUP BY 1 LIMIT 5 -- it's capped`;
    expect(lead(channelRows, COLS, { sql })).toBeNull();
  });

  it('repeated labels (un-aggregated rows)', () => {
    expect(lead([{ c: 'Alice', n: 198 }, { c: 'Alice', n: 42 }], ['c', 'n'])).toBeNull();
  });

  it('a label with a line break, or a one-element array measure', () => {
    expect(lead([{ c: 'A\nB', n: 9 }, { c: 'C', n: 2 }], ['c', 'n'])).toBeNull();
    expect(lead([{ c: 'A', n: [9] }, { c: 'C', n: 2 }], ['c', 'n'])).toBeNull();
  });

  it('a tie at the top', () => {
    const rows = [{ c: 'A', n: 5 }, { c: 'B', n: 5 }, { c: 'C', n: 1 }];
    expect(lead(rows, ['c', 'n'])).toBeNull();
  });

  it('an unaliased measure (BigQuery names it f0_, f1_, ...)', () => {
    const rows = [{ c: 'A', f0_: 9 }, { c: 'B', f0_: 3 }];
    expect(lead(rows, ['c', 'f0_'], { sql: 'SELECT c, COUNT(*) FROM t GROUP BY 1' })).toBeNull();
    const rows12 = [{ c: 'A', f12_: 9 }, { c: 'B', f12_: 3 }];
    expect(lead(rows12, ['c', 'f12_'])).toBeNull();
    // A real column that merely starts with f is still a measure.
    const fees = [{ c: 'A', f0_fees: 9 }, { c: 'B', f0_fees: 3 }];
    expect(lead(fees, ['c', 'f0_fees'])).toBe('*A* has the highest f0 fees (9), followed by B (3).');
  });

  it('an ascending sort on the measure (the question asked for the lowest)', () => {
    const rows = [{ c: 'Organic', bounce_rate: 0.2 }, { c: 'Paid', bounce_rate: 0.5 }, { c: 'Direct', bounce_rate: 0.9 }];
    const cols = ['c', 'bounce_rate'];
    for (const order of ['ORDER BY bounce_rate', 'ORDER BY bounce_rate ASC', 'ORDER BY 2', 'ORDER BY t.bounce_rate ASC NULLS LAST, c', 'ORDER BY `bounce_rate` asc;', 'ORDER BY bounce_rate ASC, LOWER(c)', 'ORDER BY `t`.`bounce_rate`']) {
      expect(lead(rows, cols, { sql: `SELECT c, bounce_rate FROM t ${order}` })).toBeNull();
    }
    // Only the outer ORDER BY counts: an inner sort in a subquery neither silences nor hides it.
    expect(lead(rows, cols, { sql: 'SELECT c, bounce_rate FROM (SELECT * FROM t ORDER BY bounce_rate DESC) ORDER BY bounce_rate' })).toBeNull();
    expect(lead(rows, cols, { sql: 'SELECT c, bounce_rate FROM (SELECT * FROM t ORDER BY bounce_rate) ORDER BY bounce_rate DESC, LOWER(c)' })).not.toBeNull();
    expect(lead(rows, cols, { sql: 'SELECT c, bounce_rate FROM (SELECT * FROM t ORDER BY bounce_rate)' })).not.toBeNull();
    // An ascending top-N cut is silent too (the LIMIT rule already requires DESC).
    expect(lead(rows, cols, { sql: 'SELECT c, bounce_rate FROM t ORDER BY bounce_rate LIMIT 3' })).toBeNull();
    // Descending, label-first and unordered queries keep their caption.
    for (const order of ['ORDER BY bounce_rate DESC', 'ORDER BY c', 'ORDER BY 2 DESC', '']) {
      expect(lead(rows, cols, { sql: `SELECT c, bounce_rate FROM t ${order}` })).toBe('*Direct* has the highest bounce rate (0.9), followed by Paid (0.5).');
    }
    // A comment or string that mentions an ascending sort is inert.
    expect(lead(rows, cols, { sql: "SELECT c, bounce_rate FROM t WHERE c != 'ORDER BY bounce_rate' -- ORDER BY bounce_rate" })).not.toBeNull();
  });

  it('a grand-total row among the labels', () => {
    for (const total of ['Total', 'grand total', 'All', ' Overall ', '(all)']) {
      const rows = [{ c: total, revenue: 1000 }, { c: 'Paid', revenue: 600 }, { c: 'Organic', revenue: 400 }];
      expect(lead(rows, ['c', 'revenue'], { sql: "SELECT c, revenue FROM t UNION ALL SELECT 'Total', SUM(revenue) FROM t" })).toBeNull();
    }
    // A label that only contains the word is still a category.
    const rows = [{ c: 'Total Wine', revenue: 1000 }, { c: 'Paid', revenue: 600 }];
    expect(lead(rows, ['c', 'revenue'], { sql: "SELECT c, revenue FROM t UNION ALL SELECT 'Total Wine', SUM(revenue) FROM t" })).toBe('*Total Wine* has the highest revenue (1000), followed by Paid (600).');
  });

  it('a STRING period label (a time series has no winner)', () => {
    for (const labels of [['January', 'February'], ['Jan 2026', 'Feb 2026'], ['Q1 2026', 'Q2 2026'], ['2026-Q1', '2026-Q2'], ['2026-W03', '2026-W04'], ['H1', 'H2'], ['FY2025', 'FY2026'], ['Monday', 'Tuesday'], ['Week 3', 'Week 4'], ['Sept.', 'Oct.']]) {
      const rows = [{ p: labels[0], n: 9 }, { p: labels[1], n: 3 }];
      expect(lead(rows, ['p', 'n'])).toBeNull();
    }
    // Words that merely start like a period name are still categories.
    const rows = [{ p: 'Marketing', n: 9 }, { p: 'Sunglasses', n: 3 }];
    expect(lead(rows, ['p', 'n'])).toBe('*Marketing* has the highest n (9), followed by Sunglasses (3).');
  });

  it('negative values', () => {
    const rows = [{ c: 'A', n: 100 }, { c: 'B', n: -90 }];
    expect(lead(rows, ['c', 'n'])).toBeNull();
  });

  it('a non-numeric value in the measure column', () => {
    const rows = [{ c: 'A', n: 100 }, { c: 'B', n: 'n/a' }];
    expect(lead(rows, ['c', 'n'])).toBeNull();
  });

  it('a null measure', () => {
    const rows = [{ c: 'A', n: 100 }, { c: 'B', n: null }];
    expect(lead(rows, ['c', 'n'])).toBeNull();
  });

  it('both columns numeric (no dimension to name)', () => {
    const rows = [{ year: 2024, n: 10 }, { year: 2025, n: 20 }];
    expect(lead(rows, ['year', 'n'])).toBeNull();
  });

  it('a numeric-looking text dimension (ids) — ambiguous which column is the measure', () => {
    const rows = [{ campaign_id: '001', n: 10 }, { campaign_id: '002', n: 20 }];
    expect(lead(rows, ['campaign_id', 'n'])).toBeNull();
  });

  it('a date dimension (time series has no "winner")', () => {
    const rows = [{ day: '2026-11-01', n: 9 }, { day: '2026-11-02', n: 2 }];
    expect(lead(rows, ['day', 'n'])).toBeNull();
  });

  it('a BigQuery date wrapper or JS Date dimension', () => {
    expect(lead([{ d: { value: '2026-11-01' }, n: 9 }, { d: { value: '2026-11-02' }, n: 2 }], ['d', 'n'])).toBeNull();
    expect(lead([{ d: new Date('2026-11-01'), n: 9 }, { d: new Date('2026-11-02'), n: 2 }], ['d', 'n'])).toBeNull();
  });

  it('an empty or null dimension label', () => {
    expect(lead([{ c: null, n: 9 }, { c: 'B', n: 2 }], ['c', 'n'])).toBeNull();
    expect(lead([{ c: '', n: 9 }, { c: 'B', n: 2 }], ['c', 'n'])).toBeNull();
  });

  it('non-finite numbers', () => {
    expect(lead([{ c: 'A', n: Infinity }, { c: 'B', n: 2 }], ['c', 'n'])).toBeNull();
  });
});

describe('computeLeadIn — review hardening', () => {
  const ranked = (n: number, leaderAt: number) => Array.from({ length: n }, (_, i) => ({
    session_default_channel_grouping: `Channel ${String.fromCharCode(65 + i)}`,
    session_count: i === leaderAt ? 1000 : 100 - i,
  }));

  it('names a leader inside the displayed rows', () => {
    expect(lead(ranked(25, 19))).toBe('*Channel T* has the highest session count (1000), followed by Channel A (100).');
  });

  it('stays silent when the leader is past the displayed rows', () => {
    expect(lead(ranked(25, 22))).toBeNull();
  });

  it('stays silent when the named runner-up is past the displayed rows', () => {
    const rows = ranked(25, 0).map((r, i) => (i === 21 ? { ...r, session_count: 500 } : r));
    expect(lead(rows)).toBeNull();
  });

  const zipRows = [{ city: 'Springfield', zip: '99999' }, { city: 'Shelbyville', zip: '10001' }];
  const zipSql = 'SELECT city, zip FROM t';
  it('never treats a numeric-looking STRING column as a measure', () => {
    expect(computeLeadIn({ rows: zipRows, columnNames: ['city', 'zip'], truncated: false, sql: zipSql, columnTypes: ['STRING', 'STRING'] })).toBeNull();
  });

  it('stays silent when the column types are missing or misaligned', () => {
    expect(computeLeadIn({ rows: channelRows, columnNames: COLS, truncated: false, sql: SQL })).toBeNull();
    expect(computeLeadIn({ rows: channelRows, columnNames: COLS, truncated: false, sql: SQL, columnTypes: ['STRING'] })).toBeNull();
    expect(computeLeadIn({ rows: channelRows, columnNames: COLS, truncated: false, sql: SQL, columnTypes: ['STRING', 'INT64'] })).not.toBeNull();
  });

  it('accepts numeric measure types, including legacy aliases', () => {
    for (const t of ['INT64', 'INTEGER', 'NUMERIC', 'FLOAT', 'BIGNUMERIC']) {
      expect(computeLeadIn({ rows: channelRows, columnNames: COLS, truncated: false, sql: SQL, columnTypes: ['STRING', t] })).not.toBeNull();
    }
    expect(computeLeadIn({ rows: channelRows, columnNames: COLS, truncated: false, sql: SQL, columnTypes: ['DATE', 'INT64'] })).toBeNull();
  });

  it('does not let a quote inside a backticked identifier hide an inner LIMIT', () => {
    const sql = "SELECT ch AS session_default_channel_grouping, n AS session_count FROM (SELECT `o'brien` AS ch, COUNT(*) AS n FROM t GROUP BY 1 LIMIT 5) WHERE `it's` IS NOT NULL";
    expect(lead(channelRows, COLS, { sql })).toBeNull();
  });

  it('does not let a quote inside a triple-quoted string hide an inner LIMIT', () => {
    const sql = "SELECT * FROM (SELECT ch, COUNT(*) AS n FROM t WHERE note = '''it's''' GROUP BY 1 LIMIT 5) WHERE x = 'a'";
    expect(lead(channelRows, COLS, { sql })).toBeNull();
  });

  it('still matches a backticked measure in a top-N ORDER BY', () => {
    expect(lead(channelRows, COLS, { sql: `${SQL.replace('ORDER BY 2 DESC', 'ORDER BY `session_count` DESC')} LIMIT 5` }))
      .toBe('*Direct* has the highest session count (198), followed by Unassigned (42).');
  });
});

describe('buildAnswerCaptionBlocks', () => {
  it('renders the lead-in as a section when eligible', () => {
    const blocks = captionWithInferredTypes({ rows: channelRows, columnNames: COLS, truncated: false, sql: SQL, headline: 'sessions by channel' });
    expect(blocks).toEqual([
      { type: 'section', text: { type: 'mrkdwn', text: '*Direct* has the highest session count (198), followed by Unassigned (42).' } },
    ]);
  });

  it('falls back to the headline when the lead-in is ineligible', () => {
    const blocks = captionWithInferredTypes({ rows: channelRows, columnNames: COLS, truncated: true, sql: SQL, headline: 'Sessions by channel, last 30 days' });
    expect(blocks).toEqual([
      { type: 'section', text: { type: 'mrkdwn', text: 'Sessions by channel, last 30 days' } },
    ]);
  });

  it('escapes Slack control syntax in the headline fallback', () => {
    const blocks = captionWithInferredTypes({ rows: channelRows, columnNames: COLS, truncated: true, sql: SQL, headline: 'Sessions <!here> & <https://x.example|more>' });
    expect(blocks).toEqual([{ type: 'section', text: { type: 'mrkdwn', text: 'Sessions &lt;!here&gt; &amp; &lt;https://x.example|more&gt;' } }]);
  });

  it('renders nothing when ineligible and there is no headline', () => {
    expect(captionWithInferredTypes({ rows: channelRows, columnNames: COLS, truncated: true, sql: SQL })).toEqual([]);
    expect(captionWithInferredTypes({ rows: channelRows, columnNames: COLS, truncated: true, sql: SQL, headline: '   ' })).toEqual([]);
  });
});

describe('leader share', () => {
  const withShare = (rows: Record<string, unknown>[], rowIndex: number, opts: { truncated?: boolean } = {}) =>
    leadInWithInferredTypes({ rows, columnNames: COLS, truncated: opts.truncated ?? false, sql: SQL, leaderShare: { label: '79%', rowIndex } });

  it('inserts the share inside the leader parentheses', () => {
    expect(withShare(channelRows, 0)).toBe('*Direct* has the highest session count (198, 79% of the total), followed by Unassigned (42).');
  });

  it('uses the original row index, not the ranked one', () => {
    const shuffled = [channelRows[2], channelRows[0], channelRows[4], channelRows[1]];
    expect(withShare(shuffled, 1)).toContain('(198, 79% of the total)');
    expect(withShare(shuffled, 0)).toBe('*Direct* has the highest session count (198), followed by Unassigned (42).');
  });

  it('adds nothing when rowIndex is not the leader', () => {
    expect(withShare(channelRows, 1)).toBe('*Direct* has the highest session count (198), followed by Unassigned (42).');
  });

  it('never adds a share to the headline fallback', () => {
    const blocks = captionWithInferredTypes({
      rows: channelRows, columnNames: COLS, truncated: true, sql: SQL, headline: 'Sessions by channel',
      composition: { eligible: true, dimension: COLS[0], measure: COLS[1], measureKind: 'count', total: '250',
        shares: channelRows.map(() => ({ basisPoints: 7920, label: '79%' })), topIndex: 0, usedUniqueKeys: [] },
    }) as any[];
    expect(blocks).toHaveLength(1);
    expect(blocks[0].text.text).toBe('Sessions by channel');
  });

  it('derives the share from composition.topIndex', () => {
    const blocks = captionWithInferredTypes({
      rows: channelRows, columnNames: COLS, truncated: false, sql: SQL,
      composition: { eligible: true, dimension: COLS[0], measure: COLS[1], measureKind: 'count', total: '250',
        shares: channelRows.map(() => ({ basisPoints: 7920, label: '79%' })), topIndex: 0, usedUniqueKeys: [] },
    }) as any[];
    expect(blocks[0].text.text).toContain('(198, 79% of the total)');
  });

  it('adds no share when the composition is not aligned with the rows', () => {
    const blocks = captionWithInferredTypes({
      rows: channelRows, columnNames: COLS, truncated: false, sql: SQL,
      composition: { eligible: true, dimension: COLS[0], measure: COLS[1], measureKind: 'count', total: '250',
        shares: [...channelRows, channelRows[0]].map(() => ({ basisPoints: 7920, label: '79%' })), topIndex: 0, usedUniqueKeys: [] },
    }) as any[];
    expect(blocks[0].text.text).toBe('*Direct* has the highest session count (198), followed by Unassigned (42).');
  });
});
