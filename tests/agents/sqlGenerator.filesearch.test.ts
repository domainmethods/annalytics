import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generateSql } from '../../src/agents/sqlGenerator.js';
import type { TableContext } from '../../src/dbt/types.js';

const mockGenerateContent = vi.fn();
vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    models = { generateContent: mockGenerateContent };
  },
}));

const mockTable: TableContext = {
  name: 'analytics.fct_orders',
  schema: 'analytics',
  description: 'Orders fact table',
  materialization: 'table',
  columns: [
    { name: 'order_id', description: 'Primary key', dataType: 'STRING', meta: {} },
    { name: 'total_amount', description: 'Total USD', dataType: 'FLOAT64', meta: {} },
  ],
  sampleDDL: 'CREATE TABLE `analytics.fct_orders` (order_id STRING, total_amount FLOAT64);',
  dependsOn: [],
  tags: [],
};

const baseResponse = {
  sql: 'SELECT SUM(total_amount) FROM `analytics.fct_orders`',
  explanation: 'Sums total amount',
  tables_used: ['analytics.fct_orders'],
  confidence: 'high',
  assumptions: [],
  reasoning_chain: 'Simple sum',
  headline: 'total amount across orders',
};

describe('generateSql — File Search integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('includes fileSearch tool in config when store ID is provided', async () => {
    mockGenerateContent.mockResolvedValue({
      text: JSON.stringify(baseResponse),
      candidates: [{ groundingMetadata: { groundingChunks: [] } }],
    });

    await generateSql({
      question: 'revenue?',
      tables: [mockTable],
      threadContext: [],
      apiKey: 'key',
      fileSearchStoreId: 'stores/my-store',
    });

    const call = mockGenerateContent.mock.calls[0][0];
    expect(call.config.tools).toBeDefined();
    expect(call.config.tools[0].fileSearch).toBeDefined();
    expect(call.config.tools[0].fileSearch.fileSearchStoreNames).toContain('stores/my-store');
  });

  it('describes File Search as teachings plus reference cards', async () => {
    mockGenerateContent.mockResolvedValue({
      text: JSON.stringify(baseResponse),
      candidates: [{ groundingMetadata: { groundingChunks: [] } }],
    });

    await generateSql({
      question: 'revenue?',
      tables: [mockTable],
      threadContext: [],
      apiKey: 'key',
      fileSearchStoreId: 'stores/my-store',
    });

    const call = mockGenerateContent.mock.calls[0][0];
    expect(call.config.systemInstruction).toContain('KNOWLEDGE CONTEXT');
    expect(call.config.systemInstruction).toContain('teachings');
    expect(call.config.systemInstruction).toContain('reference cards');
    expect(call.config.systemInstruction).toContain('treat that card as authoritative');
  });

  it('does NOT include tools when store ID is not provided', async () => {
    mockGenerateContent.mockResolvedValue({
      text: JSON.stringify(baseResponse),
    });

    await generateSql({
      question: 'revenue?',
      tables: [mockTable],
      threadContext: [],
      apiKey: 'key',
    });

    const call = mockGenerateContent.mock.calls[0][0];
    expect(call.config.tools).toBeUndefined();
  });

  it('extracts grounding citations from response metadata', async () => {
    mockGenerateContent.mockResolvedValue({
      text: JSON.stringify(baseResponse),
      candidates: [{
        groundingMetadata: {
          groundingChunks: [
            {
              retrievedContext: {
                uri: 'revenue-monthly',
                text: 'Revenue uses fct_orders with order_status = completed',
              },
            },
          ],
        },
      }],
    });

    const result = await generateSql({
      question: 'revenue?',
      tables: [mockTable],
      threadContext: [],
      apiKey: 'key',
      fileSearchStoreId: 'stores/my-store',
    });

    expect(result.groundingCitations).toHaveLength(1);
    expect(result.groundingCitations[0].sourceFile).toBe('revenue-monthly');
    expect(result.groundingCitations[0].chunkText).toContain('fct_orders');
  });

  it('derives citation source names from synced markdown headers when uri is absent', async () => {
    mockGenerateContent.mockResolvedValue({
      text: JSON.stringify(baseResponse),
      candidates: [{
        groundingMetadata: {
          groundingChunks: [
            {
              retrievedContext: {
                uri: '',
                text: '# ReferenceCard: revenue-canonical-definition\nCanonical table: analytics.fct_orders',
              },
            },
            {
              retrievedContext: {
                text: '# Teaching: revenue-monthly\nUse completed orders',
              },
            },
          ],
        },
      }],
    });

    const result = await generateSql({
      question: 'revenue?',
      tables: [mockTable],
      threadContext: [],
      apiKey: 'key',
      fileSearchStoreId: 'stores/my-store',
    });

    expect(result.groundingCitations.map(c => c.sourceFile)).toEqual([
      'reference_card:revenue-canonical-definition',
      'teaching:revenue-monthly',
    ]);
  });

  it('falls back gracefully when File Search errors', async () => {
    // First call fails (with File Search)
    mockGenerateContent
      .mockRejectedValueOnce(new Error('File Search unavailable'))
      .mockResolvedValueOnce({
        text: JSON.stringify(baseResponse),
      });

    const result = await generateSql({
      question: 'revenue?',
      tables: [mockTable],
      threadContext: [],
      apiKey: 'key',
      fileSearchStoreId: 'stores/my-store',
    });

    expect(mockGenerateContent).toHaveBeenCalledTimes(2);
    // Second call should not have tools
    const secondCall = mockGenerateContent.mock.calls[1][0];
    expect(secondCall.config.tools).toBeUndefined();
    expect(result.sql).toBeDefined();
  });

  it('includes sample rows in system prompt when provided', async () => {
    mockGenerateContent.mockResolvedValue({
      text: JSON.stringify(baseResponse),
    });

    const sampleRows = new Map([
      ['analytics.fct_orders', {
        rows: [{ order_id: '1', total_amount: 100 }],
        stale: false,
      }],
    ]);

    await generateSql({
      question: 'revenue?',
      tables: [mockTable],
      threadContext: [],
      apiKey: 'key',
      sampleRows,
    });

    const call = mockGenerateContent.mock.calls[0][0];
    expect(call.config.systemInstruction).toContain('SAMPLE DATA');
    expect(call.config.systemInstruction).toContain('analytics.fct_orders');
  });
});
