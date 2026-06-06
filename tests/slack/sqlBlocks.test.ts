import { describe, it, expect } from 'vitest';
import { buildSqlBlocks, SQL_BLOCK_PREFIX } from '../../src/slack/sqlBlocks.js';
import type { ResponseContext } from '../../src/types.js';

const baseContext: ResponseContext = {
  responseId: 'resp-1',
  threadTs: 'thread-1',
  statusMsgTs: 'status-1',
  clarifiedQuestion: 'What is total revenue?',
  assumptions: [],
  reasoningChain: '',
  generatedSql: 'SELECT SUM(amount) FROM `analytics.orders`',
  explanation: 'Total revenue from all orders',
  tablesUsed: ['analytics.orders'],
  confidence: 'high',
  primaryAgentConfidence: 'high',
  queryResults: { rowCount: 1, columnNames: ['total'], bytesProcessed: 1024 },
  pipelineDurationMs: 2500,
  traceId: 'trace-abc',
  createdAt: new Date(),
  groundingCitations: [],
  teachingsUsed: [],
  supervisorVerdict: 'pass',
  supervisorNotes: '',
};

describe('buildSqlBlocks', () => {
  it('renders the persisted SQL in a single bare code-block section', () => {
    const blocks = buildSqlBlocks(baseContext);
    const text = JSON.stringify(blocks);

    // Additive design: the panel is just the SQL section — the "Hide SQL"
    // control lives in the feedback row, not here.
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('section');

    // The exact persisted query, fenced as a code block.
    expect(text).toContain('SELECT SUM(amount) FROM `analytics.orders`');
    expect((blocks[0] as any).text.text).toContain('```');

    // No buttons are rendered inside the SQL panel.
    expect(text).not.toContain('hide_sql_');
  });

  it('tags every block with the SQL_BLOCK_PREFIX so Hide SQL can strip them', () => {
    const blocks = buildSqlBlocks(baseContext);
    for (const block of blocks) {
      expect((block as any).block_id).toMatch(new RegExp(`^${SQL_BLOCK_PREFIX}`));
    }
  });
});
