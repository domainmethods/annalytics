import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockCreate = vi.fn();
const mockGet = vi.fn();
const mockDelete = vi.fn();
const mockSet = vi.fn();
const mockDoc = vi.fn(() => ({
  create: mockCreate,
  get: mockGet,
  delete: mockDelete,
  set: mockSet,
}));
const mockCollection = vi.fn(() => ({ doc: mockDoc }));

vi.mock('../../src/state/firestore.js', () => ({
  FieldValue: { serverTimestamp: () => 'server-ts' },
  getDb: () => ({ collection: mockCollection }),
}));

import {
  claimWhatsAppEvent,
  markWhatsAppEventVisible,
  releaseWhatsAppEventClaim,
} from '../../src/state/whatsappEventDedupe.js';

describe('whatsappEventDedupe', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('claims a new WhatsApp message id with a surface-qualified doc id', async () => {
    mockCreate.mockResolvedValue(undefined);

    await expect(claimWhatsAppEvent('wamid.A/B+C=')).resolves.toBe(true);

    expect(mockCollection).toHaveBeenCalledWith('whatsapp_event_dedupe');
    expect(mockDoc).toHaveBeenCalledWith('whatsapp:wamid.A%2FB%2BC%3D');
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({
      eventId: 'wamid.A/B+C=',
      state: 'pending',
      seenAt: 'server-ts',
      expiresAt: expect.any(Date),
    }));
  });

  it('keeps pending claims long enough to suppress long-running webhook retries', async () => {
    vi.useFakeTimers();
    const now = new Date('2026-06-21T12:00:00.000Z');
    vi.setSystemTime(now);
    mockCreate.mockResolvedValue(undefined);

    await expect(claimWhatsAppEvent('wamid.long-running')).resolves.toBe(true);

    const payload = mockCreate.mock.calls[0][0] as { expiresAt: Date };
    expect(payload.expiresAt.getTime() - now.getTime()).toBeGreaterThanOrEqual(5 * 60 * 1000);
  });

  it('returns false for an existing non-expired claim', async () => {
    mockCreate.mockRejectedValueOnce({ code: 6 });
    mockGet.mockResolvedValueOnce({
      exists: true,
      data: () => ({ expiresAt: new Date(Date.now() + 60_000) }),
    });

    await expect(claimWhatsAppEvent('wamid.1')).resolves.toBe(false);
  });

  it('reclaims an expired claim', async () => {
    mockCreate
      .mockRejectedValueOnce({ code: 6 })
      .mockResolvedValueOnce(undefined);
    mockGet.mockResolvedValueOnce({
      exists: true,
      data: () => ({ expiresAt: new Date(Date.now() - 60_000) }),
    });
    mockDelete.mockResolvedValueOnce(undefined);

    await expect(claimWhatsAppEvent('wamid.1')).resolves.toBe(true);
    expect(mockDelete).toHaveBeenCalledTimes(1);
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });

  it('releases a pending claim', async () => {
    mockDelete.mockResolvedValue(undefined);
    await releaseWhatsAppEventClaim('wamid.1');
    expect(mockDelete).toHaveBeenCalledTimes(1);
  });

  it('marks a WhatsApp message id visible with a durable surface-qualified doc id', async () => {
    mockSet.mockResolvedValue(undefined);

    await markWhatsAppEventVisible('wamid.A/B+C=');

    expect(mockCollection).toHaveBeenCalledWith('whatsapp_event_dedupe');
    expect(mockDoc).toHaveBeenCalledWith('whatsapp:wamid.A%2FB%2BC%3D');
    expect(mockSet).toHaveBeenCalledWith(
      {
        state: 'visible',
        visibleAt: 'server-ts',
        expiresAt: expect.any(Date),
      },
      { merge: true },
    );
  });
});
