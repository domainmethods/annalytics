import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockGenerateContent, mockWarn } = vi.hoisted(() => ({
  mockGenerateContent: vi.fn(),
  mockWarn: vi.fn(),
}));

vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    models = { generateContent: mockGenerateContent };
  },
}));

vi.mock('../../src/logging.js', () => ({
  rootLogger: { warn: mockWarn, debug: vi.fn(), info: vi.fn(), error: vi.fn() },
  createLogger: () => ({ warn: mockWarn, debug: vi.fn(), info: vi.fn(), error: vi.fn() }),
  createTraceId: () => 'test-trace',
  logStage: vi.fn(),
}));

import { classifySlackIntake } from '../../src/agents/slackIntakeAgent.js';

function modelText(text: string) {
  return { text };
}

// Pull the structured `reason` recorded by the single fallback log call.
function loggedFallbackReason(): string | undefined {
  const call = mockWarn.mock.calls.find((c) => c[1] === 'intake.fallback');
  return call?.[0]?.reason;
}

describe('classifySlackIntake', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('answers an obvious greeting deterministically, without a model call', async () => {
    // "hi" must never depend on a Gemini round-trip or a setTimeout race: both
    // need a live event loop, which a cold, CPU-throttled Cloud Run container
    // starves (an 8s timeout was observed taking 60s and failing open into the
    // analytics pipeline). A pure string match resolves under any infra config.
    const result = await classifySlackIntake('hi', 'api-key');

    expect(result.route).toBe('immediate_response');
    expect(result.responseText).toMatch(/data/i);
    expect(mockGenerateContent).not.toHaveBeenCalled();
  });

  it('still uses the model for ambiguous prose that is not an obvious greeting', async () => {
    mockGenerateContent.mockResolvedValue(modelText(JSON.stringify({
      route: 'immediate_response',
      responseText: 'I can help with analytics questions from your modeled data.',
      reasoning: 'Capability question.',
    })));

    const result = await classifySlackIntake('what can you do?', 'api-key');

    expect(result.route).toBe('immediate_response');
    expect(mockGenerateContent).toHaveBeenCalledTimes(1);
    expect(mockGenerateContent.mock.calls[0][0].model).toBe('gemini-flash-latest');
    expect(mockGenerateContent.mock.calls[0][0].config.responseMimeType).toBe('application/json');
    expect(mockGenerateContent.mock.calls[0][0].config.responseJsonSchema).toBeDefined();
  });

  it('fast-paths greeting variants without a model call', async () => {
    for (const greeting of ['hi', 'Hello!', 'hey there', 'Good morning', 'yo 👋', 'hiya', 'hi anna']) {
      vi.clearAllMocks();
      const result = await classifySlackIntake(greeting, 'api-key');
      expect(result.route, greeting).toBe('immediate_response');
      expect(result.responseText, greeting).toBeTruthy();
      expect(mockGenerateContent, greeting).not.toHaveBeenCalled();
    }
  });

  it('fast-paths thanks without a model call', async () => {
    for (const phrase of ['thanks', 'Thank you!', 'thanks so much', 'ty']) {
      vi.clearAllMocks();
      const result = await classifySlackIntake(phrase, 'api-key');
      expect(result.route, phrase).toBe('immediate_response');
      expect(result.responseText, phrase).toMatch(/welcome/i);
      expect(mockGenerateContent, phrase).not.toHaveBeenCalled();
    }
  });

  it('does NOT fast-path a greeting that carries a real question', async () => {
    mockGenerateContent.mockResolvedValue(modelText(JSON.stringify({
      route: 'analytics_pipeline',
      responseText: null,
      reasoning: 'Greeting prefix but a data question follows.',
    })));

    const result = await classifySlackIntake('hi, how many users signed up last week?', 'api-key');

    expect(mockGenerateContent).toHaveBeenCalledTimes(1);
    expect(result.route).toBe('analytics_pipeline');
  });

  it('fast-path responses stay within the length cap and leak no internals', async () => {
    for (const phrase of ['hi', 'thanks']) {
      const result = await classifySlackIntake(phrase, 'api-key');
      expect(result.responseText!.length).toBeLessThanOrEqual(320);
      expect(result.responseText!.toLowerCase()).not.toMatch(/dbt|file search|sql|firestore|cloud run|gemini/);
    }
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

    const result = await classifySlackIntake('what can you do?', 'api-key');

    expect(result.route).toBe('analytics_pipeline');
    expect(result.responseText).toBeNull();
    expect(result.reasoning).toContain('fallback');
    expect(loggedFallbackReason()).toBe('json_parse_error');
  });

  it('logs a schema_validation_error fallback when JSON does not match the schema', async () => {
    mockGenerateContent.mockResolvedValue(modelText(JSON.stringify({
      route: 'not_a_valid_route',
      responseText: null,
      reasoning: 'Schema mismatch.',
    })));

    const result = await classifySlackIntake('what can you do?', 'api-key');

    expect(result.route).toBe('analytics_pipeline');
    expect(loggedFallbackReason()).toBe('schema_validation_error');
  });

  it('falls back when immediate response text is empty', async () => {
    mockGenerateContent.mockResolvedValue(modelText(JSON.stringify({
      route: 'immediate_response',
      responseText: '',
      reasoning: 'Greeting.',
    })));

    const result = await classifySlackIntake('what can you do?', 'api-key');

    expect(result.route).toBe('analytics_pipeline');
    expect(loggedFallbackReason()).toBe('sanitize_empty');
  });

  it('logs a sanitize_oversized fallback when the immediate response exceeds the cap', async () => {
    mockGenerateContent.mockResolvedValue(modelText(JSON.stringify({
      route: 'immediate_response',
      responseText: 'a'.repeat(321),
      reasoning: 'Too long.',
    })));

    const result = await classifySlackIntake('what can you do?', 'api-key');

    expect(result.route).toBe('analytics_pipeline');
    expect(loggedFallbackReason()).toBe('sanitize_oversized');
  });

  it('falls back when immediate response text contains unsafe implementation details', async () => {
    mockGenerateContent.mockResolvedValue(modelText(JSON.stringify({
      route: 'immediate_response',
      responseText: 'I will use dbt and File Search to inspect project.dataset.table.',
      reasoning: 'Unsafe implementation details.',
    })));

    const result = await classifySlackIntake('help', 'api-key');

    expect(result.route).toBe('analytics_pipeline');
    expect(loggedFallbackReason()).toBe('sanitize_unsafe');
  });

  it('falls back when immediate response text contains a project identifier', async () => {
    mockGenerateContent.mockResolvedValue(modelText(JSON.stringify({
      route: 'immediate_response',
      responseText: 'I can query project alpha-prod-123456 for you.',
      reasoning: 'Unsafe project identifier.',
    })));

    const result = await classifySlackIntake('help', 'api-key');

    expect(result.route).toBe('analytics_pipeline');
    expect(loggedFallbackReason()).toBe('sanitize_unsafe');
  });

  it('falls back on rejected model calls', async () => {
    mockGenerateContent.mockRejectedValue(new Error('Gemini unavailable'));

    const result = await classifySlackIntake('what can you do?', 'api-key');

    expect(result.route).toBe('analytics_pipeline');
    expect(result.responseText).toBeNull();
    expect(loggedFallbackReason()).toBe('model_error');
  });

  it('falls back when the intake call times out', async () => {
    vi.useFakeTimers();
    mockGenerateContent.mockReturnValue(new Promise(() => {}));

    const resultPromise = classifySlackIntake('what can you do?', 'api-key', { timeoutMs: 10 });

    await vi.advanceTimersByTimeAsync(10);
    await expect(resultPromise).resolves.toMatchObject({
      route: 'analytics_pipeline',
      responseText: null,
    });
    expect(loggedFallbackReason()).toBe('timeout');
  });

  it('does not time out a typical Flash structured-output call under the default timeout', async () => {
    // Real warm Flash latency for this call is ~1.7-2.2s and cold starts are
    // slower; the default timeout must clear that band so greetings are not
    // silently dropped into the analytics pipeline.
    vi.useFakeTimers();
    mockGenerateContent.mockReturnValue(new Promise((resolve) => {
      setTimeout(() => resolve(modelText(JSON.stringify({
        route: 'immediate_response',
        responseText: 'Hi. Ask me an analytics question with a metric and timeframe.',
        reasoning: 'Greeting.',
      }))), 3000);
    }));

    const resultPromise = classifySlackIntake('what can you do?', 'api-key'); // default timeout

    await vi.advanceTimersByTimeAsync(3000);
    await expect(resultPromise).resolves.toMatchObject({
      route: 'immediate_response',
      responseText: 'Hi. Ask me an analytics question with a metric and timeframe.',
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
    expect(loggedFallbackReason()).toBe('sanitize_unsafe');
  });

  it('falls back when immediate response text contains inline SQL over a qualified table', async () => {
    mockGenerateContent.mockResolvedValue(modelText(JSON.stringify({
      route: 'immediate_response',
      responseText: 'Run SELECT revenue FROM sales.orders to see it.',
      reasoning: 'Leaked SQL with a qualified table.',
    })));

    const result = await classifySlackIntake('help', 'api-key');

    expect(result.route).toBe('analytics_pipeline');
    expect(loggedFallbackReason()).toBe('sanitize_unsafe');
  });

  it('does not log a fallback on a successful immediate response', async () => {
    mockGenerateContent.mockResolvedValue(modelText(JSON.stringify({
      route: 'immediate_response',
      responseText: 'Hi. Ask me an analytics question with a metric and timeframe.',
      reasoning: 'Greeting.',
    })));

    await classifySlackIntake('what can you do?', 'api-key');

    expect(loggedFallbackReason()).toBeUndefined();
  });

  it('does not log a fallback when routing a substantive question to the pipeline', async () => {
    mockGenerateContent.mockResolvedValue(modelText(JSON.stringify({
      route: 'analytics_pipeline',
      responseText: null,
      reasoning: 'Data question.',
    })));

    await classifySlackIntake('show leads last month by channel', 'api-key');

    expect(loggedFallbackReason()).toBeUndefined();
  });

  it('never logs raw message or response text in fallback metadata', async () => {
    const leakyResponse = 'I will use dbt and File Search to inspect project.dataset.table.';
    mockGenerateContent.mockResolvedValue(modelText(JSON.stringify({
      route: 'immediate_response',
      responseText: leakyResponse,
      reasoning: 'Unsafe.',
    })));

    await classifySlackIntake('a sensitive user question', 'api-key');

    for (const [meta] of mockWarn.mock.calls) {
      const serialized = JSON.stringify(meta);
      expect(serialized).not.toContain(leakyResponse);
      expect(serialized).not.toContain('sensitive user question');
      
      // Ensure only allowed keys are present in the warning metadata.
      const allowedKeys = new Set(['reason', 'textLength', 'channel', 'threadTs', 'elapsedMs']);
      for (const key of Object.keys(meta)) {
        expect(allowedKeys.has(key)).toBe(true);
      }
    }
  });

  it('correlates fallback logs with channel and threadTs when provided', async () => {
    mockGenerateContent.mockResolvedValue(modelText(JSON.stringify({
      route: 'immediate_response',
      responseText: '',
      reasoning: 'Empty response.',
    })));

    await classifySlackIntake('what can you do?', 'api-key', {
      channel: 'C12345',
      threadTs: '12345.67890',
    });

    const call = mockWarn.mock.calls.find((c) => c[1] === 'intake.fallback');
    expect(call).toBeDefined();
    expect(call![0]).toMatchObject({
      reason: 'sanitize_empty',
      channel: 'C12345',
      threadTs: '12345.67890',
    });
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
