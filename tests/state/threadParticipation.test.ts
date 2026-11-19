import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockSet = vi.fn();
const mockGet = vi.fn();
const mockDoc = vi.fn(() => ({ set: mockSet, get: mockGet }));
const mockCollection = vi.fn(() => ({ doc: mockDoc }));

vi.mock('../../src/state/firestore.js', () => ({
  getDb: vi.fn(() => ({ collection: mockCollection })),
}));

import { hasThreadParticipation, recordThreadParticipation } from '../../src/state/threadParticipation.js';

describe('threadParticipation (#53)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSet.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('records participation per conversation thread with the answer retention window', async () => {
    vi.useFakeTimers();
    const now = new Date('2026-11-01T00:00:00.000Z');
    vi.setSystemTime(now);

    await recordThreadParticipation('C1', '1700000000.000100');

    expect(mockCollection).toHaveBeenCalledWith('thread_participation');
    expect(mockDoc).toHaveBeenCalledWith('C1:1700000000.000100');
    expect(mockSet).toHaveBeenCalledWith({
      channel: 'C1',
      threadTs: '1700000000.000100',
      updatedAt: now,
      expiresAt: new Date('2027-01-30T00:00:00.000Z'), // default 90 days
    });
  });

  it('is false when the thread has no mark', async () => {
    mockGet.mockResolvedValue({ exists: false });
    await expect(hasThreadParticipation('C1', 'T1')).resolves.toBe(false);
  });

  it('is false for a mark with no expiresAt', async () => {
    mockGet.mockResolvedValue({ exists: true, data: () => ({ channel: 'C1', threadTs: 'T1' }) });
    await expect(hasThreadParticipation('C1', 'T1')).resolves.toBe(false);
  });

  it('is true for a live mark, including Firestore Timestamps', async () => {
    mockGet.mockResolvedValue({
      exists: true,
      data: () => ({ expiresAt: { toDate: () => new Date(Date.now() + 60_000) } }),
    });
    await expect(hasThreadParticipation('C1', 'T1')).resolves.toBe(true);
  });

  it('is false for a mark past its expiry that TTL has not deleted yet', async () => {
    mockGet.mockResolvedValue({
      exists: true,
      data: () => ({ expiresAt: new Date(Date.now() - 1000) }),
    });
    await expect(hasThreadParticipation('C1', 'T1')).resolves.toBe(false);
  });

  it('keeps marks in another channel separate', async () => {
    mockGet.mockResolvedValue({ exists: false });
    await hasThreadParticipation('C2', 'T1');
    expect(mockDoc).toHaveBeenCalledWith('C2:T1');
  });
});
