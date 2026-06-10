import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSet = vi.fn();
const mockGet = vi.fn();
const mockUpdate = vi.fn();
const mockWhere = vi.fn(() => ({ get: mockGet }));
const mockDoc = vi.fn(() => ({ set: mockSet, update: mockUpdate }));
const mockCollection = vi.fn(() => ({ doc: mockDoc, where: mockWhere }));

vi.mock('../../src/state/firestore.js', () => ({
  getDb: vi.fn(() => ({ collection: mockCollection })),
}));

import {
  enqueueNotification,
  getPendingNotifications,
  markNotificationDelivered,
} from '../../src/state/pendingNotifications.js';

describe('pendingNotifications', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWhere.mockReturnValue({ get: mockGet });
    mockDoc.mockReturnValue({ set: mockSet, update: mockUpdate });
    mockCollection.mockReturnValue({ doc: mockDoc, where: mockWhere });
    mockSet.mockResolvedValue(undefined);
    mockUpdate.mockResolvedValue(undefined);
  });

  it('enqueues with status pending and a ~30d expiresAt', async () => {
    await enqueueNotification({
      id: 'notif_teach_esc_fb_tr1',
      kind: 'teaching_promoted',
      channel: 'C1',
      threadTs: '1718000000.000100',
      userId: 'U1',
      teachingId: 'teach_esc_fb_tr1',
    });

    expect(mockCollection).toHaveBeenCalledWith('pending_notifications');
    expect(mockDoc).toHaveBeenCalledWith('notif_teach_esc_fb_tr1');
    const written = mockSet.mock.calls[0][0];
    expect(written.status).toBe('pending');
    expect(written.userId).toBe('U1');
    const ageMs = written.expiresAt.getTime() - written.createdAt.getTime();
    expect(ageMs).toBe(30 * 86_400_000);
  });

  it('omits userId entirely when absent (Firestore rejects undefined)', async () => {
    await enqueueNotification({
      id: 'notif_teach_esc_a',
      kind: 'teaching_promoted',
      channel: 'C1',
      threadTs: '1718000000.000100',
      teachingId: 'teach_esc_a',
    });
    expect(mockSet.mock.calls[0][0]).not.toHaveProperty('userId');
  });

  it('getPendingNotifications filters on status only (no orderBy)', async () => {
    mockGet.mockResolvedValue({
      empty: false,
      docs: [
        {
          data: () => ({
            id: 'notif_x',
            kind: 'teaching_promoted',
            channel: 'C1',
            threadTs: 't1',
            teachingId: 'teach_x',
            status: 'pending',
            createdAt: { toDate: () => new Date('2026-06-10T00:00:00Z') },
            expiresAt: { toDate: () => new Date('2026-07-10T00:00:00Z') },
          }),
        },
      ],
    });

    const result = await getPendingNotifications();

    expect(mockWhere).toHaveBeenCalledWith('status', '==', 'pending');
    expect(result).toHaveLength(1);
    expect(result[0].createdAt).toBeInstanceOf(Date);
  });

  it('getPendingNotifications returns [] when empty', async () => {
    mockGet.mockResolvedValue({ empty: true, docs: [] });
    expect(await getPendingNotifications()).toEqual([]);
  });

  it('markNotificationDelivered flips status', async () => {
    await markNotificationDelivered('notif_x');
    expect(mockDoc).toHaveBeenCalledWith('notif_x');
    expect(mockUpdate).toHaveBeenCalledWith({ status: 'delivered' });
  });
});
