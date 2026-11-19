import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/state/escalationState.js');
vi.mock('../../src/slack/escalationBlocks.js');

import {
  getAllPendingEscalations,
  claimReminder,
  timeoutEscalation,
} from '../../src/state/escalationState.js';
import { buildEscalationReminderBlocks } from '../../src/slack/escalationBlocks.js';
import { checkOverdueEscalations, _resetThrottle, MAX_SWEEP_ACTIONS } from '../../src/handlers/escalationLifecycle.js';

const mockGetAll = vi.mocked(getAllPendingEscalations);
const mockClaimReminder = vi.mocked(claimReminder);
const mockTimeout = vi.mocked(timeoutEscalation);
const mockBuildReminder = vi.mocked(buildEscalationReminderBlocks);

const mockClient = {
  chat: { postMessage: vi.fn() },
} as any;

const escalationConfig = {
  mode: 'channel' as const,
  channelId: 'C-ESCALATION',
  reminderIntervalMinutes: 30,
  timeoutHours: 4,
};

const baseEscalation = {
  escalationId: 'esc_trace-1',
  originalThreadTs: 'thread-1',
  originalChannel: 'C-ORIGINAL',
  pipelineState: 'awaiting_human' as const,
  trigger: 'supervisor_exhausted' as const,
  behavior: 'park_wait' as const,
  stageToResume: 'sql_generation' as const,
  context: {
    clarifiedQuestion: 'What is revenue?',
    userQuestion: 'What is revenue?',
    groundingCitations: [],
    previousSql: 'SELECT SUM(amount) FROM orders',
    supervisorNotes: 'Not sure about joins',
  },
  escalationChannel: 'C-ESCALATION',
  escalationTs: 'esc-ts-1',
  statusMsgTs: 'status-1',
  bestEffortSql: 'SELECT SUM(amount) FROM orders',
  createdAt: new Date(Date.now() - 60 * 60000), // 1 hour ago
  expiresAt: new Date(Date.now() + 3 * 60 * 60000), // 3 hours from now
  traceId: 'trace-1',
};

