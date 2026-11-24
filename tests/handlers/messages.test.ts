import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies
vi.mock('../../src/state/responseContext.js', () => ({
  botHasRepliedInThread: vi.fn(),
}));
vi.mock('../../src/state/clarificationState.js', () => ({
  claimClarificationState: vi.fn(),
  getClarificationState: vi.fn(),
}));

import { botHasRepliedInThread } from '../../src/state/responseContext.js';
import { claimClarificationState, getClarificationState } from '../../src/state/clarificationState.js';
import {
  canMessageEventReachPipeline,
  shouldRespond,
  checkClarificationReply,
  hasPendingClarification,
  isOwnedByMentionListener,
} from '../../src/handlers/messages.js';

const mockBotHasReplied = vi.mocked(botHasRepliedInThread);
const mockClaimClarification = vi.mocked(claimClarificationState);
const mockGetClarification = vi.mocked(getClarificationState);

describe('canMessageEventReachPipeline', () => {
  it('allows direct messages and group direct messages without a thread', () => {
    expect(canMessageEventReachPipeline({ channel_type: 'im' } as any)).toBe(true);
    expect(canMessageEventReachPipeline({ channel_type: 'mpim' } as any)).toBe(true);
  });

  it('allows thread replies so clarification, escalation, and follow-up routing can run', () => {
    expect(canMessageEventReachPipeline({
      channel_type: 'channel',
      thread_ts: 'thread-1',
    } as any)).toBe(true);
  });

  it('filters bare channel messages before Firestore-backed dedupe', () => {
    expect(canMessageEventReachPipeline({
      channel_type: 'channel',
    } as any)).toBe(false);
  });
});

describe('isOwnedByMentionListener', () => {
  const mention = (channel_type: string, text = '<@UBOT> show leads') => ({ channel_type, text }) as any;

  it('hands over a message that mentions the bot in a public or private channel', () => {
    expect(isOwnedByMentionListener(mention('channel'), 'UBOT')).toBe(true);
    expect(isOwnedByMentionListener(mention('group'), 'UBOT')).toBe(true);
  });

  it('finds the mention anywhere in the text', () => {
    expect(isOwnedByMentionListener(mention('channel', 'thanks <@UBOT>, and by region?'), 'UBOT')).toBe(true);
  });

  it('keeps a message in a direct conversation, which gets no app_mention event', () => {
    expect(isOwnedByMentionListener(mention('im'), 'UBOT')).toBe(false);
    expect(isOwnedByMentionListener(mention('mpim'), 'UBOT')).toBe(false);
  });

  it('keeps a message that mentions nobody, or somebody else', () => {
    expect(isOwnedByMentionListener(mention('channel', 'show leads'), 'UBOT')).toBe(false);
    expect(isOwnedByMentionListener(mention('channel', '<@UOTHER> show leads'), 'UBOT')).toBe(false);
    // A longer id that starts with the bot's is somebody else.
    expect(isOwnedByMentionListener(mention('channel', '<@UBOT2> show leads'), 'UBOT')).toBe(false);
  });

  it('keeps every message when the bot user id is not known', () => {
    expect(isOwnedByMentionListener(mention('channel'), undefined)).toBe(false);
    expect(isOwnedByMentionListener(mention('channel'), '')).toBe(false);
  });

  it('keeps a message with no text', () => {
    expect(isOwnedByMentionListener({ channel_type: 'channel' } as any, 'UBOT')).toBe(false);
  });
});

describe('hasPendingClarification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('is false outside a thread, without a lookup', async () => {
    expect(await hasPendingClarification({ channel: 'C1' } as any)).toBe(false);
    expect(mockGetClarification).not.toHaveBeenCalled();
  });

  it('is true when the thread has a clarification waiting', async () => {
    mockGetClarification.mockResolvedValue({ clarificationId: 'clarify_thread-1' } as any);

    expect(await hasPendingClarification({ channel: 'C1', thread_ts: 'thread-1' } as any)).toBe(true);
    expect(mockGetClarification).toHaveBeenCalledWith('C1', 'thread-1');
  });

  it('is false when the thread has none', async () => {
    mockGetClarification.mockResolvedValue(null);

    expect(await hasPendingClarification({ channel: 'C1', thread_ts: 'thread-1' } as any)).toBe(false);
  });

  it('does not take the clarification', async () => {
    mockGetClarification.mockResolvedValue({ clarificationId: 'clarify_thread-1' } as any);

    await hasPendingClarification({ channel: 'C1', thread_ts: 'thread-1' } as any);

    expect(mockClaimClarification).not.toHaveBeenCalled();
  });
});

