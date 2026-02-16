import { describe, it, expect } from 'vitest';
import {
  buildSingleValueBlocks,
  buildTableBlocks,
  buildZeroRowBlocks,
  buildTruncatedBlocks,
  buildFeedbackActions,
} from '../../src/slack/blocks.js';

describe('buildSingleValueBlocks', () => {
  it('creates a section block with the value and feedback with traceId', () => {
    const blocks = buildSingleValueBlocks('42', 'Total orders', 'SELECT COUNT(*) FROM orders', 'trace-abc');
    expect(blocks).toHaveLength(3); // value + sql + feedback
    expect(blocks[0].type).toBe('section');
    expect((blocks[0] as any).text.text).toContain('42');
    // Feedback actions should have the traceId
    const actions = blocks[2] as any;
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
});

describe('buildZeroRowBlocks', () => {
  it('includes filter summary and broaden offer', () => {
    const blocks = buildZeroRowBlocks(
      ['order_status = completed', 'order_date between 2026-01-01 and 2026-01-31'],
      'SELECT * FROM orders WHERE order_status = "completed"',
    );
    const text = JSON.stringify(blocks);
    expect(text).toContain('no results');
    expect(text).toContain('order_status');
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
});
