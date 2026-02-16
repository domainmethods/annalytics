import { describe, it, expect } from 'vitest';
import { buildReasoningBlocks, REASONING_BLOCK_PREFIX } from '../../src/slack/reasoningBlocks.js';
import { buildFeedbackActions } from '../../src/slack/blocks.js';
import type { ResponseContext } from '../../src/types.js';

const baseContext: ResponseContext = {
  responseId: 'resp-1',
  threadTs: 'thread-1',
  statusMsgTs: 'status-1',
  clarifiedQuestion: 'What is total revenue?',
  assumptions: ['revenue = sum of order amounts'],
  reasoningChain: 'Looked up revenue definition...',
  generatedSql: 'SELECT SUM(amount) FROM orders',
  explanation: 'Total revenue from all orders',
  tablesUsed: ['analytics.orders', 'analytics.customers'],
  confidence: 'high',
  primaryAgentConfidence: 'high',
  supervisorConfidence: 'high',
  queryResults: { rowCount: 1, columnNames: ['total'], bytesProcessed: 1024 },
  pipelineDurationMs: 2500,
  traceId: 'trace-abc',
  createdAt: new Date(),
  groundingCitations: [
    { sourceFile: 'revenue-definition.md', chunkText: 'Revenue is...', relevanceScore: 0.95 },
    { sourceFile: 'order-metrics.md', chunkText: 'Orders table...', relevanceScore: 0.8 },
  ],
  teachingsUsed: ['revenue-definition.md', 'order-metrics.md'],
  supervisorVerdict: 'pass',
  supervisorNotes: 'Query correctly joins orders table',
};

describe('buildReasoningBlocks', () => {
  it('builds sections for tables, teachings, supervisor, and confidence with block_ids', () => {
    const blocks = buildReasoningBlocks(baseContext);
    const text = JSON.stringify(blocks);

    // Tables used
    expect(text).toContain('analytics.orders');
    expect(text).toContain('analytics.customers');

    // Teachings referenced
    expect(text).toContain('revenue-definition.md');
    expect(text).toContain('order-metrics.md');

    // Supervisor assessment
    expect(text).toContain('pass');
    expect(text).toContain('Query correctly joins orders table');

    // Confidence
    expect(text).toContain('high');

    // All reasoning blocks have block_ids with the prefix
    const reasoningBlocks = blocks.filter((b: any) => b.block_id?.startsWith(REASONING_BLOCK_PREFIX));
    expect(reasoningBlocks).toHaveLength(5); // 4 sections + 1 actions

    // Hide reasoning button
    const actionsBlock = blocks.find((b: any) => b.block_id === `${REASONING_BLOCK_PREFIX}actions`) as any;
    expect(actionsBlock).toBeDefined();
    expect(actionsBlock.elements[0].action_id).toBe('hide_reasoning_trace-abc');
    expect(actionsBlock.elements[0].value).toBe('thread-1_status-1');
  });

  it('handles missing citations gracefully', () => {
    const ctx: ResponseContext = {
      ...baseContext,
      groundingCitations: [],
      teachingsUsed: [],
    };
    const blocks = buildReasoningBlocks(ctx);
    const text = JSON.stringify(blocks);

    // Should still have tables and supervisor sections
    expect(text).toContain('analytics.orders');
    expect(text).toContain('pass');

    // Should note no teachings
    expect(text).toContain('None');
  });

  it('renders gracefully with partial context (pre-deployment records)', () => {
    // Simulate an old ResponseContext missing new fields
    const partialCtx = {
      ...baseContext,
      teachingsUsed: undefined,
      supervisorVerdict: undefined,
      supervisorNotes: undefined,
      confidence: undefined,
      tablesUsed: undefined,
    } as unknown as ResponseContext;

    const blocks = buildReasoningBlocks(partialCtx);
    const text = JSON.stringify(blocks);

    // Should not throw, should show fallback values
    expect(text).toContain('None'); // teachings
    expect(text).toContain('N/A'); // verdict and confidence
    expect(blocks).toHaveLength(5);
  });
});

describe('buildFeedbackActions with reasoning toggle and overrides', () => {
  it('includes reasoning and override buttons alongside thumbs up/down', () => {
    const block = buildFeedbackActions('trace-xyz', 'thread-1', 'status-1');
    expect(block.type).toBe('actions');
    expect(block.elements).toHaveLength(6);
    expect(block.elements[0].action_id).toContain('thumbs_up');
    expect(block.elements[1].action_id).toContain('thumbs_down');
    expect(block.elements[2].action_id).toBe('show_reasoning_trace-xyz');
    expect((block.elements[2] as any).value).toBe('thread-1_status-1');
    expect(block.elements[3].action_id).toBe('override_table_trace-xyz');
    expect(block.elements[4].action_id).toBe('override_summary_trace-xyz');
    expect(block.elements[5].action_id).toBe('override_csv_trace-xyz');
  });
});
