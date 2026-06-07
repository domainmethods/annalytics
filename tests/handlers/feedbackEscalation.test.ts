import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the state modules the way the sibling handler test does
// (tests/handlers/escalationResponse.test.ts): auto-mock the module, then grab
// typed handles via vi.mocked() after import. This is the repo convention for
// handler tests and avoids any hoisting/TDZ ambiguity around the factory.
vi.mock('../../src/state/responseContext.js');
vi.mock('../../src/state/escalationState.js');

import { getResponseContext } from '../../src/state/responseContext.js';
import { hasPendingEscalation, saveEscalationState } from '../../src/state/escalationState.js';
import { promptFeedbackReason, handleFeedbackReason } from '../../src/handlers/feedbackEscalation.js';
import type { PipelineConfig } from '../../src/pipeline.js';
import type { ResponseContext } from '../../src/types.js';

const mockGetResponseContext = vi.mocked(getResponseContext);
const mockHasPendingEscalation = vi.mocked(hasPendingEscalation);
const mockSaveEscalationState = vi.mocked(saveEscalationState);

const compoundKey = '1700000000.000100_1700000000.000200';

function makeConfig(over: Partial<NonNullable<PipelineConfig['escalation']>> = {}): PipelineConfig {
  return {
    geminiApiKey: 'k',
    maxBytesProcessed: 1,
    queryTimeoutMs: 1,
    maxResultRows: 1,
    escalation: {
      mode: 'channel',
      channelId: 'C_ESC',
      timeoutHours: 4,
      onNegativeFeedback: true,
      ...over,
    },
  };
}

function makeCtx() {
  return {
    traceId: 'trace-1',
    clarifiedQuestion: 'unique visitors last month',
    generatedSql: 'SELECT 1',
    groundingCitations: [],
    supervisorNotes: 'n',
    queryResults: { rowCount: 1, columnNames: ['x'], bytesProcessed: 1 },
  };
}

function makeClient() {
  return {
    chat: {
      postEphemeral: vi.fn().mockResolvedValue({ ok: true }),
      postMessage: vi.fn().mockResolvedValue({ ok: true, ts: '1700000000.000300' }),
    },
  } as any;
}

describe('promptFeedbackReason', () => {
  beforeEach(() => vi.clearAllMocks());

  it('posts an ephemeral reason prompt to the clicking user', async () => {
    const client = makeClient();
    await promptFeedbackReason({
      client,
      channel: 'C1',
      userId: 'U1',
      threadTs: '1700000000.000100',
      statusMsgTs: '1700000000.000200',
    });
    expect(client.chat.postEphemeral).toHaveBeenCalledTimes(1);
    const arg = client.chat.postEphemeral.mock.calls[0][0];
    expect(arg.channel).toBe('C1');
    expect(arg.user).toBe('U1');
    expect(arg.blocks).toBeDefined();
  });
});

