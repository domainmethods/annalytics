import { describe, it, expect } from 'vitest';
import { computeLeadIn, buildAnswerCaptionBlocks } from '../../src/slack/answerLeadIn.js';

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
  computeLeadIn({ rows, columnNames: cols, truncated: opts.truncated ?? false, sql: opts.sql ?? SQL });

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
  it('treats a numeric-looking STRING column as a measure only without types', () => {
    expect(computeLeadIn({ rows: zipRows, columnNames: ['city', 'zip'], truncated: false, sql: zipSql })).not.toBeNull();
    expect(computeLeadIn({ rows: zipRows, columnNames: ['city', 'zip'], truncated: false, sql: zipSql, columnTypes: ['STRING', 'STRING'] })).toBeNull();
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
    const blocks = buildAnswerCaptionBlocks({ rows: channelRows, columnNames: COLS, truncated: false, sql: SQL, headline: 'sessions by channel' });
    expect(blocks).toEqual([
      { type: 'section', text: { type: 'mrkdwn', text: '*Direct* has the highest session count (198), followed by Unassigned (42).' } },
    ]);
  });

  it('falls back to the headline when the lead-in is ineligible', () => {
    const blocks = buildAnswerCaptionBlocks({ rows: channelRows, columnNames: COLS, truncated: true, sql: SQL, headline: 'Sessions by channel, last 30 days' });
    expect(blocks).toEqual([
      { type: 'section', text: { type: 'mrkdwn', text: 'Sessions by channel, last 30 days' } },
    ]);
  });

  it('escapes Slack control syntax in the headline fallback', () => {
    const blocks = buildAnswerCaptionBlocks({ rows: channelRows, columnNames: COLS, truncated: true, sql: SQL, headline: 'Sessions <!here> & <https://x.example|more>' });
    expect(blocks).toEqual([{ type: 'section', text: { type: 'mrkdwn', text: 'Sessions &lt;!here&gt; &amp; &lt;https://x.example|more&gt;' } }]);
  });

  it('renders nothing when ineligible and there is no headline', () => {
    expect(buildAnswerCaptionBlocks({ rows: channelRows, columnNames: COLS, truncated: true, sql: SQL })).toEqual([]);
    expect(buildAnswerCaptionBlocks({ rows: channelRows, columnNames: COLS, truncated: true, sql: SQL, headline: '   ' })).toEqual([]);
  });
});

describe('leader share', () => {
  const withShare = (rows: Record<string, unknown>[], rowIndex: number, opts: { truncated?: boolean } = {}) =>
    computeLeadIn({ rows, columnNames: COLS, truncated: opts.truncated ?? false, sql: SQL, leaderShare: { label: '79%', rowIndex } });

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
    const blocks = buildAnswerCaptionBlocks({
      rows: channelRows, columnNames: COLS, truncated: true, sql: SQL, headline: 'Sessions by channel',
      composition: { eligible: true, dimension: COLS[0], measure: COLS[1], measureKind: 'count', total: '250',
        shares: channelRows.map(() => ({ basisPoints: 7920, label: '79%' })), topIndex: 0, usedUniqueKeys: [] },
    }) as any[];
    expect(blocks).toHaveLength(1);
    expect(blocks[0].text.text).toBe('Sessions by channel');
  });

  it('derives the share from composition.topIndex', () => {
    const blocks = buildAnswerCaptionBlocks({
      rows: channelRows, columnNames: COLS, truncated: false, sql: SQL,
      composition: { eligible: true, dimension: COLS[0], measure: COLS[1], measureKind: 'count', total: '250',
        shares: channelRows.map(() => ({ basisPoints: 7920, label: '79%' })), topIndex: 0, usedUniqueKeys: [] },
    }) as any[];
    expect(blocks[0].text.text).toContain('(198, 79% of the total)');
  });

  it('adds no share when the composition is not aligned with the rows', () => {
    const blocks = buildAnswerCaptionBlocks({
      rows: channelRows, columnNames: COLS, truncated: false, sql: SQL,
      composition: { eligible: true, dimension: COLS[0], measure: COLS[1], measureKind: 'count', total: '250',
        shares: [...channelRows, channelRows[0]].map(() => ({ basisPoints: 7920, label: '79%' })), topIndex: 0, usedUniqueKeys: [] },
    }) as any[];
    expect(blocks[0].text.text).toBe('*Direct* has the highest session count (198), followed by Unassigned (42).');
  });
});
