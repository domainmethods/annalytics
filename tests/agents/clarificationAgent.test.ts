import { describe, it, expect, vi, beforeEach } from 'vitest';
import { classifyQuestion } from '../../src/agents/clarificationAgent.js';
import type { ClarificationResult } from '../../src/agents/types.js';
import type { KnowledgeSummary, TeachingSummary } from '../../src/teachings/types.js';
import type { ThreadMessage } from '../../src/types.js';

const mockGenerateContent = vi.fn();
vi.mock('@google/genai', () => ({
  GoogleGenAI: vi.fn(function () {
    return {
      models: { generateContent: mockGenerateContent },
    };
  }),
}));

const summaries: TeachingSummary[] = [
  { term: 'revenue', definition: 'Total completed order amount', canonical_table: 'analytics.fct_orders' },
  { term: 'churn', definition: 'No orders in 90 days', canonical_table: 'analytics.dim_customers' },
];

function mockLLMResponse(result: ClarificationResult) {
  mockGenerateContent.mockResolvedValue({
    text: JSON.stringify(result),
  });
}

describe('classifyQuestion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns HIGH confidence for unambiguous question', async () => {
    const highResult: ClarificationResult = {
      route: 'data_query',
      confidence: 'high',
      reasoning: 'Specific date range and metric',
      ambiguities: [],
      assumptions: [],
      clarifying_questions: [],
      resolved_question: 'How many orders were placed yesterday?',
    };
    mockLLMResponse(highResult);

    const result = await classifyQuestion(
      'How many orders yesterday?', [], summaries, 'key',
    );

    expect(result.confidence).toBe('high');
    expect(result.ambiguities).toHaveLength(0);
  });

  it('returns MEDIUM confidence with assumptions for broad question', async () => {
    const medResult: ClarificationResult = {
      route: 'data_query',
      confidence: 'medium',
      reasoning: 'Revenue could mean gross or net',
      ambiguities: ['revenue type unclear'],
      assumptions: ['Using total_amount (gross revenue)'],
      clarifying_questions: [],
      resolved_question: 'Show total gross revenue by month',
    };
    mockLLMResponse(medResult);

    const result = await classifyQuestion(
      'Show me revenue', [], summaries, 'key',
    );

    expect(result.confidence).toBe('medium');
    expect(result.assumptions.length).toBeGreaterThan(0);
  });

  it('returns LOW confidence with clarifying questions for vague question', async () => {
    const lowResult: ClarificationResult = {
      route: 'data_query',
      confidence: 'low',
      reasoning: 'Too vague to determine metric or timeframe',
      ambiguities: ['metric unclear', 'timeframe unclear'],
      assumptions: [],
      clarifying_questions: ['What metric are you interested in?', 'What time period?'],
      resolved_question: '',
    };
    mockLLMResponse(lowResult);

    const result = await classifyQuestion(
      'How are we doing?', [], summaries, 'key',
    );

    expect(result.confidence).toBe('low');
    expect(result.clarifying_questions.length).toBeGreaterThan(0);
  });

  it('includes teaching summaries in the prompt as available context', async () => {
    mockLLMResponse({
      route: 'data_query',
      confidence: 'high',
      reasoning: 'clear',
      ambiguities: [],
      assumptions: [],
      clarifying_questions: [],
      resolved_question: 'query',
    });

    await classifyQuestion('revenue?', [], summaries, 'key');

    const call = mockGenerateContent.mock.calls[0][0];
    expect(call.config.systemInstruction).toContain('revenue');
    expect(call.config.systemInstruction).toContain('analytics.fct_orders');
    expect(call.config.systemInstruction).toContain('churn');
  });

  it('includes ReferenceCard aliases and routing triggers in the prompt', async () => {
    mockLLMResponse({
      route: 'data_query',
      confidence: 'high',
      reasoning: 'clear',
      ambiguities: [],
      assumptions: [],
      clarifying_questions: [],
      resolved_question: 'query',
    });
    const knowledgeSummaries: KnowledgeSummary[] = [{
      kind: 'reference_card',
      id: 'revenue-canonical-definition',
      term: 'Canonical Revenue Definition',
      definition: 'Canonical revenue metric.',
      canonical_table: 'analytics.fct_orders',
      canonical_metric: 'total_amount',
      aliases: ['revenue', 'sales'],
      routing_triggers: ['total revenue'],
    }];

    await classifyQuestion('total revenue?', [], knowledgeSummaries, 'key');

    const call = mockGenerateContent.mock.calls[0][0];
    expect(call.config.systemInstruction).toContain('ReferenceCard revenue-canonical-definition');
    expect(call.config.systemInstruction).toContain('revenue, sales');
    expect(call.config.systemInstruction).toContain('total revenue');
    expect(call.config.systemInstruction).toContain('metric: total_amount');
  });

  it('uses GEMINI_FLASH_MODEL when configured', async () => {
    vi.stubEnv('GEMINI_FLASH_MODEL', 'gemini-3-flash-preview');
    vi.resetModules();
    const { classifyQuestion: classifyQuestionWithEnv } = await import('../../src/agents/clarificationAgent.js');
    mockLLMResponse({
      route: 'data_query',
      confidence: 'high',
      reasoning: 'clear',
      ambiguities: [],
      assumptions: [],
      clarifying_questions: [],
      resolved_question: 'query',
    });

    await classifyQuestionWithEnv('revenue?', [], summaries, 'key');

    const call = mockGenerateContent.mock.calls[0][0];
    expect(call.model).toBe('gemini-3-flash-preview');
    vi.unstubAllEnvs();
  });

  it('includes thread context in the prompt', async () => {
    mockLLMResponse({
      route: 'data_query',
      confidence: 'high',
      reasoning: 'clear with context',
      ambiguities: [],
      assumptions: [],
      clarifying_questions: [],
      resolved_question: 'breakdown by region',
    });

    const thread: ThreadMessage[] = [
      { role: 'user', content: 'Show me revenue' },
      { role: 'assistant', content: 'Here is the revenue data...' },
    ];

    await classifyQuestion('Break it down by region', thread, summaries, 'key');

    const call = mockGenerateContent.mock.calls[0][0];
    expect(call.contents).toHaveLength(3); // 2 thread + 1 new question
    expect(call.contents[0].parts[0].text).toBe('Show me revenue');
    expect(call.contents[1].role).toBe('model');
  });

  it('sets route to dbt_status for dbt questions', async () => {
    mockLLMResponse({
      route: 'dbt_status',
      confidence: 'high',
      reasoning: 'dbt status question',
      ambiguities: [],
      assumptions: [],
      clarifying_questions: [],
      resolved_question: 'What is the status of the last dbt run?',
    });

    const result = await classifyQuestion(
      'When did dbt last run?', [], summaries, 'key',
    );

    expect(result.route).toBe('dbt_status');
  });
});
