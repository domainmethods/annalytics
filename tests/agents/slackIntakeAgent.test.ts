import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockGenerateContent = vi.fn();

vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    models = { generateContent: mockGenerateContent };
  },
}));

import { classifySlackIntake } from '../../src/agents/slackIntakeAgent.js';

function modelText(text: string) {
  return { text };
}

describe('classifySlackIntake', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns a model-generated immediate response for a greeting', async () => {
    mockGenerateContent.mockResolvedValue(modelText(JSON.stringify({
      route: 'immediate_response',
      responseText: 'Hi. Ask me an analytics question with a metric and timeframe.',
      reasoning: 'Greeting without analytics request.',
    })));

    const result = await classifySlackIntake('hi', 'api-key');

    expect(result.route).toBe('immediate_response');
    expect(result.responseText).toBe('Hi. Ask me an analytics question with a metric and timeframe.');
    expect(mockGenerateContent).toHaveBeenCalledTimes(1);
    expect(mockGenerateContent.mock.calls[0][0].model).toBe('gemini-flash-latest');
    expect(mockGenerateContent.mock.calls[0][0].config.responseMimeType).toBe('application/json');
    expect(mockGenerateContent.mock.calls[0][0].config.responseJsonSchema).toBeDefined();
  });

  it('returns a model-generated immediate response for a capability question', async () => {
    mockGenerateContent.mockResolvedValue(modelText(JSON.stringify({
      route: 'immediate_response',
      responseText: 'I can help with analytics questions from your modeled data. Include a metric, timeframe, and grouping if needed.',
      reasoning: 'Capability question.',
    })));

    const result = await classifySlackIntake('what can you do?', 'api-key');

    expect(result.route).toBe('immediate_response');
    expect(result.responseText).toContain('modeled data');
  });

  it('routes substantive analytics questions to the analytics pipeline', async () => {
    mockGenerateContent.mockResolvedValue(modelText(JSON.stringify({
      route: 'analytics_pipeline',
      responseText: null,
      reasoning: 'Asks for metric over a time period.',
    })));

    const result = await classifySlackIntake('show leads last month by channel', 'api-key');

    expect(result).toEqual({
      route: 'analytics_pipeline',
      responseText: null,
      reasoning: 'Asks for metric over a time period.',
    });
  });

  it('routes vague analytics prompts to the analytics pipeline', async () => {
    mockGenerateContent.mockResolvedValue(modelText(JSON.stringify({
      route: 'analytics_pipeline',
      responseText: null,
      reasoning: 'Traffic and month imply an analytics request.',
    })));

    const result = await classifySlackIntake('traffic last month?', 'api-key');

    expect(result.route).toBe('analytics_pipeline');
  });

  it('falls back to the analytics pipeline on invalid JSON', async () => {
    mockGenerateContent.mockResolvedValue(modelText('not json'));

    const result = await classifySlackIntake('hi', 'api-key');

    expect(result.route).toBe('analytics_pipeline');
    expect(result.responseText).toBeNull();
    expect(result.reasoning).toContain('fallback');
  });

  it('falls back when immediate response text is empty', async () => {
    mockGenerateContent.mockResolvedValue(modelText(JSON.stringify({
      route: 'immediate_response',
      responseText: '',
      reasoning: 'Greeting.',
    })));

    const result = await classifySlackIntake('hello', 'api-key');

    expect(result.route).toBe('analytics_pipeline');
  });

  it('falls back when immediate response text contains unsafe implementation details', async () => {
    mockGenerateContent.mockResolvedValue(modelText(JSON.stringify({
      route: 'immediate_response',
      responseText: 'I will use dbt and File Search to inspect project.dataset.table.',
      reasoning: 'Unsafe implementation details.',
    })));

    const result = await classifySlackIntake('help', 'api-key');

    expect(result.route).toBe('analytics_pipeline');
  });

  it('falls back when immediate response text contains a project identifier', async () => {
    mockGenerateContent.mockResolvedValue(modelText(JSON.stringify({
      route: 'immediate_response',
      responseText: 'I can query project alpha-prod-123456 for you.',
      reasoning: 'Unsafe project identifier.',
    })));

    const result = await classifySlackIntake('help', 'api-key');

    expect(result.route).toBe('analytics_pipeline');
  });

  it('falls back on rejected model calls', async () => {
    mockGenerateContent.mockRejectedValue(new Error('Gemini unavailable'));

    const result = await classifySlackIntake('hi', 'api-key');

    expect(result.route).toBe('analytics_pipeline');
    expect(result.responseText).toBeNull();
  });

  it('falls back when the intake call times out', async () => {
    vi.useFakeTimers();
    mockGenerateContent.mockReturnValue(new Promise(() => {}));

    const resultPromise = classifySlackIntake('hi', 'api-key', { timeoutMs: 10 });

    await vi.advanceTimersByTimeAsync(10);
    await expect(resultPromise).resolves.toMatchObject({
      route: 'analytics_pipeline',
      responseText: null,
    });
  });

  it('preserves conversational prose that incidentally contains select and from', async () => {
    mockGenerateContent.mockResolvedValue(modelText(JSON.stringify({
      route: 'immediate_response',
      responseText: 'You can select a metric and I will pull the numbers from your data.',
      reasoning: 'Capability framing, not SQL.',
    })));

    const result = await classifySlackIntake('what can you do?', 'api-key');

    expect(result.route).toBe('immediate_response');
    expect(result.responseText).toBe('You can select a metric and I will pull the numbers from your data.');
  });

  it('falls back when immediate response text contains fenced SQL', async () => {
    mockGenerateContent.mockResolvedValue(modelText(JSON.stringify({
      route: 'immediate_response',
      responseText: 'Sure, here is a query:\n```\nSELECT 1\n```',
      reasoning: 'Leaked SQL.',
    })));

    const result = await classifySlackIntake('help', 'api-key');

    expect(result.route).toBe('analytics_pipeline');
  });

  it('falls back when immediate response text contains inline SQL over a qualified table', async () => {
    mockGenerateContent.mockResolvedValue(modelText(JSON.stringify({
      route: 'immediate_response',
      responseText: 'Run SELECT revenue FROM sales.orders to see it.',
      reasoning: 'Leaked SQL with a qualified table.',
    })));

    const result = await classifySlackIntake('help', 'api-key');

    expect(result.route).toBe('analytics_pipeline');
  });

  it('uses GEMINI_FLASH_MODEL when configured', async () => {
    vi.stubEnv('GEMINI_FLASH_MODEL', 'gemini-custom-flash');
    mockGenerateContent.mockResolvedValue(modelText(JSON.stringify({
      route: 'analytics_pipeline',
      responseText: null,
      reasoning: 'Data question.',
    })));

    await classifySlackIntake('show revenue', 'api-key');

    expect(mockGenerateContent.mock.calls[0][0].model).toBe('gemini-custom-flash');
  });
});
