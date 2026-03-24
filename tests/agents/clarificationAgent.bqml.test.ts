import { describe, it, expect, vi, beforeEach } from 'vitest';
import { classifyQuestion } from '../../src/agents/clarificationAgent.js';
import type { ClarificationResult } from '../../src/agents/types.js';
import type { TeachingSummary } from '../../src/teachings/types.js';
import type { ThreadMessage } from '../../src/types.js';

const mockGenerateContent = vi.fn();
vi.mock('@google/genai', () => ({
  GoogleGenAI: vi.fn(function () {
    return {
      models: { generateContent: mockGenerateContent },
    };
  }),
}));

function mockLLMResponse(result: ClarificationResult) {
  mockGenerateContent.mockResolvedValue({
    text: JSON.stringify(result),
  });
}

describe('classifyQuestion — bqml_hint', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns bqml_hint: forecast when LLM response includes it', async () => {
    const result: ClarificationResult = {
      route: 'data_query',
      confidence: 'high',
      reasoning: 'Time-series forecasting question',
      ambiguities: [],
      assumptions: [],
      clarifying_questions: [],
      resolved_question: 'Forecast revenue for the next 30 days',
      bqml_hint: 'forecast',
    };
    mockLLMResponse(result);

    const output = await classifyQuestion(
      'Forecast revenue for the next 30 days',
      [] as ThreadMessage[],
      [] as TeachingSummary[],
      'test-api-key',
    );

    expect(output.bqml_hint).toBe('forecast');
  });

  it('returns bqml_hint as undefined when LLM response omits it', async () => {
    const result: ClarificationResult = {
      route: 'data_query',
      confidence: 'high',
      reasoning: 'Standard aggregation question',
      ambiguities: [],
      assumptions: [],
      clarifying_questions: [],
      resolved_question: 'How many orders were placed last week?',
    };
    mockLLMResponse(result);

    const output = await classifyQuestion(
      'How many orders last week?',
      [] as ThreadMessage[],
      [] as TeachingSummary[],
      'test-api-key',
    );

    expect(output.bqml_hint).toBeUndefined();
  });

  it('returns bqml_hint: anomaly when LLM response includes it', async () => {
    const result: ClarificationResult = {
      route: 'data_query',
      confidence: 'high',
      reasoning: 'Anomaly detection question',
      ambiguities: [],
      assumptions: [],
      clarifying_questions: [],
      resolved_question: 'Detect anomalies in daily transaction volume',
      bqml_hint: 'anomaly',
    };
    mockLLMResponse(result);

    const output = await classifyQuestion(
      'Find anomalies in our transaction volume',
      [] as ThreadMessage[],
      [] as TeachingSummary[],
      'test-api-key',
    );

    expect(output.bqml_hint).toBe('anomaly');
  });
});
