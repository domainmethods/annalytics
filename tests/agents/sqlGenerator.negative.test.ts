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
  ],
  sampleDDL: 'CREATE TABLE `analytics.fct_orders` (order_id STRING);',
  dependsOn: [],
  tags: [],
};

const baseResponse = {
  sql: 'SELECT COUNT(*) FROM `analytics.fct_orders`',
  explanation: 'Counts orders',
  tables_used: ['analytics.fct_orders'],
  confidence: 'high',
  assumptions: [],
  reasoning_chain: 'Count all orders',
  headline: 'total order count',
};

describe('generateSql — Negative Example Injection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('includes PREVIOUS ATTEMPT block when negativeExample provided', async () => {
    mockGenerateContent.mockResolvedValue({
      text: JSON.stringify(baseResponse),
    });

    await generateSql({
      question: 'How many orders?',
      tables: [mockTable],
      threadContext: [],
      apiKey: 'key',
      negativeExample: {
        sql: 'SELECT SUM(total_amount) FROM table',
        explanation: 'Wrong approach',
        userFeedback: 'I asked for count not sum',
      },
    });

    const call = mockGenerateContent.mock.calls[0][0];
    const prompt = call.config.systemInstruction;
    expect(prompt).toContain('PREVIOUS ATTEMPT (rejected by user)');
    expect(prompt).toContain('SELECT SUM(total_amount) FROM table');
    expect(prompt).toContain('I asked for count not sum');
  });

  it('includes "Do NOT repeat" instruction', async () => {
    mockGenerateContent.mockResolvedValue({
      text: JSON.stringify(baseResponse),
    });

    await generateSql({
      question: 'How many orders?',
      tables: [mockTable],
      threadContext: [],
      apiKey: 'key',
      negativeExample: {
        sql: 'SELECT SUM(x) FROM t',
        explanation: 'Bad',
        userFeedback: 'Wrong',
      },
    });

    const call = mockGenerateContent.mock.calls[0][0];
    expect(call.config.systemInstruction).toContain('Do NOT repeat this approach');
  });

  it('does NOT include previous attempt when negativeExample is undefined', async () => {
    mockGenerateContent.mockResolvedValue({
      text: JSON.stringify(baseResponse),
    });

    await generateSql({
      question: 'How many orders?',
      tables: [mockTable],
      threadContext: [],
      apiKey: 'key',
    });

    const call = mockGenerateContent.mock.calls[0][0];
    expect(call.config.systemInstruction).not.toContain('PREVIOUS ATTEMPT (rejected by user)');
  });
});