describe('handleFeedbackReason', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // makeCtx() returns only the fields the handler reads; cast to satisfy the
    // mocked getResponseContext return type (Promise<ResponseContext | null>).
    mockGetResponseContext.mockResolvedValue(makeCtx() as unknown as ResponseContext);
    mockHasPendingEscalation.mockResolvedValue(false);
    mockSaveEscalationState.mockResolvedValue(undefined);
  });

  it('escalates a "wrong_number" reason: posts the card and saves esc_fb_ state', async () => {
    const client = makeClient();
    const respond = vi.fn().mockResolvedValue(undefined);
    await handleFeedbackReason({
      reasonId: 'wrong_number',
      compoundKey,
      userId: 'U1',
      channel: 'C1',
      client,
      respond,
      config: makeConfig(),
    });

    expect(client.chat.postMessage).toHaveBeenCalledTimes(1);
    const cardArg = client.chat.postMessage.mock.calls[0][0];
    expect(cardArg.channel).toBe('C_ESC');
    // The escalation card must surface the reason label so the analyst sees why
    // it was flagged — locks in the reason.label → stuckDescription mapping.
    expect(JSON.stringify(cardArg.blocks)).toContain('Wrong number');

    expect(mockSaveEscalationState).toHaveBeenCalledTimes(1);
    const [state, timeoutHours] = mockSaveEscalationState.mock.calls[0];
    expect(state.escalationId).toBe('esc_fb_trace-1');
    expect(state.trigger).toBe('user_negative_feedback');
    expect(state.behavior).toBe('best_effort_verify');
    expect(state.originalThreadTs).toBe('1700000000.000100');
    expect(state.originalChannel).toBe('C1');
    expect(state.statusMsgTs).toBe('1700000000.000200');
    expect(state.context.feedbackReason).toBe('Wrong number');
    expect(state.context.feedbackUserId).toBe('U1');
    expect(state.context.previousSql).toBe('SELECT 1');
    expect(timeoutHours).toBe(4);

    expect(respond).toHaveBeenCalledTimes(1);
    expect(respond.mock.calls[0][0].replace_original).toBe(true);
  });

  it('degrades gracefully when the escalation card posted but the state save fails', async () => {
    // The card is posted before saveEscalationState. If the write throws after
    // that, the handler must NOT propagate (which would leave the ephemeral
    // prompt un-replaced); it logs and responds with a re-ask degrade instead.
    mockSaveEscalationState.mockRejectedValue(new Error('firestore down'));
    const client = makeClient();
    const respond = vi.fn().mockResolvedValue(undefined);

    await expect(
      handleFeedbackReason({
        reasonId: 'wrong_number', compoundKey, userId: 'U1', channel: 'C1', client, respond, config: makeConfig(),
      }),
    ).resolves.toBeUndefined();

    // Card was posted (the partial-write window we're protecting against).
    expect(client.chat.postMessage).toHaveBeenCalledTimes(1);
    // User is not left without a response — degrade ack fired.
    expect(respond).toHaveBeenCalledTimes(1);
    expect(respond.mock.calls[0][0].text).toMatch(/re-ask/i);
  });

  it('degrades gracefully when posting the escalation card itself fails', async () => {
    // The escalation card post is an external Slack network call: it can fail on
    // rate limits, an invalid target channel, or an API outage. It must not throw
    // an uncaught rejection (which would leave the ephemeral prompt un-replaced);
    // it logs and responds with the same re-ask degrade as the save-failure path.
    const client = makeClient();
    client.chat.postMessage.mockRejectedValue(new Error('slack api down'));
    const respond = vi.fn().mockResolvedValue(undefined);

    await expect(
      handleFeedbackReason({
        reasonId: 'wrong_number', compoundKey, userId: 'U1', channel: 'C1', client, respond, config: makeConfig(),
      }),
    ).resolves.toBeUndefined();

    // Card post failed → no state written, user still gets a degrade ack.
    expect(mockSaveEscalationState).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledTimes(1);
    expect(respond.mock.calls[0][0].text).toMatch(/re-ask/i);
  });

  it('does not double-escalate when one is already pending', async () => {
    mockHasPendingEscalation.mockResolvedValue(true);
    const client = makeClient();
    const respond = vi.fn();
    await handleFeedbackReason({
      reasonId: 'wrong_data', compoundKey, userId: 'U1', channel: 'C1', client, respond, config: makeConfig(),
    });
    expect(mockSaveEscalationState).not.toHaveBeenCalled();
    expect(client.chat.postMessage).not.toHaveBeenCalled();
    expect(respond.mock.calls[0][0].text).toMatch(/already flagged/i);
  });

  it('degrades gracefully when the response context is gone', async () => {
    mockGetResponseContext.mockResolvedValue(null);
    const client = makeClient();
    const respond = vi.fn();
    await handleFeedbackReason({
      reasonId: 'wrong_number', compoundKey, userId: 'U1', channel: 'C1', client, respond, config: makeConfig(),
    });
    expect(mockSaveEscalationState).not.toHaveBeenCalled();
    expect(respond.mock.calls[0][0].text).toMatch(/re-ask/i);
  });

  it('routes "not_asked" to the refine prompt, no escalation', async () => {
    const client = makeClient();
    const respond = vi.fn();
    await handleFeedbackReason({
      reasonId: 'not_asked', compoundKey, userId: 'U1', channel: 'C1', client, respond, config: makeConfig(),
    });
    expect(mockSaveEscalationState).not.toHaveBeenCalled();
    // Refine prompt posted publicly in-thread.
    expect(client.chat.postMessage).toHaveBeenCalledTimes(1);
    expect(client.chat.postMessage.mock.calls[0][0].thread_ts).toBe('1700000000.000100');
  });

  it('records "other" with an ack only — no escalation, no public post', async () => {
    const client = makeClient();
    const respond = vi.fn();
    await handleFeedbackReason({
      reasonId: 'other', compoundKey, userId: 'U1', channel: 'C1', client, respond, config: makeConfig(),
    });
    expect(mockSaveEscalationState).not.toHaveBeenCalled();
    expect(client.chat.postMessage).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledTimes(1);
  });

  it('record-only degrade when no escalation target is configured', async () => {
    const client = makeClient();
    const respond = vi.fn();
    await handleFeedbackReason({
      reasonId: 'wrong_number', compoundKey, userId: 'U1', channel: 'C1', client, respond,
      config: makeConfig({ channelId: undefined }),
    });
    expect(mockSaveEscalationState).not.toHaveBeenCalled();
    expect(client.chat.postMessage).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledTimes(1);
  });

  it.each(['malformedkey', 'threadts_', '_statusts', 'a_b_c'])(
    'degrades on a malformed compound key (%s) without writing state',
    async (badKey) => {
      const client = makeClient();
      const respond = vi.fn();
      await handleFeedbackReason({
        reasonId: 'wrong_number', compoundKey: badKey, userId: 'U1', channel: 'C1', client, respond, config: makeConfig(),
      });
      expect(mockSaveEscalationState).not.toHaveBeenCalled();
      expect(client.chat.postMessage).not.toHaveBeenCalled();
      expect(respond).toHaveBeenCalledTimes(1);
    },
  );
});
