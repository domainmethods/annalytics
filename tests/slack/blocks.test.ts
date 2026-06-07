import { describe, it, expect } from 'vitest';
import {
  buildSingleValueBlocks,
  buildTableBlocks,
  buildZeroRowBlocks,
  buildTruncatedBlocks,
  buildFeedbackActions,
  overrideButtonsForResultShape,
  formatValue,
  buildAssumptionBlocks,
} from '../../src/slack/blocks.js';

describe('buildAssumptionBlocks', () => {
  it('returns an empty array when there are no assumptions', () => {
    expect(buildAssumptionBlocks([], 'trace-1')).toEqual([]);
  });

  it('builds a context block + refine actions block when assumptions exist', () => {
    const blocks = buildAssumptionBlocks(['order_status = completed'], 'trace-1') as any[];
    const ctx = blocks.find((b) => b.type === 'context');
    expect(ctx).toBeDefined();
    expect(Array.isArray(ctx.elements)).toBe(true);
    expect(ctx.elements[0].type).toBe('mrkdwn');
    expect(ctx.elements[0].text).toContain('order_status = completed');
    expect(ctx.text).toBeUndefined(); // context carries text in elements, not top-level
    const actions = blocks.find((b) => b.type === 'actions');
    expect(actions).toBeDefined();
    expect(actions.elements[0].action_id).toBe('refine_assumptions');
    expect(actions.elements[0].value).toBe('trace-1');
  });
});

describe('buildSingleValueBlocks', () => {
  it('creates a value section and feedback row, with no inline SQL block', () => {
    // SQL now lives behind the Show SQL toggle, so the value answer is just the
    // value section + the feedback/actions row.
    const blocks = buildSingleValueBlocks('42', 'Total orders', 'trace-abc');
    expect(blocks).toHaveLength(2); // value + feedback
    expect(blocks[0].type).toBe('section');
    expect((blocks[0] as any).text.text).toContain('42');
    // No raw SQL should be rendered inline.
    expect(JSON.stringify(blocks)).not.toContain('SELECT');
    // Feedback actions should have the traceId
    const actions = blocks[1] as any;
    expect(actions.elements[0].action_id).toBe('thumbs_up_trace-abc');
    expect(actions.elements[1].action_id).toBe('thumbs_down_trace-abc');
  });
});

describe('buildTableBlocks', () => {
  it('creates header and rows', () => {
    const rows = [
      { region: 'US', revenue: '$1M' },
      { region: 'EU', revenue: '$500K' },
    ];
    const blocks = buildTableBlocks(rows, ['region', 'revenue']);
    expect(blocks.length).toBeGreaterThan(0);
    // Should contain column headers
    const text = JSON.stringify(blocks);
    expect(text).toContain('region');
    expect(text).toContain('revenue');
  });

  it('emits a native table block with a header row and raw_text cells (<=20 cols)', () => {
    const rows = [{ region: 'US', revenue: '$1M' }];
    const blocks = buildTableBlocks(rows, ['region', 'revenue']) as any[];
    const table = blocks.find((b) => b.type === 'table');
    expect(table).toBeDefined();
    expect(table.rows[0].map((c: any) => c.text)).toEqual(['region', 'revenue']);
    expect(table.rows[1].map((c: any) => c.type)).toEqual(['raw_text', 'raw_text']);
    expect(table.rows[1].map((c: any) => c.text)).toEqual(['US', '$1M']);
  });

  it('coerces empty cells to a non-empty placeholder (raw_text min length 1)', () => {
    const rows = [{ a: null, b: undefined }];
    const blocks = buildTableBlocks(rows, ['a', 'b']) as any[];
    const table = blocks.find((b) => b.type === 'table');
    for (const row of table.rows) for (const cell of row) expect(cell.text.length).toBeGreaterThan(0);
  });

  it('falls back to a code-block (section) when there are more than 20 columns', () => {
    const cols = Array.from({ length: 21 }, (_, i) => `c${i}`);
    const row = Object.fromEntries(cols.map((c) => [c, '1']));
    const blocks = buildTableBlocks([row], cols) as any[];
    expect(blocks.some((b) => b.type === 'table')).toBe(false);
    expect(blocks[0].type).toBe('section');
    expect(blocks[0].text.text).toContain('```');
  });
});

