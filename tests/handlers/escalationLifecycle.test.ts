import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/state/escalationState.js');
vi.mock('../../src/slack/escalationBlocks.js');

import {
  getAllPendingEscalations,
  updateReminderTime,
  timeoutEscalation,
} from '../../src/state/escalationState.js';
import { buildEscalationReminderBlocks } from '../../src/slack/escalationBlocks.js';
import { checkOverdueEscalations, _resetThrottle } from '../../src/handlers/escalationLifecycle.js';

const mockGetAll = vi.mocked(getAllPendingEscalations);
const mockUpdateReminder = vi.mocked(updateReminderTime);
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
    mockUpdateReminder.mockResolvedValue(undefined);
    mockTimeout.mockResolvedValue(undefined);
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
    expect(mockUpdateReminder).toHaveBeenCalledWith('esc_trace-1');
  });

  it('skips reminder when just created (createdAt is recent, no lastReminderAt)', async () => {
    mockGetAll.mockResolvedValue([{
      ...baseEscalation,
      createdAt: new Date(Date.now() - 5 * 60000), // created 5 minutes ago
      lastReminderAt: undefined,
    }]);

    await checkOverdueEscalations(mockClient, escalationConfig);

    expect(mockBuildReminder).not.toHaveBeenCalled();
    expect(mockUpdateReminder).not.toHaveBeenCalled();
    expect(mockClient.chat.postMessage).not.toHaveBeenCalled();
  });

  it('skips reminder when lastReminderAt is recent', async () => {
    mockGetAll.mockResolvedValue([{
      ...baseEscalation,
      lastReminderAt: new Date(Date.now() - 5 * 60000), // 5 minutes ago
    }]);

    await checkOverdueEscalations(mockClient, escalationConfig);

    expect(mockBuildReminder).not.toHaveBeenCalled();
    expect(mockUpdateReminder).not.toHaveBeenCalled();
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
    expect(mockUpdateReminder).not.toHaveBeenCalled();
  });

  it('throttles: skips Firestore query when called again within 1 minute', async () => {
    mockGetAll.mockResolvedValue([]);

    await checkOverdueEscalations(mockClient, escalationConfig);
    expect(mockGetAll).toHaveBeenCalledTimes(1);

    // Second call within the same minute — should be throttled
    await checkOverdueEscalations(mockClient, escalationConfig);
    expect(mockGetAll).toHaveBeenCalledTimes(1);
  });
});
