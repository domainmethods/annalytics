import { describe, it, expect, vi, beforeEach } from 'vitest';
import { preflightChecks } from '../../src/handlers/preflightChecks.js';
import type { ClarificationState } from '../../src/state/clarificationState.js';

const mockAcquireThreadLock = vi.fn();
const mockReleaseThreadLock = vi.fn();
const mockGetClarificationState = vi.fn();
const mockGetEscalationByThread = vi.fn();
const mockPostMessage = vi.fn();

vi.mock('../../src/state/threadLock.js', () => ({
  acquireThreadLock: (...args: unknown[]) => mockAcquireThreadLock(...args),
  releaseThreadLock: (...args: unknown[]) => mockReleaseThreadLock(...args),
}));

vi.mock('../../src/state/clarificationState.js', () => ({
  getClarificationState: (...args: unknown[]) => mockGetClarificationState(...args),
}));

vi.mock('../../src/state/escalationState.js', () => ({
  getEscalationByThread: (...args: unknown[]) => mockGetEscalationByThread(...args),
}));

const mockClient = {
  chat: { postMessage: mockPostMessage },
} as any;

function pendingClarificationFixture(overrides: Partial<ClarificationState> = {}): ClarificationState {
  return {
    clarificationId: 'clar-123',
    threadTs: '1234.5678',
    channel: 'C123',
    originalQuestion: 'show me sessions',
    ambiguities: ['Need a date range'],
    ambiguityType: 'user_intent',
    ambiguityDomain: 'traffic',
    ambiguityQuestion: 'Which date range should I use?',
    clarifyingMessageTs: '1234.5679',
    state: 'awaiting_reply',
    createdAt: new Date('2026-06-10T12:00:00.000Z'),
    expiresAt: new Date('2026-06-10T13:00:00.000Z'),
    ...overrides,
  };
}

describe('preflightChecks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAcquireThreadLock.mockResolvedValue(true);
    mockGetClarificationState.mockResolvedValue(null);
    mockGetEscalationByThread.mockResolvedValue(null);
    mockPostMessage.mockResolvedValue({ ts: 'msg-ts' });
    mockReleaseThreadLock.mockResolvedValue(undefined);
  });

  it('returns true when all guards pass', async () => {
    const result = await preflightChecks('C123', '1234.5678', mockClient);

    expect(result).toBe(true);
    expect(mockAcquireThreadLock).toHaveBeenCalledWith('1234.5678');
    expect(mockGetClarificationState).toHaveBeenCalledWith('1234.5678');
    expect(mockGetEscalationByThread).toHaveBeenCalledWith('1234.5678');
  });

  it('returns false and posts message when lock fails', async () => {
    mockAcquireThreadLock.mockResolvedValue(false);

    const result = await preflightChecks('C123', '1234.5678', mockClient);

    expect(result).toBe(false);
    expect(mockPostMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'C123',
        thread_ts: '1234.5678',
        text: expect.stringContaining('still working'),
      }),
    );
    // Should not check further guards
    expect(mockGetClarificationState).not.toHaveBeenCalled();
  });

  it('returns false, posts a nudge, and releases lock when pending clarification', async () => {
    mockGetClarificationState.mockResolvedValue(pendingClarificationFixture());

    const result = await preflightChecks('C123', '1234.5678', mockClient);

    expect(result).toBe(false);
    // Must surface the block to the user — never a silent drop (a regression
    // that left DMs unanswered while a clarification was open).
    expect(mockPostMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'C123',
        thread_ts: '1234.5678',
        text: expect.stringContaining('earlier question'),
        blocks: expect.arrayContaining([
          expect.objectContaining({
            type: 'context',
            elements: expect.arrayContaining([
              expect.objectContaining({
                text: expect.stringContaining('show me sessions'),
              }),
            ]),
          }),
          expect.objectContaining({
            type: 'actions',
            elements: expect.arrayContaining([
              expect.objectContaining({
                action_id: 'clarification_cancel',
              }),
            ]),
          }),
        ]),
      }),
    );
    expect(mockReleaseThreadLock).toHaveBeenCalledWith('1234.5678');
    // Should not check escalation
    expect(mockGetEscalationByThread).not.toHaveBeenCalled();
  });

  it('returns false and posts message when pending escalation', async () => {
    mockGetEscalationByThread.mockResolvedValue({
      status: 'pending',
      state: {
        escalationId: 'esc-123',
        pipelineState: 'awaiting_human',
      },
    });

    const result = await preflightChecks('C123', '1234.5678', mockClient);

    expect(result).toBe(false);
    expect(mockPostMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'C123',
        thread_ts: '1234.5678',
        text: expect.stringContaining('still waiting for the data team'),
      }),
    );
    expect(mockReleaseThreadLock).toHaveBeenCalledWith('1234.5678');
  });

  it('releases the lock and propagates when the clarification guard throws', async () => {
    // A Firestore blip after the lock is acquired must not leave the thread
    // wedged: the caller only assumes lock ownership on a `true` return, so
    // preflightChecks must release on the throw path itself.
    mockGetClarificationState.mockRejectedValue(new Error('Firestore error'));

    await expect(preflightChecks('C123', '1234.5678', mockClient)).rejects.toThrow('Firestore error');

    expect(mockReleaseThreadLock).toHaveBeenCalledWith('1234.5678');
  });

  it('releases the lock and propagates when the escalation guard throws', async () => {
    mockGetEscalationByThread.mockRejectedValue(new Error('Firestore error'));

    await expect(preflightChecks('C123', '1234.5678', mockClient)).rejects.toThrow('Firestore error');

    expect(mockReleaseThreadLock).toHaveBeenCalledWith('1234.5678');
  });

  it('returns true and notifies when escalation expires during preflight', async () => {
    mockGetEscalationByThread.mockResolvedValue({
      status: 'expired_now',
      state: {
        escalationId: 'esc-123',
        behavior: 'park_wait',
        originalChannel: 'C123',
        originalThreadTs: '1234.5678',
      },
    });

    const result = await preflightChecks('C123', '1234.5678', mockClient);

    expect(result).toBe(true);
    expect(mockPostMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'C123',
        thread_ts: '1234.5678',
        text: expect.stringContaining("wasn't able to get an answer"),
      }),
    );
    expect(mockReleaseThreadLock).not.toHaveBeenCalled();
  });
});
