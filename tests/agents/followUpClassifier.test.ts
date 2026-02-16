import { describe, it, expect, vi, beforeEach } from 'vitest';
import { classifyFollowUp } from '../../src/agents/followUpClassifier.js';

const mockGenerateContent = vi.fn();
vi.mock('@google/genai', () => ({
  GoogleGenAI: vi.fn(function () {
    return { models: { generateContent: mockGenerateContent } };
  }),
}));

const revenueThread = [
  { role: 'user' as const, content: 'What is total revenue?' },
  { role: 'assistant' as const, content: 'Total revenue is $5M from fct_orders.' },
];

describe('classifyFollowUp', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('classifies unrelated question as new_query', async () => {
    mockGenerateContent.mockResolvedValue({
      text: JSON.stringify({ intent: 'new_query', reasoning: 'Different topic' }),
    });

    const result = await classifyFollowUp('How many customers?', revenueThread, 'key');

    expect(result.intent).toBe('new_query');
  });

  it('classifies "break down by region" as refinement', async () => {
    mockGenerateContent.mockResolvedValue({
      text: JSON.stringify({ intent: 'refinement', reasoning: 'Modifies previous query grouping' }),
    });

    const result = await classifyFollowUp('Now break that down by region', revenueThread, 'key');

    expect(result.intent).toBe('refinement');
  });

  it('classifies "why did you use fct_orders?" as meta_question', async () => {
    mockGenerateContent.mockResolvedValue({
      text: JSON.stringify({ intent: 'meta_question', reasoning: 'Asking about reasoning' }),
    });

    const result = await classifyFollowUp('Why did you use fct_orders?', revenueThread, 'key');

    expect(result.intent).toBe('meta_question');
  });

  it('classifies "if total is $5M, how come Q4 is only $800K?" as discrepancy', async () => {
    mockGenerateContent.mockResolvedValue({
      text: JSON.stringify({ intent: 'discrepancy', reasoning: 'Numbers do not add up' }),
    });

    const result = await classifyFollowUp(
      'If total is $5M, how come Q4 is only $800K?',
      revenueThread,
      'key',
    );

    expect(result.intent).toBe('discrepancy');
  });
});
