import { describe, it, expect, vi, beforeEach } from 'vitest';
import { reviewSql, type SupervisorInput } from '../../src/agents/supervisorAgent.js';

const mockGenerateContent = vi.fn();
vi.mock('@google/genai', () => ({
  GoogleGenAI: vi.fn(function () {
    return { models: { generateContent: mockGenerateContent } };
  }),
}));

const baseInput: SupervisorInput = {
  userQuestion: 'What is total revenue?',
  clarifiedQuestion: 'What is total revenue from completed orders?',
  generatedSql: 'SELECT SUM(total_amount) FROM `analytics.fct_orders` WHERE status = "completed"',
  explanation: 'Sums total_amount for completed orders',
  reasoningChain: 'User wants revenue → fct_orders has total_amount → filter completed',
  groundingCitations: [],
  apiKey: 'test-key',
};

describe('reviewSql — Supervisor Agent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns PASS verdict for correct SQL', async () => {
    mockGenerateContent.mockResolvedValue({
      text: JSON.stringify({
        verdict: 'PASS',
        confidence: 'high',
        issues: [],
        suggestions: [],
        teaching_compliance: 'compliant',
      }),
    });

    const result = await reviewSql(baseInput);

    expect(result.verdict).toBe('PASS');
    expect(result.confidence).toBe('high');
    expect(result.issues).toHaveLength(0);
  });

  it('returns FAIL verdict with issues for incorrect SQL', async () => {
    mockGenerateContent.mockResolvedValue({
      text: JSON.stringify({
        verdict: 'FAIL',
        confidence: 'low',
        issues: ['Missing WHERE clause for date range', 'Wrong table used'],
        suggestions: ['Add date filter', 'Use fct_orders instead of dim_customers'],
        teaching_compliance: 'deviated',
      }),
    });

    const result = await reviewSql(baseInput);

    expect(result.verdict).toBe('FAIL');
    expect(result.issues).toHaveLength(2);
    expect(result.issues[0]).toContain('WHERE clause');
  });

  it('includes teaching compliance assessment', async () => {
    mockGenerateContent.mockResolvedValue({
      text: JSON.stringify({
        verdict: 'PASS',
        confidence: 'high',
        issues: [],
        suggestions: [],
        teaching_compliance: 'compliant',
      }),
    });

    const result = await reviewSql({
      ...baseInput,
      groundingCitations: [{
        sourceFile: 'revenue-monthly',
        chunkText: 'Revenue uses fct_orders with status = completed',
        relevanceScore: 0.95,
      }],
    });

    expect(result.teaching_compliance).toBe('compliant');
  });

  it('includes suggestions for FAIL verdict', async () => {
    mockGenerateContent.mockResolvedValue({
      text: JSON.stringify({
        verdict: 'FAIL',
        confidence: 'medium',
        issues: ['Incorrect join'],
        suggestions: ['Use LEFT JOIN instead of INNER JOIN'],
        teaching_compliance: 'no_relevant_teaching',
      }),
    });

    const result = await reviewSql(baseInput);

    expect(result.suggestions).toHaveLength(1);
    expect(result.suggestions[0]).toContain('LEFT JOIN');
  });

  it('includes grounding citations in the prompt', async () => {
    mockGenerateContent.mockResolvedValue({
      text: JSON.stringify({
        verdict: 'PASS',
        confidence: 'high',
        issues: [],
        suggestions: [],
        teaching_compliance: 'compliant',
      }),
    });

    await reviewSql({
      ...baseInput,
      groundingCitations: [{
        sourceFile: 'revenue-monthly',
        chunkText: 'Use fct_orders for revenue',
        relevanceScore: 0.9,
      }],
    });

    const call = mockGenerateContent.mock.calls[0][0];
    const prompt = call.contents[0].parts[0].text;
    expect(prompt).toContain('revenue-monthly');
    expect(prompt).toContain('Use fct_orders for revenue');
  });

  it('uses Gemini 3.0 Pro model', async () => {
    mockGenerateContent.mockResolvedValue({
      text: JSON.stringify({
        verdict: 'PASS',
        confidence: 'high',
        issues: [],
        suggestions: [],
        teaching_compliance: 'compliant',
      }),
    });

    await reviewSql(baseInput);

    const call = mockGenerateContent.mock.calls[0][0];
    expect(call.model).toBe('gemini-3.0-pro');
  });
});
