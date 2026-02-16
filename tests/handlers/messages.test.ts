import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies
vi.mock('../../src/state/responseContext.js', () => ({
  botHasRepliedInThread: vi.fn(),
}));
vi.mock('../../src/state/clarificationState.js', () => ({
  getClarificationState: vi.fn(),
  deleteClarificationState: vi.fn(),
}));

import { botHasRepliedInThread } from '../../src/state/responseContext.js';
import { getClarificationState, deleteClarificationState } from '../../src/state/clarificationState.js';
import { shouldRespond, checkClarificationReply } from '../../src/handlers/messages.js';

const mockBotHasReplied = vi.mocked(botHasRepliedInThread);
const mockGetClarification = vi.mocked(getClarificationState);
const mockDeleteClarification = vi.mocked(deleteClarificationState);

describe('shouldRespond', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('responds to DMs (channel_type === "im")', async () => {
    const result = await shouldRespond({ channel_type: 'im' } as any);
    expect(result).toBe(true);
  });

  it('responds to thread reply where bot has participated', async () => {
    mockBotHasReplied.mockResolvedValue(true);
    const result = await shouldRespond({
      channel_type: 'channel',
      thread_ts: 'thread-1',
    } as any);
    expect(result).toBe(true);
    expect(mockBotHasReplied).toHaveBeenCalledWith('thread-1');
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

  it('returns null when no pending clarification', async () => {
    mockGetClarification.mockResolvedValue(null);
    const result = await checkClarificationReply({
      channel: 'C1',
      thread_ts: 'thread-1',
      text: 'reply',
    } as any);
    expect(result).toBeNull();
  });

  it('returns clarification context and deletes state', async () => {
    mockGetClarification.mockResolvedValue({
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
    mockDeleteClarification.mockResolvedValue(undefined);

    const result = await checkClarificationReply({
      channel: 'C1',
      thread_ts: 'thread-1',
      text: 'Last 30 days',
    } as any);

    expect(result).not.toBeNull();
    expect(result!.clarifiedQuestion).toContain('Show revenue');
    expect(result!.clarifiedQuestion).toContain('Last 30 days');
    expect(mockDeleteClarification).toHaveBeenCalledWith('clarify_thread-1');
  });
});