describe('shouldRespond', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('responds to DMs (channel_type === "im")', async () => {
    const result = await shouldRespond({ channel_type: 'im' } as any);
    expect(result).toBe(true);
  });

  it('responds to group DMs (channel_type === "mpim")', async () => {
    const result = await shouldRespond({ channel_type: 'mpim' } as any);
    expect(result).toBe(true);
  });

  it('responds to thread reply where bot has participated', async () => {
    mockBotHasReplied.mockResolvedValue(true);
    const result = await shouldRespond({
      channel: 'C1',
      channel_type: 'channel',
      thread_ts: 'thread-1',
    } as any);
    expect(result).toBe(true);
    expect(mockBotHasReplied).toHaveBeenCalledWith('C1', 'thread-1');
  });

  it('ignores thread reply where bot has NOT participated', async () => {
    mockBotHasReplied.mockResolvedValue(false);
    const result = await shouldRespond({
      channel_type: 'channel',
      thread_ts: 'thread-1',
    } as any);
    expect(result).toBe(false);
  });

  it('ignores bare channel message without mention', async () => {
    const result = await shouldRespond({
      channel_type: 'channel',
      type: 'message',
    } as any);
    expect(result).toBe(false);
  });
});

describe('checkClarificationReply', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null when not in a thread', async () => {
    const result = await checkClarificationReply({ channel: 'C1' } as any);
    expect(result).toBeNull();
  });

  it('returns null when there is no pending clarification to take', async () => {
    // Also what a reply gets when another reply took the clarification first.
    mockClaimClarification.mockResolvedValue(null);
    const result = await checkClarificationReply({
      channel: 'C1',
      thread_ts: 'thread-1',
      text: 'reply',
    } as any);
    expect(result).toBeNull();
  });

  it('takes the pending clarification and returns its context', async () => {
    mockClaimClarification.mockResolvedValue({
      clarificationId: 'clarify_thread-1',
      threadTs: 'thread-1',
      channel: 'C1',
      originalQuestion: 'Show revenue',
      ambiguities: ['time period'],
      clarifyingMessageTs: 'status-1',
      state: 'pending',
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 3600000),
    });

    const result = await checkClarificationReply({
      channel: 'C1',
      thread_ts: 'thread-1',
      text: 'Last 30 days',
    } as any);

    expect(result).not.toBeNull();
    expect(result!.clarifiedQuestion).toContain('Show revenue');
    expect(result!.clarifiedQuestion).toContain('Last 30 days');
    expect(mockClaimClarification).toHaveBeenCalledWith('C1', 'thread-1');
    // Legacy doc with no separate wording: review uses the same text.
    expect(result!.originalQuestion).toBe(result!.clarifiedQuestion);
  });

  it("returns the user's wording plus the answer for review (#44)", async () => {
    mockClaimClarification.mockResolvedValue({
      clarificationId: 'clarify_thread-1',
      threadTs: 'thread-1',
      channel: 'C1',
      originalQuestion: 'What is paid revenue? (Refinement: last week)',
      supervisorQuestion: 'What is paid revenue? (Refinement: only EMEA)',
      ambiguities: ['time period'],
      clarifyingMessageTs: 'status-1',
      state: 'awaiting_reply',
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 3600000),
    });

    const result = await checkClarificationReply({ channel: 'C1', thread_ts: 'thread-1', text: 'Q3' } as any);

    expect(result!.clarifiedQuestion).toBe('What is paid revenue? (Refinement: last week) (Clarification: Q3)');
    expect(result!.originalQuestion).toBe('What is paid revenue? (Refinement: only EMEA) (Clarification: Q3)');
  });

  it('hands back the clarifying questions that were asked', async () => {
    mockClaimClarification.mockResolvedValue({
      clarificationId: 'clarify_thread-1',
      threadTs: 'thread-1',
      channel: 'C1',
      originalQuestion: 'Show revenue',
      ambiguities: ['time period'],
      clarifyingQuestions: ['Which time period?', 'Gross or net?'],
      clarifyingMessageTs: 'status-1',
      state: 'awaiting_reply',
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 3600000),
    });

    const result = await checkClarificationReply({ channel: 'C1', thread_ts: 'thread-1', text: 'Q3, net' } as any);

    expect(result!.clarifyingQuestions).toEqual(['Which time period?', 'Gross or net?']);
  });
});
