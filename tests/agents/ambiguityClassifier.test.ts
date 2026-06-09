import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  classifyAmbiguity,
  type AmbiguityClassification,
} from '../../src/agents/ambiguityClassifier.js';

const mockGenerateContent = vi.fn();
vi.mock('@google/genai', () => ({
  GoogleGenAI: vi.fn(function () {
    return {
      models: { generateContent: mockGenerateContent },
    };
  }),
}));

function mockLLMResponse(result: AmbiguityClassification) {
  mockGenerateContent.mockResolvedValue({
    text: JSON.stringify(result),
  });
}

describe('classifyAmbiguity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('classifies reusable business-definition uncertainty as org_knowledge', async () => {
    mockLLMResponse({
      type: 'org_knowledge',
      question: 'Which revenue table is the source of truth?',
      domain: 'revenue',
      reasoning: 'The resolver is an institutional table ownership decision.',
    });

    const result = await classifyAmbiguity({
      question: 'Which revenue table should I use?',
      ambiguities: ['source-of-truth table unclear'],
      clarifyingQuestions: ['Which revenue table should be used?'],
      threadContext: [],
    }, 'key');

    expect(result.type).toBe('org_knowledge');
    expect(result.domain).toBe('revenue');
    const call = mockGenerateContent.mock.calls[0][0];
    expect(call.model).toBe('gemini-3.1-flash-lite');
    expect(call.config.thinkingConfig).toEqual({ thinkingLevel: 'minimal' });
  });

  it('classifies requester-specific missing detail as user_intent', async () => {
    mockLLMResponse({
      type: 'user_intent',
      question: 'Which time period should I use?',
      domain: 'revenue',
      reasoning: 'The user must choose the date range for this request.',
    });

    const result = await classifyAmbiguity({
      question: 'Show me sales',
      ambiguities: ['time period unclear'],
      clarifyingQuestions: ['Which time period should I use?'],
      threadContext: [],
    }, 'key');

    expect(result.type).toBe('user_intent');
    expect(result.question).toBe('Which time period should I use?');
  });

  it('fails safe to user_intent when the model call fails', async () => {
    mockGenerateContent.mockRejectedValue(new Error('Gemini unavailable'));

    const result = await classifyAmbiguity({
      question: 'Show me sales',
      ambiguities: ['time period unclear'],
      clarifyingQuestions: ['Which time period should I use?'],
      threadContext: [],
    }, 'key');

    expect(result).toEqual({
      type: 'user_intent',
      question: 'Which time period should I use?',
      domain: 'unclassified',
      reasoning: 'fallback: ambiguity classifier unavailable or uncertain',
    });
  });
});
