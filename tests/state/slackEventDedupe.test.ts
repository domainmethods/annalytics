import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockCreate = vi.fn();
const mockGet = vi.fn();
const mockSet = vi.fn();
const mockDelete = vi.fn();
const mockDoc = vi.fn().mockReturnValue({
  create: mockCreate,
  get: mockGet,
  set: mockSet,
  delete: mockDelete,
});
const mockCollection = vi.fn().mockReturnValue({ doc: mockDoc });

vi.mock('../../src/state/firestore.js', () => ({
  getDb: () => ({ collection: mockCollection }),
  FieldValue: { serverTimestamp: () => 'SERVER_TIMESTAMP' },
}));

import {
  claimSlackEvent,
  extractSlackEventId,
  markSlackEventVisible,
  releaseSlackEventClaim,
} from '../../src/state/slackEventDedupe.js';

describe('extractSlackEventId', () => {
  it('extracts a Slack event ID from an event callback body', () => {
    expect(extractSlackEventId({ event_id: 'Ev123' })).toBe('Ev123');
  });

  it('returns undefined when the body has no usable event ID', () => {
    expect(extractSlackEventId({})).toBeUndefined();
    expect(extractSlackEventId({ event_id: '' })).toBeUndefined();
    expect(extractSlackEventId(null)).toBeUndefined();
  });
});

describe('claimSlackEvent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('allows processing when no event ID is available', async () => {
    await expect(claimSlackEvent(undefined)).resolves.toBe(true);
    expect(mockCollection).not.toHaveBeenCalled();
  });

  it('creates a dedupe record and allows first delivery', async () => {
    mockCreate.mockResolvedValue(undefined);

    await expect(claimSlackEvent('Ev123')).resolves.toBe(true);

    expect(mockCollection).toHaveBeenCalledWith('slack_event_dedupe');
    expect(mockDoc).toHaveBeenCalledWith('Ev123');
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({
      eventId: 'Ev123',
      state: 'pending',
      seenAt: 'SERVER_TIMESTAMP',
      expiresAt: expect.any(Date),
    }));
  });

  it('suppresses duplicate Slack event deliveries while the claim is unexpired', async () => {
    mockCreate.mockRejectedValue(Object.assign(new Error('exists'), { code: 6 }));
    mockGet.mockResolvedValue({
      exists: true,
      data: () => ({ expiresAt: { toDate: () => new Date(Date.now() + 30_000) } }),
    });

    await expect(claimSlackEvent('Ev123')).resolves.toBe(false);
  });

  it('reclaims an expired pending event so a later Slack retry can proceed', async () => {
    let createCalls = 0;
    mockCreate.mockImplementation(async () => {
      createCalls++;
      if (createCalls === 1) {
        throw Object.assign(new Error('exists'), { code: 6 });
      }
    });
    mockGet.mockResolvedValue({
      exists: true,
      data: () => ({ expiresAt: { toDate: () => new Date(Date.now() - 1000) } }),
    });
    mockDelete.mockResolvedValue(undefined);

    await expect(claimSlackEvent('Ev123')).resolves.toBe(true);
    expect(mockDelete).toHaveBeenCalled();
  });

  it('propagates expired claim delete failures instead of retrying indefinitely', async () => {
    let createCalls = 0;
    mockCreate.mockImplementation(async () => {
      createCalls++;
      if (createCalls === 1) {
        throw Object.assign(new Error('exists'), { code: 6 });
      }
    });
    mockGet.mockResolvedValue({
      exists: true,
      data: () => ({ expiresAt: { toDate: () => new Date(Date.now() - 1000) } }),
    });
    const deleteError = new Error('delete failed');
    mockDelete.mockRejectedValue(deleteError);

    await expect(claimSlackEvent('Ev123')).rejects.toThrow('delete failed');
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it('reclaims an event if the existing claim was concurrently released', async () => {
    let createCalls = 0;
    mockCreate.mockImplementation(async () => {
      createCalls++;
      if (createCalls === 1) {
        throw Object.assign(new Error('exists'), { code: 6 });
      }
    });
    mockGet.mockResolvedValue({ exists: false });

    await expect(claimSlackEvent('Ev123')).resolves.toBe(true);
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });

  it('marks an event visible and extends the dedupe window', async () => {
    mockSet.mockResolvedValue(undefined);

    await markSlackEventVisible('Ev123');

    expect(mockSet).toHaveBeenCalledWith(
      expect.objectContaining({
        state: 'visible',
        visibleAt: 'SERVER_TIMESTAMP',
        expiresAt: expect.any(Date),
      }),
      { merge: true },
    );
  });

  it('releases an event claim when processing fails before a visible response', async () => {
    mockDelete.mockResolvedValue(undefined);

    await releaseSlackEventClaim('Ev123');

    expect(mockDelete).toHaveBeenCalled();
  });

  it('encodes event IDs before using them as Firestore document IDs', async () => {
    mockCreate.mockResolvedValue(undefined);

    await claimSlackEvent('Ev/with/slashes');

    expect(mockDoc).toHaveBeenCalledWith('Ev%2Fwith%2Fslashes');
  });
});
