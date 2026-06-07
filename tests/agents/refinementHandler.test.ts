import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildRefinementInput } from '../../src/agents/refinementHandler.js';
import { generateSql } from '../../src/agents/sqlGenerator.js';
import type { ResponseContext } from '../../src/types.js';
import type { TableContext } from '../../src/dbt/types.js';

const mockGenerateContent = vi.fn();
vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    models = { generateContent: mockGenerateContent };
  },
}));

const baseCtx: ResponseContext = {
  responseId: 'resp-1',
  threadTs: 'thread-1',
  statusMsgTs: 'status-1',
  clarifiedQuestion: 'What is total revenue?',
  assumptions: [],
  reasoningChain: '',
  generatedSql: 'SELECT SUM(amount) FROM orders',
  explanation: 'Total revenue',
  tablesUsed: ['orders'],
  confidence: 'high',
  primaryAgentConfidence: 'high',
  queryResults: { rowCount: 1, columnNames: ['total'], bytesProcessed: 1024 },
  pipelineDurationMs: 2000,
  traceId: 'trace-1',
  createdAt: new Date(),
  groundingCitations: [],
  teachingsUsed: [],
  supervisorVerdict: 'pass',
  supervisorNotes: '',
};

const mockTables: TableContext[] = [
  {
    name: 'analytics.orders',
    schema: 'analytics',
    description: 'Orders',
    materialization: 'table',
    columns: [
      { name: 'amount', description: 'Amount', dataType: 'FLOAT64', meta: {} },
      { name: 'region', description: 'Region', dataType: 'STRING', meta: {} },
    ],
    sampleDDL: 'CREATE TABLE `analytics.orders` (amount FLOAT64, region STRING);',
    dependsOn: [],
    tags: [],
  },
];

const defaultResponse = {
  text: JSON.stringify({
    sql: 'SELECT region, SUM(amount) FROM orders GROUP BY 1',
    explanation: 'Revenue by region',
    tables_used: ['analytics.orders'],
    confidence: 'high',
    assumptions: [],
    reasoning_chain: 'Added region grouping',
    headline: 'revenue by region',
  }),
};

describe('buildRefinementInput', () => {
  it('constructs compositeQuestion merging original + refinement', () => {
    const result = buildRefinementInput('Break it down by region', baseCtx);

    expect(result.compositeQuestion).toContain('What is total revenue?');
    expect(result.compositeQuestion).toContain('Break it down by region');
    expect(result.previousSql).toBe('SELECT SUM(amount) FROM orders');
  });
});

describe('generateSql with refinement hint', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGenerateContent.mockResolvedValue(defaultResponse);
  });

  it('includes refinement section (not error section) in system prompt', async () => {
    await generateSql({
      question: 'What is total revenue? Break it down by region',
      tables: mockTables,
      threadContext: [],
      apiKey: 'test-key',
      previousAttempt: {
        sql: 'SELECT SUM(amount) FROM orders',
        error: '',
        refinement: 'Break it down by region',
      },
    });

    const callArgs = mockGenerateContent.mock.calls[0][0];
    const systemPrompt = callArgs.config.systemInstruction;
    expect(systemPrompt).toContain('PREVIOUS SQL (user wants a modification)');
    expect(systemPrompt).toContain('Break it down by region');
    expect(systemPrompt).toContain('SELECT SUM(amount) FROM orders');
    // Should NOT contain error retry language
    expect(systemPrompt).not.toContain('failed validation');
    expect(systemPrompt).not.toContain('Fix the error');
  });

  it('preserves existing error retry behavior when refinement is absent', async () => {
    await generateSql({
      question: 'What is total revenue?',
      tables: mockTables,
      threadContext: [],
      apiKey: 'test-key',
      previousAttempt: {
        sql: 'SELECT SUM(bad_col) FROM orders',
        error: 'Column bad_col not found',
      },
    });

    const callArgs = mockGenerateContent.mock.calls[0][0];
    const systemPrompt = callArgs.config.systemInstruction;
    expect(systemPrompt).toContain('PREVIOUS ATTEMPT (failed validation)');
    expect(systemPrompt).toContain('Column bad_col not found');
    expect(systemPrompt).toContain('Fix the error');
    // Should NOT contain refinement language
    expect(systemPrompt).not.toContain('user wants a modification');
  });
});
