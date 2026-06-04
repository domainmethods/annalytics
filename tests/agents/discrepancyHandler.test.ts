import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generateDiagnosticSql } from '../../src/agents/discrepancyHandler.js';
import type { ResponseContext } from '../../src/types.js';

const mockGenerateContent = vi.fn();
vi.mock('@google/genai', () => ({
  GoogleGenAI: vi.fn(function () {
    return { models: { generateContent: mockGenerateContent } };
  }),
}));

const baseCtx: ResponseContext = {
  responseId: 'resp-1',
  threadTs: '1234.5678',
  statusMsgTs: '1234.5679',
  clarifiedQuestion: 'What is total revenue by region?',
  assumptions: ['Using fct_orders'],
  reasoningChain: 'Selected fct_orders for revenue data',
  generatedSql: 'SELECT region, SUM(revenue) FROM fct_orders GROUP BY region',
  explanation: 'Grouped revenue by region',
  tablesUsed: ['fct_orders'],
  confidence: 'high',
  primaryAgentConfidence: 'high',
  queryResults: { rowCount: 5, columnNames: ['region', 'total_revenue'], bytesProcessed: 1000 },
  pipelineDurationMs: 3000,
  traceId: 'trace-1',
  createdAt: new Date(),
  groundingCitations: [],
  teachingsUsed: [],
  supervisorVerdict: 'pass',
  supervisorNotes: '',
};

describe('generateDiagnosticSql', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('generates diagnostic SQL from discrepancy and context', async () => {
    mockGenerateContent.mockResolvedValue({
      text: JSON.stringify({
        diagnosticSql: 'SELECT region, COUNT(*) FROM fct_orders GROUP BY region',
        explanation: 'Breaking down count by region to check distribution',
      }),
    });

    const result = await generateDiagnosticSql(
      'If total is $5M, how come APAC only shows $200K?',
      baseCtx,
      'test-key',
    );

    expect(result.diagnosticSql).toBe('SELECT region, COUNT(*) FROM fct_orders GROUP BY region');
    expect(result.explanation).toBe('Breaking down count by region to check distribution');
  });

  it('includes original SQL and result metadata in prompt', async () => {
    mockGenerateContent.mockResolvedValue({
      text: JSON.stringify({
        diagnosticSql: 'SELECT 1',
        explanation: 'test',
      }),
    });

    await generateDiagnosticSql('Numbers seem off', baseCtx, 'test-key');

    const callArgs = mockGenerateContent.mock.calls[0][0];
    const promptText = callArgs.contents[0].parts[0].text;
    expect(promptText).toContain(baseCtx.generatedSql);
    expect(promptText).toContain('5 rows');
    expect(promptText).toContain('region, total_revenue');
    expect(promptText).toContain('Numbers seem off');
  });

  it('uses Gemini Pro model with structured output', async () => {
    mockGenerateContent.mockResolvedValue({
      text: JSON.stringify({
        diagnosticSql: 'SELECT 1',
        explanation: 'test',
      }),
    });

    await generateDiagnosticSql('Discrepancy', baseCtx, 'test-key');

    const callArgs = mockGenerateContent.mock.calls[0][0];
    expect(callArgs.model).toBe('gemini-pro-latest');
    expect(callArgs.config.responseMimeType).toBe('application/json');
    expect(callArgs.config.responseJsonSchema).toBeDefined();
  });
});
