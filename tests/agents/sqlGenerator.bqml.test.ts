import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generateSql } from '../../src/agents/sqlGenerator.js';
import type { TableContext } from '../../src/dbt/types.js';

// Mock the GenAI SDK using class syntax (required for `new` instantiation)
const mockGenerateContent = vi.fn();
vi.mock('@google/genai', () => ({
  GoogleGenAI: vi.fn(function () {
    return { models: { generateContent: mockGenerateContent } };
  }),
}));

const mockTables: TableContext[] = [
  {
    name: 'analytics.fct_orders',
    schema: 'analytics',
    description: 'All completed customer orders',
    materialization: 'table',
    columns: [
      { name: 'order_id', description: 'Primary key', dataType: 'STRING', meta: {} },
    ],
    sampleDDL: 'CREATE TABLE `analytics.fct_orders` (order_id STRING);',
    dependsOn: [],
    tags: [],
  },
];

const mockResponse = {
  text: JSON.stringify({
    sql: 'SELECT * FROM ML.FORECAST(MODEL `project.dataset.my_model`, STRUCT(7 AS horizon, 0.95 AS confidence_level))',
    explanation: 'Forecast using ARIMA_PLUS model',
    tables_used: ['analytics.fct_orders'],
    confidence: 'high',
    assumptions: ['Model already exists'],
    reasoning_chain: 'User wants forecast. Used ML.FORECAST.',
    headline: 'sales forecast for the next 7 days',
  }),
};

describe('generateSql BQML hints', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGenerateContent.mockResolvedValue(mockResponse);
  });

  it('includes ML.FORECAST signature when bqml_hint is forecast', async () => {
    await generateSql({
      question: 'Forecast sales for next 7 days',
      tables: mockTables,
      threadContext: [],
      apiKey: 'test-api-key',
      bqml_hint: 'forecast',
    });

    const callArgs = mockGenerateContent.mock.calls[0][0];
    const systemInstruction = callArgs.config?.systemInstruction || callArgs.systemInstruction;
    expect(systemInstruction).toContain('ML.FORECAST');
    expect(systemInstruction).toContain('BIGQUERY ML FUNCTIONS AVAILABLE');
  });

  it('includes ML.DETECT_ANOMALIES signature when bqml_hint is anomaly', async () => {
    mockGenerateContent.mockResolvedValue({
      text: JSON.stringify({
        sql: 'SELECT * FROM ML.DETECT_ANOMALIES(MODEL `project.dataset.anomaly_model`, STRUCT(0.05 AS contamination))',
        explanation: 'Detect anomalies',
        tables_used: ['analytics.fct_orders'],
        confidence: 'high',
        assumptions: [],
        reasoning_chain: 'Used ML.DETECT_ANOMALIES.',
        headline: 'detected anomalies',
      }),
    });

    await generateSql({
      question: 'Find anomalies in order data',
      tables: mockTables,
      threadContext: [],
      apiKey: 'test-api-key',
      bqml_hint: 'anomaly',
    });

    const callArgs = mockGenerateContent.mock.calls[0][0];
    const systemInstruction = callArgs.config?.systemInstruction || callArgs.systemInstruction;
    expect(systemInstruction).toContain('ML.DETECT_ANOMALIES');
    expect(systemInstruction).toContain('BIGQUERY ML FUNCTIONS AVAILABLE');
  });

  it('does NOT include BQML section when bqml_hint is null', async () => {
    await generateSql({
      question: 'What is total revenue?',
      tables: mockTables,
      threadContext: [],
      apiKey: 'test-api-key',
      bqml_hint: null,
    });

    const callArgs = mockGenerateContent.mock.calls[0][0];
    const systemInstruction = callArgs.config?.systemInstruction || callArgs.systemInstruction;
    expect(systemInstruction).not.toContain('ML.FORECAST');
    expect(systemInstruction).not.toContain('BIGQUERY ML FUNCTIONS AVAILABLE');
  });
});
