import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { generateSql } from '../../src/agents/sqlGenerator.js';
import type { TableContext } from '../../src/dbt/types.js';
import type { ThreadMessage } from '../../src/types.js';

// Mock the GenAI SDK
const mockGenerateContent = vi.fn();
vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    models = { generateContent: mockGenerateContent };
  },
}));

const mockTables: TableContext[] = [
  {
    name: 'analytics.fct_orders',
    schema: 'analytics',
    description: 'All completed customer orders',
    materialization: 'table',
    columns: [
      { name: 'order_id', description: 'Primary key', dataType: 'STRING', meta: {} },
      { name: 'total_amount', description: 'Total USD', dataType: 'FLOAT64', meta: {} },
      { name: 'order_date', description: 'Order date', dataType: 'DATE', meta: {} },
    ],
    sampleDDL: 'CREATE TABLE `analytics.fct_orders` (\n  order_id STRING,\n  total_amount FLOAT64,\n  order_date DATE\n);',
    dependsOn: [],
    tags: ['finance'],
  },
];

describe('generateSql', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns structured SQL generation result', async () => {
    mockGenerateContent.mockResolvedValue({
      text: JSON.stringify({
        sql: 'SELECT SUM(total_amount) AS revenue FROM `analytics.fct_orders`',
        explanation: 'Sums total_amount from fct_orders',
        tables_used: ['analytics.fct_orders'],
        confidence: 'high',
        assumptions: ['All time, all regions'],
        reasoning_chain: 'User wants total revenue. fct_orders has total_amount.',
        headline: 'total revenue across all orders',
      }),
    });

    const result = await generateSql({
      question: 'What is total revenue?',
      tables: mockTables,
      threadContext: [],
      apiKey: 'test-api-key',
    });

    expect(result.sql).toContain('SELECT');
    expect(result.sql).toContain('fct_orders');
    expect(result.confidence).toBe('high');
    expect(result.tablesUsed).toContain('analytics.fct_orders');
  });

  it('returns the headline field from the model response', async () => {
    mockGenerateContent.mockResolvedValue({
      text: JSON.stringify({
        sql: 'SELECT COUNT(DISTINCT visitor_id) FROM `analytics.fct_orders`',
        explanation: 'Counts distinct visitors this month',
        tables_used: ['analytics.fct_orders'],
        confidence: 'high',
        assumptions: [],
        reasoning_chain: 'User wants unique visitors.',
        headline: 'unique visitors this month',
      }),
    });

    const result = await generateSql({
      question: 'How many unique visitors this month?',
      tables: mockTables,
      threadContext: [],
      apiKey: 'test-api-key',
    });

    expect(result.headline).toBe('unique visitors this month');
  });

  it('throws when the model omits headline', async () => {
    mockGenerateContent.mockResolvedValue({
      text: JSON.stringify({
        sql: 'SELECT 1',
        explanation: 'test',
        tables_used: [],
        confidence: 'high',
        assumptions: [],
        reasoning_chain: 'test',
      }),
    });

    await expect(
      generateSql({ question: 'test', tables: mockTables, threadContext: [], apiKey: 'test-api-key' }),
    ).rejects.toThrow(/headline/);
  });

  it('includes table DDLs in the prompt', async () => {
    mockGenerateContent.mockResolvedValue({
      text: JSON.stringify({
        sql: 'SELECT 1',
        explanation: 'test',
        tables_used: [],
        confidence: 'high',
        assumptions: [],
        reasoning_chain: 'test',
        headline: 'test',
      }),
    });

    await generateSql({ question: 'test', tables: mockTables, threadContext: [], apiKey: 'test-api-key' });

    const callArgs = mockGenerateContent.mock.calls[0][0];
    const systemPrompt = callArgs.config?.systemInstruction || callArgs.systemInstruction;
    expect(systemPrompt).toContain('analytics.fct_orders');
    expect(systemPrompt).toContain('FLOAT64');
  });

  it('includes thread context when provided', async () => {
    mockGenerateContent.mockResolvedValue({
      text: JSON.stringify({
        sql: 'SELECT 1',
        explanation: 'test',
        tables_used: [],
        confidence: 'high',
        assumptions: [],
        reasoning_chain: 'test',
        headline: 'test',
      }),
    });

    const threadContext: ThreadMessage[] = [
      { role: 'user', content: 'Show me revenue' },
      { role: 'assistant', content: 'Total revenue is $5M' },
    ];

    await generateSql({
      question: 'Break it down by region',
      tables: mockTables,
      threadContext,
      apiKey: 'test-api-key',
    });

    const callArgs = mockGenerateContent.mock.calls[0][0];
    const contents = callArgs.contents;
    expect(JSON.stringify(contents)).toContain('Show me revenue');
  });

  it('passes structured output schema config', async () => {
    mockGenerateContent.mockResolvedValue({
      text: JSON.stringify({
        sql: 'SELECT 1',
        explanation: 'test',
        tables_used: [],
        confidence: 'high',
        assumptions: [],
        reasoning_chain: 'test',
        headline: 'test',
      }),
    });

    await generateSql({ question: 'test', tables: mockTables, threadContext: [], apiKey: 'test-api-key' });

    const callArgs = mockGenerateContent.mock.calls[0][0];
    expect(callArgs.config.responseMimeType).toBe('application/json');
    expect(callArgs.config.responseJsonSchema).toBeDefined();
    expect(callArgs.config.responseJsonSchema.type).toBe('object');
  });

  it('defaults the resolved model to gemini-3.1-pro-preview', async () => {
    mockGenerateContent.mockResolvedValue({
      text: JSON.stringify({
        sql: 'SELECT 1',
        explanation: 'test',
        tables_used: [],
        confidence: 'high',
        assumptions: [],
        reasoning_chain: 'test',
        headline: 'test',
      }),
    });

    await generateSql({ question: 'test', tables: mockTables, threadContext: [], apiKey: 'test-api-key' });

    expect(mockGenerateContent.mock.calls[0][0].model).toBe('gemini-3.1-pro-preview');
  });

  // Regression: NODE_PROFILE_OVERRIDES for the sqlGenerator node must reach the
  // resolved model on the generateContent call. Previously config.gemini.model
  // shadowed the seam, so an override here had no effect.
  it('honors NODE_PROFILE_OVERRIDES for the sqlGenerator node', async () => {
    vi.stubEnv('NODE_PROFILE_OVERRIDES', JSON.stringify({
      sqlGenerator: { tier: 'flash', version: '3', thinkingLevel: 'minimal' },
    }));
    mockGenerateContent.mockResolvedValue({
      text: JSON.stringify({
        sql: 'SELECT 1',
        explanation: 'test',
        tables_used: [],
        confidence: 'high',
        assumptions: [],
        reasoning_chain: 'test',
        headline: 'test',
      }),
    });

    await generateSql({ question: 'test', tables: mockTables, threadContext: [], apiKey: 'test-api-key' });

    expect(mockGenerateContent.mock.calls[0][0].model).toBe('gemini-3-flash-preview');
  });

  it('treats retrieved ReferenceCards as binding operational constraints', async () => {
    mockGenerateContent.mockResolvedValue({
      text: JSON.stringify({
        sql: 'SELECT 1',
        explanation: 'test',
        tables_used: [],
        confidence: 'high',
        assumptions: [],
        reasoning_chain: 'test',
        headline: 'test',
      }),
    });

    await generateSql({
      question: 'test',
      tables: mockTables,
      threadContext: [],
      apiKey: 'test-api-key',
      fileSearchStoreId: 'test-store',
    });

    const callArgs = mockGenerateContent.mock.calls[0][0];
    const systemPrompt = callArgs.config.systemInstruction;
    expect(systemPrompt).toContain('Retrieved ReferenceCards are operational constraints');
    expect(systemPrompt).toContain('canonical table, canonical metric, grain, required filters, exclusions, and avoid-table guidance');
    expect(systemPrompt).toContain('Do not substitute a broader category for a narrower user term');
    expect(systemPrompt).toContain('prefer the mart column over reconstructing it from lower-grain staging or event sources');
  });
});