describe('formatValue', () => {
  it('renders a Date as an ISO string', () => {
    const d = new Date('2026-01-15T10:30:00.000Z');
    expect(formatValue(d)).toBe('2026-01-15T10:30:00.000Z');
  });

  it('unwraps a {value} object', () => {
    expect(formatValue({ value: '2026-01-15' })).toBe('2026-01-15');
  });

  it('renders null and undefined as an empty string', () => {
    expect(formatValue(null)).toBe('');
    expect(formatValue(undefined)).toBe('');
  });
});

describe('buildZeroRowBlocks', () => {
  it('includes filter summary and broaden offer, without inline SQL', () => {
    const blocks = buildZeroRowBlocks(
      ['order_status = completed', 'order_date between 2026-01-01 and 2026-01-31'],
    );
    const text = JSON.stringify(blocks);
    expect(text).toContain('no results');
    expect(text).toContain('order_status');
    // SQL is reachable via the Show SQL toggle, not rendered here.
    expect(text).not.toContain('SELECT');
  });
});

describe('buildTruncatedBlocks', () => {
  it('shows row count and truncation notice', () => {
    const blocks = buildTruncatedBlocks(1000, 50000);
    const text = JSON.stringify(blocks);
    expect(text).toContain('1,000');
    expect(text).toContain('50,000');
  });
});

describe('buildFeedbackActions', () => {
  it('creates thumbs up and thumbs down buttons', () => {
    const block = buildFeedbackActions('trace-123');
    expect(block.type).toBe('actions');
    expect(block.elements).toHaveLength(2);
    expect(block.elements[0].action_id).toContain('thumbs_up');
    expect(block.elements[1].action_id).toContain('thumbs_down');
  });

  it('shows the detail toggles and all override buttons by default', () => {
    const block = buildFeedbackActions('trace-123', 'thread-1', 'status-1');
    const ids = block.elements.map((e) => (e as any).action_id);
    expect(ids).toEqual([
      'thumbs_up_trace-123',
      'thumbs_down_trace-123',
      'show_reasoning_trace-123',
      'show_sql_trace-123',
      'override_table_trace-123',
      'override_summary_trace-123',
      'override_csv_trace-123',
    ]);
  });

  it('always keeps the Reasoning and Show SQL toggles even when overrides are suppressed', () => {
    const block = buildFeedbackActions('trace-123', 'thread-1', 'status-1', {
      table: false,
      summary: false,
      csv: false,
    });
    const ids = block.elements.map((e) => (e as any).action_id);
    expect(ids).toContain('show_reasoning_trace-123');
    expect(ids).toContain('show_sql_trace-123');
    expect(ids).not.toContain('override_table_trace-123');
    expect(ids).not.toContain('override_summary_trace-123');
    expect(ids).not.toContain('override_csv_trace-123');
  });

  it('renders the SQL toggle as "Hide SQL" when sqlShown is true (additive panel)', () => {
    // When the SQL panel is open it sits above a still-visible feedback row, so
    // the SQL button flips in place to the hide_sql_ action.
    const block = buildFeedbackActions('trace-123', 'thread-1', 'status-1', {}, true);
    const ids = block.elements.map((e) => (e as any).action_id);
    expect(ids).toContain('hide_sql_trace-123');
    expect(ids).not.toContain('show_sql_trace-123');
    // The rest of the feedback row is unchanged.
    expect(ids).toContain('thumbs_up_trace-123');
    expect(ids).toContain('show_reasoning_trace-123');
  });

  it('suppresses Table and CSV but keeps Summary when asked', () => {
    const block = buildFeedbackActions('trace-123', 'thread-1', 'status-1', {
      table: false,
      csv: false,
    });
    const ids = block.elements.map((e) => (e as any).action_id);
    expect(ids).toContain('override_summary_trace-123');
    expect(ids).not.toContain('override_table_trace-123');
    expect(ids).not.toContain('override_csv_trace-123');
  });
});

describe('overrideButtonsForResultShape', () => {
  it('suppresses all output overrides for a zero-row result', () => {
    expect(overrideButtonsForResultShape(0, 3)).toEqual({ table: false, summary: false, csv: false });
  });

  it('suppresses all output overrides for a single scalar (the value is already the answer)', () => {
    expect(overrideButtonsForResultShape(1, 1)).toEqual({ table: false, summary: false, csv: false });
  });

  it('shows all overrides for a multi-row table', () => {
    expect(overrideButtonsForResultShape(25, 4)).toEqual({});
  });

  it('treats a single multi-column row as a table (no suppression)', () => {
    // 1 row but >1 column is a table, not a scalar — Summary stays useful.
    expect(overrideButtonsForResultShape(1, 3)).toEqual({});
  });
});
