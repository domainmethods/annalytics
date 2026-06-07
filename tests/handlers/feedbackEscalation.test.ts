import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the state modules the way the sibling handler test does
// (tests/handlers/escalationResponse.test.ts): auto-mock the module, then grab
// typed handles via vi.mocked() after import. This is the repo convention for
// handler tests and avoids any hoisting/TDZ ambiguity around the factory.
vi.mock('../../src/state/responseContext.js');
vi.mock('../../src/state/escalationState.js');
vi.mock('../../src/state/feedbackNotes.js');

import { getResponseContext } from '../../src/state/responseContext.js';
import { hasPendingEscalation, saveEscalationState } from '../../src/state/escalationState.js';
import { saveFeedbackNote } from '../../src/state/feedbackNotes.js';
import {
  promptFeedbackReason,
  handleFeedbackReason,
  handleOtherNoteSubmission,
} from '../../src/handlers/feedbackEscalation.js';
import type { PipelineConfig } from '../../src/pipeline.js';
import type { ResponseContext } from '../../src/types.js';

const mockGetResponseContext = vi.mocked(getResponseContext);
const mockHasPendingEscalation = vi.mocked(hasPendingEscalation);
const mockSaveEscalationState = vi.mocked(saveEscalationState);
const mockSaveFeedbackNote = vi.mocked(saveFeedbackNote);

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
    // Issue #3: the success ack must thread to the original answer, not DM root.
    expect(respond.mock.calls[0][0].thread_ts).toBe('1700000000.000100');
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

  it('threads the refine ack with thread_ts', async () => {
    // Issue #3: the ephemeral ack must replace in-thread, not at the DM root.
    // `respond` posts via response_url, which doesn't carry thread_ts unless we
    // pass it explicitly. This asserts we pass it; whether Slack honors it on a
    // response_url replacement is a staging verification step, not a code one.
    const client = makeClient();
    const respond = vi.fn().mockResolvedValue(undefined);
    await handleFeedbackReason({
      reasonId: 'not_asked', compoundKey, userId: 'U1', channel: 'C1', client, respond, config: makeConfig(),
    });
    expect(respond).toHaveBeenCalledWith(
      expect.objectContaining({ thread_ts: '1700000000.000100' }),
    );
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

  it('opens the Other-note modal instead of acking, for reason "other"', async () => {
    const viewsOpen = vi.fn().mockResolvedValue({});
    const respond = vi.fn();
    const client = { views: { open: viewsOpen }, chat: {} } as any;
    await handleFeedbackReason({
      reasonId: 'other', compoundKey: 'T1_S1', userId: 'U1', channel: 'C1',
      client, respond, config: {} as any, triggerId: 'trig-1',
    });
    expect(viewsOpen).toHaveBeenCalledWith(expect.objectContaining({ trigger_id: 'trig-1' }));
    expect(respond).not.toHaveBeenCalled(); // modal opening replaces the ack
  });

  it('degrades to the record-only ack when opening the Other-note modal fails', async () => {
    // trigger_id is valid for ~3s; views.open also fails on any Slack API error.
    // An unguarded throw leaves the user with no acknowledgement, so the handler
    // must log and fall back to the same record-only ack it would have given
    // without the modal — never a silent drop.
    const viewsOpen = vi.fn().mockRejectedValue(new Error('expired_trigger_id'));
    const respond = vi.fn().mockResolvedValue(undefined);
    const client = { views: { open: viewsOpen }, chat: {} } as any;

    await expect(
      handleFeedbackReason({
        reasonId: 'other', compoundKey: 'T1_S1', userId: 'U1', channel: 'C1',
        client, respond, config: {} as any, triggerId: 'trig-1',
      }),
    ).resolves.toBeUndefined();

    expect(viewsOpen).toHaveBeenCalledTimes(1);
    // Degrade fired with the record-only ack.
    expect(respond).toHaveBeenCalledTimes(1);
    expect(respond.mock.calls[0][0]).toEqual({
      replace_original: true,
      text: 'Thanks — noted. I logged this for review.',
      thread_ts: 'T1',
    });
  });

  it('does not open the modal for a non-"other" reason even when a triggerId is present', async () => {
    // Guards the `reasonId === 'other' &&` half: a record-route reason with a
    // triggerId must take the normal ack path, not the modal path.
    const viewsOpen = vi.fn().mockResolvedValue({});
    const client = makeClient();
    client.views = { open: viewsOpen };
    const respond = vi.fn().mockResolvedValue(undefined);
    await handleFeedbackReason({
      reasonId: 'not_asked', compoundKey, userId: 'U1', channel: 'C1',
      client, respond, config: makeConfig(), triggerId: 'trig-1',
    });
    expect(viewsOpen).not.toHaveBeenCalled();
    // not_asked routes to refine: public prompt + ephemeral ack, no modal.
    expect(client.chat.postMessage).toHaveBeenCalledTimes(1);
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

describe('handleOtherNoteSubmission', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetResponseContext.mockResolvedValue(makeCtx() as unknown as ResponseContext);
    mockSaveFeedbackNote.mockResolvedValue(undefined);
  });

  it('persists the note and posts a threaded ephemeral ack', async () => {
    const postEphemeral = vi.fn().mockResolvedValue({});
    const client = { chat: { postEphemeral } } as any;
    await handleOtherNoteSubmission({
      privateMetadata: JSON.stringify({ channel: 'C1', compoundKey: 'T1_S1' }),
      noteText: 'the number looks too low',
      userId: 'U1',
      client,
    });
    expect(mockSaveFeedbackNote).toHaveBeenCalledWith(
      expect.objectContaining({
        note: 'the number looks too low',
        userId: 'U1',
        threadTs: 'T1',
        channel: 'C1',
        traceId: 'trace-1',
        clarifiedQuestion: 'unique visitors last month',
      }),
    );
    expect(postEphemeral).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'C1',
        user: 'U1',
        thread_ts: 'T1',
        text: 'Thanks — noted. I logged this for review.',
      }),
    );
  });

  it('still records the note when ResponseContext is missing (no throw)', async () => {
    mockGetResponseContext.mockResolvedValue(null);
    const postEphemeral = vi.fn().mockResolvedValue({});
    const client = { chat: { postEphemeral } } as any;
    await expect(
      handleOtherNoteSubmission({
        privateMetadata: JSON.stringify({ channel: 'C1', compoundKey: 'T1_S1' }),
        noteText: 'x',
        userId: 'U1',
        client,
      }),
    ).resolves.toBeUndefined();
    expect(mockSaveFeedbackNote).toHaveBeenCalled();
    // Optional enrichment keys must be OMITTED (not undefined) when the context
    // is gone — Firestore is not configured with ignoreUndefinedProperties, so a
    // literal `undefined` field value would reject the write.
    const saved = mockSaveFeedbackNote.mock.calls[0][0];
    expect('traceId' in saved).toBe(false);
    expect('clarifiedQuestion' in saved).toBe(false);
    expect(postEphemeral).toHaveBeenCalled();
  });

  it.each(['', 'T1'])(
    'no-ops on a malformed compound key (%s): no save, no ack',
    async (badKey) => {
      const postEphemeral = vi.fn().mockResolvedValue({});
      const client = { chat: { postEphemeral } } as any;
      await expect(
        handleOtherNoteSubmission({
          privateMetadata: JSON.stringify({ channel: 'C1', compoundKey: badKey }),
          noteText: 'x',
          userId: 'U1',
          client,
        }),
      ).resolves.toBeUndefined();
      expect(mockSaveFeedbackNote).not.toHaveBeenCalled();
      expect(postEphemeral).not.toHaveBeenCalled();
    },
  );

  it('still acks when saveFeedbackNote throws (save failure does not short-circuit ack)', async () => {
    mockSaveFeedbackNote.mockRejectedValue(new Error('firestore down'));
    const postEphemeral = vi.fn().mockResolvedValue({});
    const client = { chat: { postEphemeral } } as any;
    await expect(
      handleOtherNoteSubmission({
        privateMetadata: JSON.stringify({ channel: 'C1', compoundKey: 'T1_S1' }),
        noteText: 'x',
        userId: 'U1',
        client,
      }),
    ).resolves.toBeUndefined();
    expect(mockSaveFeedbackNote).toHaveBeenCalled();
    expect(postEphemeral).toHaveBeenCalled();
  });

  it('does not throw on non-JSON private_metadata (logs and returns)', async () => {
    const postEphemeral = vi.fn().mockResolvedValue({});
    const client = { chat: { postEphemeral } } as any;
    await expect(
      handleOtherNoteSubmission({
        privateMetadata: 'not-json{',
        noteText: 'x',
        userId: 'U1',
        client,
      }),
    ).resolves.toBeUndefined();
    expect(mockSaveFeedbackNote).not.toHaveBeenCalled();
    expect(postEphemeral).not.toHaveBeenCalled();
  });
});