describe('checkOverdueEscalations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetThrottle();
    mockClaimReminder.mockResolvedValue(true);
    mockTimeout.mockResolvedValue(true);
    mockBuildReminder.mockReturnValue([{ type: 'section', text: { type: 'mrkdwn', text: 'reminder' } }] as any);
    mockClient.chat.postMessage.mockResolvedValue({});
  });

  it('posts reminder when lastReminderAt is null and not expired', async () => {
    mockGetAll.mockResolvedValue([{
      ...baseEscalation,
      lastReminderAt: undefined,
    }]);

    await checkOverdueEscalations(mockClient, escalationConfig);

    expect(mockBuildReminder).toHaveBeenCalledWith(
      expect.objectContaining({
        escalationId: 'esc_trace-1',
        originalQuestion: 'What is revenue?',
      }),
    );
    expect(mockClient.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'C-ESCALATION',
        thread_ts: 'esc-ts-1',
      }),
    );
    expect(mockClaimReminder).toHaveBeenCalledWith('esc_trace-1', expect.any(Date));
  });

  it('skips reminder when just created (createdAt is recent, no lastReminderAt)', async () => {
    mockGetAll.mockResolvedValue([{
      ...baseEscalation,
      createdAt: new Date(Date.now() - 5 * 60000), // created 5 minutes ago
      lastReminderAt: undefined,
    }]);

    await checkOverdueEscalations(mockClient, escalationConfig);

    expect(mockBuildReminder).not.toHaveBeenCalled();
    expect(mockClaimReminder).not.toHaveBeenCalled();
    expect(mockClient.chat.postMessage).not.toHaveBeenCalled();
  });

  it('skips reminder when lastReminderAt is recent', async () => {
    mockGetAll.mockResolvedValue([{
      ...baseEscalation,
      lastReminderAt: new Date(Date.now() - 5 * 60000), // 5 minutes ago
    }]);

    await checkOverdueEscalations(mockClient, escalationConfig);

    expect(mockBuildReminder).not.toHaveBeenCalled();
    expect(mockClaimReminder).not.toHaveBeenCalled();
    expect(mockClient.chat.postMessage).not.toHaveBeenCalled();
  });

  it('marks timed_out and posts park_wait timeout message', async () => {
    mockGetAll.mockResolvedValue([{
      ...baseEscalation,
      behavior: 'park_wait' as const,
      expiresAt: new Date(Date.now() - 1000), // expired
    }]);

    await checkOverdueEscalations(mockClient, escalationConfig);

    expect(mockTimeout).toHaveBeenCalledWith('esc_trace-1');
    expect(mockClient.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'C-ORIGINAL',
        thread_ts: 'thread-1',
        text: expect.stringContaining("wasn't able to get an answer"),
      }),
    );
  });

  it('skips the timeout notice when a concurrent resolution already claimed the escalation', async () => {
    mockGetAll.mockResolvedValue([{
      ...baseEscalation,
      behavior: 'park_wait' as const,
      expiresAt: new Date(Date.now() - 1000), // expired
    }]);
    mockTimeout.mockResolvedValueOnce(false);

    const result = await checkOverdueEscalations(mockClient, escalationConfig);

    expect(mockTimeout).toHaveBeenCalledWith('esc_trace-1');
    expect(mockClient.chat.postMessage).not.toHaveBeenCalled();
    expect(result.timedOut).toBe(0);
  });

  it('marks timed_out and posts best_effort_verify timeout message', async () => {
    mockGetAll.mockResolvedValue([{
      ...baseEscalation,
      behavior: 'best_effort_verify' as const,
      expiresAt: new Date(Date.now() - 1000), // expired
    }]);

    await checkOverdueEscalations(mockClient, escalationConfig);

    expect(mockTimeout).toHaveBeenCalledWith('esc_trace-1');
    expect(mockClient.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'C-ORIGINAL',
        thread_ts: 'thread-1',
        text: expect.stringContaining('best estimate'),
      }),
    );
  });

  it('does nothing when no pending escalations', async () => {
    mockGetAll.mockResolvedValue([]);

    await checkOverdueEscalations(mockClient, escalationConfig);

    expect(mockClient.chat.postMessage).not.toHaveBeenCalled();
    expect(mockTimeout).not.toHaveBeenCalled();
    expect(mockClaimReminder).not.toHaveBeenCalled();
  });

  it('throttles: skips Firestore query when called again within 1 minute', async () => {
    mockGetAll.mockResolvedValue([]);

    await checkOverdueEscalations(mockClient, escalationConfig);
    expect(mockGetAll).toHaveBeenCalledTimes(1);

    // Second call within the same minute — should be throttled
    await checkOverdueEscalations(mockClient, escalationConfig);
    expect(mockGetAll).toHaveBeenCalledTimes(1);
  });

  it('returns zeroed counts with throttled=true when throttled', async () => {
    mockGetAll.mockResolvedValue([]);

    await checkOverdueEscalations(mockClient, escalationConfig);

    // Second call within the same minute — throttled
    const result = await checkOverdueEscalations(mockClient, escalationConfig);
    expect(result).toEqual({ throttled: true, pending: 0, reminded: 0, timedOut: 0, deferred: 0 });
  });

  it('returns zeroed counts with throttled=false when no pending escalations', async () => {
    mockGetAll.mockResolvedValue([]);

    const result = await checkOverdueEscalations(mockClient, escalationConfig);

    expect(result).toEqual({ throttled: false, pending: 0, reminded: 0, timedOut: 0, deferred: 0 });
  });

  it('returns sweep counts for one expired and one reminder-due escalation', async () => {
    mockGetAll.mockResolvedValue([
      {
        ...baseEscalation,
        escalationId: 'esc_expired',
        expiresAt: new Date(Date.now() - 1000), // expired
      },
      {
        ...baseEscalation,
        escalationId: 'esc_reminder',
        lastReminderAt: undefined, // createdAt 1h ago > 30min interval → reminder due
      },
    ]);

    const result = await checkOverdueEscalations(mockClient, escalationConfig);

    expect(result).toEqual({ throttled: false, pending: 2, reminded: 1, timedOut: 1, deferred: 0 });
    expect(mockTimeout).toHaveBeenCalledWith('esc_expired');
    expect(mockClaimReminder).toHaveBeenCalledWith('esc_reminder', expect.any(Date));
  });

  it('counts not-yet-due escalations toward pending without acting on them', async () => {
    mockGetAll.mockResolvedValue([{
      ...baseEscalation,
      createdAt: new Date(Date.now() - 5 * 60000), // too recent for a reminder
      lastReminderAt: undefined,
    }]);

    const result = await checkOverdueEscalations(mockClient, escalationConfig);

    expect(result).toEqual({ throttled: false, pending: 1, reminded: 0, timedOut: 0, deferred: 0 });
    expect(mockClient.chat.postMessage).not.toHaveBeenCalled();
  });

  describe('bounded, claimed progress (#54)', () => {
    const MIN = 60000;
    const pendingEsc = (id: string, lastReminderAgoMin: number, extra: object = {}) => ({
      ...baseEscalation,
      escalationId: id,
      escalationTs: `ts-${id}`,
      lastReminderAt: new Date(Date.now() - lastReminderAgoMin * MIN),
      ...extra,
    });

    it('reaches an overdue escalation behind a full page of still-pending ones', async () => {
      const recent = Array.from({ length: 50 }, (_, i) => pendingEsc(`esc_recent_${i}`, 5));
      mockGetAll.mockResolvedValue([...recent, pendingEsc('esc_overdue', 45)]);
      const result = await checkOverdueEscalations(mockClient, escalationConfig);
      expect(result).toEqual({ throttled: false, pending: 51, reminded: 1, timedOut: 0, deferred: 0 });
      expect(mockClaimReminder).toHaveBeenCalledTimes(1);
      expect(mockClaimReminder).toHaveBeenCalledWith('esc_overdue', expect.any(Date));
    });

    it('caps actions per sweep, most overdue first, and reports the rest as deferred', async () => {
      const due = Array.from({ length: MAX_SWEEP_ACTIONS + 5 }, (_, i) => pendingEsc(`esc_${i}`, 31 + i));
      const expired = pendingEsc('esc_expired', 5, { expiresAt: new Date(Date.now() - MIN) });
      mockGetAll.mockResolvedValue([...due, expired]);
      const result = await checkOverdueEscalations(mockClient, escalationConfig);
      expect(result).toEqual({ throttled: false, pending: MAX_SWEEP_ACTIONS + 6, reminded: MAX_SWEEP_ACTIONS - 1, timedOut: 1, deferred: 6 });
      expect(mockTimeout).toHaveBeenCalledWith('esc_expired');
      const claimed = mockClaimReminder.mock.calls.map(c => c[0]);
      expect(claimed[0]).toBe(`esc_${MAX_SWEEP_ACTIONS + 4}`);
      expect(claimed).not.toContain('esc_0');
    });

    it('skips the post when another sweep already claimed the reminder', async () => {
      mockClaimReminder.mockResolvedValue(false);
      mockGetAll.mockResolvedValue([pendingEsc('esc_taken', 45)]);
      const result = await checkOverdueEscalations(mockClient, escalationConfig);
      expect(mockClient.chat.postMessage).not.toHaveBeenCalled();
      expect(result.reminded).toBe(0);
    });

    it('keeps sweeping after one reminder post fails', async () => {
      mockClient.chat.postMessage.mockRejectedValueOnce(new Error('channel_not_found')).mockResolvedValue({});
      mockGetAll.mockResolvedValue([pendingEsc('esc_a', 50), pendingEsc('esc_b', 40)]);
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const result = await checkOverdueEscalations(mockClient, escalationConfig);
      expect(mockClient.chat.postMessage).toHaveBeenCalledTimes(2);
      expect(result.reminded).toBe(1);
      expect(errSpy).toHaveBeenCalled();
      errSpy.mockRestore();
    });

    it('does not start a second sweep while one is in flight', async () => {
      let release!: (v: any) => void;
      mockGetAll.mockReturnValueOnce(new Promise(r => { release = r; }));
      const first = checkOverdueEscalations(mockClient, escalationConfig);
      const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 2 * MIN);
      const second = await checkOverdueEscalations(mockClient, escalationConfig);
      expect(second.throttled).toBe(true);
      nowSpy.mockRestore();
      release([]);
      await first;
      expect(mockGetAll).toHaveBeenCalledTimes(1);
    });
  });
});
