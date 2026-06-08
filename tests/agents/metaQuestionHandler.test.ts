import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGenerateContent = vi.fn();
vi.mock('@google/genai', () => ({
  GoogleGenAI: vi.fn(function () {
    return { models: { generateContent: mockGenerateContent } };
  }),
}));

import { handleMetaQuestion } from '../../src/agents/metaQuestionHandler.js';
import type { ResponseContext } from '../../src/types.js';

const baseCtx: ResponseContext = {
  responseId: 'resp-1',
  threadTs: 'thread-1',
  statusMsgTs: 'status-1',
  clarifiedQuestion: 'What is total revenue by region?',
  assumptions: ['revenue = sum of order amounts', 'region from customers table'],
  reasoningChain: 'Looked up revenue definition in teachings, joined orders with customers for region.',
  generatedSql: 'SELECT c.region, SUM(o.amount) FROM orders o JOIN customers c ON o.customer_id = c.id GROUP BY 1',
  explanation: 'Total revenue broken down by region',
  tablesUsed: ['analytics.orders', 'analytics.customers'],
  confidence: 'high',
  primaryAgentConfidence: 'high',
  supervisorConfidence: 'high',
  queryResults: { rowCount: 5, columnNames: ['region', 'total'], bytesProcessed: 4096 },
  pipelineDurationMs: 3000,
  traceId: 'trace-meta',
  createdAt: new Date(),
  groundingCitations: [
    { sourceFile: 'revenue-definition.md', chunkText: 'Revenue is the sum of all order amounts.', relevanceScore: 0.95 },
    { sourceFile: 'regional-mapping.md', chunkText: 'Region comes from customers.region field.', relevanceScore: 0.8 },
  ],
  teachingsUsed: ['revenue-definition.md', 'regional-mapping.md'],
  supervisorVerdict: 'pass',
  supervisorNotes: 'Join is correct, GROUP BY matches SELECT.',
  retrievedSchema: [
    {
      name: 'analytics.orders',
      description: 'All completed orders',
      columns: [
        { name: 'id', description: 'Order ID', dataType: 'INT64' },
        { name: 'amount', description: 'Order total in USD', dataType: 'FLOAT64' },
        { name: 'customer_id', description: 'FK to customers', dataType: 'INT64' },
      ],
    },
    {
      name: 'analytics.customers',
      description: 'Customer profiles',
      columns: [
        { name: 'id', description: 'Customer ID', dataType: 'INT64' },
        { name: 'region', description: 'Geographic region', dataType: 'STRING' },
      ],
    },
  ],
};

describe('handleMetaQuestion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('builds prompt with full context and returns Flash response', async () => {
    mockGenerateContent.mockResolvedValue({
      text: 'I used analytics.orders because it contains the revenue amounts, and analytics.customers for the region dimension.',
    });

    const result = await handleMetaQuestion('Why did you use those tables?', baseCtx, 'test-key');

    expect(result).toContain('analytics.orders');

    // Verify the prompt includes key context
    const callArgs = mockGenerateContent.mock.calls[0][0];
    expect(callArgs.model).toBe('gemini-3-flash-preview');
    const promptText = callArgs.contents[0].parts[0].text;
    expect(promptText).toContain('What is total revenue by region?');
    expect(promptText).toContain('revenue-definition.md');
    expect(promptText).toContain('analytics.orders');
    expect(promptText).toContain('Order total in USD');
  });

  it('handles missing groundingCitations gracefully', async () => {
    mockGenerateContent.mockResolvedValue({
      text: 'No specific teachings were referenced for this query.',
    });

    const ctx: ResponseContext = {
      ...baseCtx,
      groundingCitations: [],
      teachingsUsed: [],
    };

    const result = await handleMetaQuestion('What teachings did you use?', ctx, 'test-key');

    expect(result).toBe('No specific teachings were referenced for this query.');
    const promptText = mockGenerateContent.mock.calls[0][0].contents[0].parts[0].text;
    expect(promptText).toContain('None');
  });

  it('handles missing retrievedSchema gracefully', async () => {
    mockGenerateContent.mockResolvedValue({
      text: 'Schema details are not available for this response.',
    });

    const ctx: ResponseContext = {
      ...baseCtx,
      retrievedSchema: undefined,
    };

    const result = await handleMetaQuestion('What columns were available?', ctx, 'test-key');

    expect(result).toBe('Schema details are not available for this response.');
    const promptText = mockGenerateContent.mock.calls[0][0].contents[0].parts[0].text;
    expect(promptText).toContain('Not available');
  });

  it('throws on empty response from Gemini', async () => {
    mockGenerateContent.mockResolvedValue({ text: '' });

    await expect(
      handleMetaQuestion('Why?', baseCtx, 'test-key'),
    ).rejects.toThrow('Empty response from Gemini');
  });
});
