import type { WebClient } from '@slack/web-api';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/state/pendingNotifications.js', () => ({
  getPendingNotifications: vi.fn(),
  markNotificationDelivered: vi.fn(),
}));

import {
  getPendingNotifications,
  markNotificationDelivered,
  type PendingNotification,
} from '../../src/state/pendingNotifications.js';
import { deliverPendingNotifications } from '../../src/handlers/notificationDelivery.js';

const mockGetPendingNotifications = vi.mocked(getPendingNotifications);
const mockMarkNotificationDelivered = vi.mocked(markNotificationDelivered);
const mockPostMessage = vi.fn();

const mockClient = {
  chat: { postMessage: mockPostMessage },
} as unknown as WebClient;

function makeNotification(overrides: Partial<PendingNotification> = {}): PendingNotification {
  const teachingId = overrides.teachingId ?? 'teach_1';
  return {
    id: `notif_${teachingId}`,
    kind: 'teaching_promoted',
    channel: 'C1',
    threadTs: '1718000000.000100',
    userId: 'U1',
    teachingId,
    status: 'pending',
    createdAt: new Date('2026-06-10T12:00:00.000Z'),
    expiresAt: new Date('2026-07-10T12:00:00.000Z'),
    ...overrides,
  };
}

describe('deliverPendingNotifications', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPostMessage.mockResolvedValue({ ok: true });
    mockMarkNotificationDelivered.mockResolvedValue(undefined);
  });

  it('posts to originating thread, mentions user, marks delivered', async () => {
    const notification = makeNotification();
    mockGetPendingNotifications.mockResolvedValue([notification]);

    const result = await deliverPendingNotifications(mockClient);

    expect(mockPostMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'C1',
        thread_ts: '1718000000.000100',
        text: '✅ <@U1> your feedback on this answer was reviewed by the data team and is now part of my knowledge. Future answers to questions like this will use it.',
      }),
    );
    expect(mockMarkNotificationDelivered).toHaveBeenCalledWith('notif_teach_1');
    expect(result).toEqual({ delivered: 1, failed: 0 });
  });

  it('uses no-mention copy when userId is absent', async () => {
    const notification = makeNotification({ userId: undefined });
    mockGetPendingNotifications.mockResolvedValue([notification]);

    await deliverPendingNotifications(mockClient);

    expect(mockPostMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: '✅ An update from the data team: the guidance from this thread is now part of my knowledge. Future answers to questions like this will use it.',
      }),
    );
    expect(mockMarkNotificationDelivered).toHaveBeenCalledWith('notif_teach_1');
  });

  it('leaves doc pending when Slack post fails', async () => {
    const notification = makeNotification();
    mockGetPendingNotifications.mockResolvedValue([notification]);
    mockPostMessage.mockRejectedValue(new Error('slack failed'));

    const result = await deliverPendingNotifications(mockClient);

    expect(mockMarkNotificationDelivered).not.toHaveBeenCalled();
    expect(result).toEqual({ delivered: 0, failed: 1 });
  });

  it('continues past a failure to deliver the rest', async () => {
    const first = makeNotification({ teachingId: 'teach_1', id: 'notif_teach_1' });
    const second = makeNotification({ teachingId: 'teach_2', id: 'notif_teach_2' });
    mockGetPendingNotifications.mockResolvedValue([first, second]);
    mockPostMessage
      .mockRejectedValueOnce(new Error('slack failed'))
      .mockResolvedValueOnce({ ok: true });

    const result = await deliverPendingNotifications(mockClient);

    expect(mockPostMessage).toHaveBeenCalledTimes(2);
    expect(mockMarkNotificationDelivered).toHaveBeenCalledTimes(1);
    expect(mockMarkNotificationDelivered).toHaveBeenCalledWith('notif_teach_2');
    expect(result).toEqual({ delivered: 1, failed: 1 });
  });

  it('no-ops on empty queue', async () => {
    mockGetPendingNotifications.mockResolvedValue([]);

    const result = await deliverPendingNotifications(mockClient);

    expect(mockPostMessage).not.toHaveBeenCalled();
    expect(mockMarkNotificationDelivered).not.toHaveBeenCalled();
    expect(result).toEqual({ delivered: 0, failed: 0 });
  });
});
