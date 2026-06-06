import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockClassifySlackIntake = vi.hoisted(() => vi.fn());

vi.mock('../../src/agents/slackIntakeAgent.js', () => ({
  classifySlackIntake: mockClassifySlackIntake,
}));

import { maybeHandleSlackIntake } from '../../src/handlers/slackIntake.js';

describe('maybeHandleSlackIntake', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('posts model-generated immediate responses and releases the lock', async () => {
    mockClassifySlackIntake.mockResolvedValue({
      route: 'immediate_response',
      responseText: 'Hi. Ask me an analytics question with a metric and timeframe.',
      reasoning: 'Greeting.',
    });
    const client = { chat: { postMessage: vi.fn().mockResolvedValue({ ts: 'reply-1' }) } } as any;
    const markVisible = vi.fn().mockResolvedValue(undefined);
    const releaseLock = vi.fn().mockResolvedValue(undefined);

    const result = await maybeHandleSlackIntake({
      text: 'hi',
      channel: 'C1',
      threadTs: 'T1',
      apiKey: 'api-key',
      client,
      markVisible,
      releaseLock,
    });

    expect(result).toBe(true);
    expect(client.chat.postMessage).toHaveBeenCalledWith({
      channel: 'C1',
      thread_ts: 'T1',
      text: 'Hi. Ask me an analytics question with a metric and timeframe.',
    });
    expect(markVisible).toHaveBeenCalledTimes(1);
    expect(releaseLock).toHaveBeenCalledTimes(1);
  });

  it('returns false without posting when the agent chooses the analytics pipeline', async () => {
    mockClassifySlackIntake.mockResolvedValue({
      route: 'analytics_pipeline',
      responseText: null,
      reasoning: 'Data question.',
    });
    const client = { chat: { postMessage: vi.fn() } } as any;

    const result = await maybeHandleSlackIntake({
      text: 'show leads last month',
      channel: 'C1',
      threadTs: 'T1',
      apiKey: 'api-key',
      client,
    });

    expect(result).toBe(false);
    expect(client.chat.postMessage).not.toHaveBeenCalled();
  });

  it('returns false when an immediate response has no text', async () => {
    mockClassifySlackIntake.mockResolvedValue({
      route: 'immediate_response',
      responseText: null,
      reasoning: 'Bad model output.',
    });
    const client = { chat: { postMessage: vi.fn() } } as any;

    const result = await maybeHandleSlackIntake({
      text: 'hi',
      channel: 'C1',
      threadTs: 'T1',
      apiKey: 'api-key',
      client,
    });

    expect(result).toBe(false);
    expect(client.chat.postMessage).not.toHaveBeenCalled();
  });

  it('omits thread_ts for slash command top-level responses', async () => {
    mockClassifySlackIntake.mockResolvedValue({
      route: 'immediate_response',
      responseText: 'Hi. Ask me an analytics question.',
      reasoning: 'Greeting.',
    });
    const client = { chat: { postMessage: vi.fn().mockResolvedValue({ ts: 'reply-1' }) } } as any;

    const result = await maybeHandleSlackIntake({
      text: 'help',
      channel: 'C1',
      apiKey: 'api-key',
      client,
    });

    expect(result).toBe(true);
    expect(client.chat.postMessage).toHaveBeenCalledWith({
      channel: 'C1',
      text: 'Hi. Ask me an analytics question.',
    });
  });

  it('still reports handled when best-effort cleanup callbacks reject', async () => {
    mockClassifySlackIntake.mockResolvedValue({
      route: 'immediate_response',
      responseText: 'Hi. Ask me an analytics question.',
      reasoning: 'Greeting.',
    });
    const client = { chat: { postMessage: vi.fn().mockResolvedValue({ ts: 'reply-1' }) } } as any;
    const markVisible = vi.fn().mockRejectedValue(new Error('firestore unavailable'));
    const releaseLock = vi.fn().mockRejectedValue(new Error('lock release failed'));

    const result = await maybeHandleSlackIntake({
      text: 'hi',
      channel: 'C1',
      threadTs: 'T1',
      apiKey: 'api-key',
      client,
      markVisible,
      releaseLock,
    });

    expect(result).toBe(true);
    expect(client.chat.postMessage).toHaveBeenCalledTimes(1);
    expect(markVisible).toHaveBeenCalledTimes(1);
    expect(releaseLock).toHaveBeenCalledTimes(1);
  });
});
