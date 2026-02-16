import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockCreate = vi.fn();
const mockGet = vi.fn();
const mockDelete = vi.fn();
const mockDoc = vi.fn().mockReturnValue({
  create: mockCreate,
  get: mockGet,
  delete: mockDelete,
});
const mockCollection = vi.fn().mockReturnValue({ doc: mockDoc });

vi.mock('../../src/state/firestore.js', () => ({
  getDb: () => ({ collection: mockCollection }),
  FieldValue: { serverTimestamp: () => 'SERVER_TIMESTAMP' },
}));

import { acquireThreadLock, releaseThreadLock } from '../../src/state/threadLock.js';

describe('acquireThreadLock', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns true when lock is acquired (doc created)', async () => {
    mockCreate.mockResolvedValue(undefined);
    const result = await acquireThreadLock('thread-123');
    expect(result).toBe(true);
    expect(mockCollection).toHaveBeenCalledWith('processing_threads');
    expect(mockDoc).toHaveBeenCalledWith('thread-123');
  });

  it('returns false when lock already exists and not expired', async () => {
    const futureDate = new Date(Date.now() + 300_000);
    mockCreate.mockRejectedValue(Object.assign(new Error('exists'), { code: 6 }));
    mockGet.mockResolvedValue({
      exists: true,
      data: () => ({ expiresAt: { toDate: () => futureDate } }),
    });

    const result = await acquireThreadLock('thread-123');
    expect(result).toBe(false);
  });

  it('reclaims expired lock', async () => {
    const pastDate = new Date(Date.now() - 1000);
    let callCount = 0;
    mockCreate.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) throw Object.assign(new Error('exists'), { code: 6 });
    });
    mockGet.mockResolvedValue({
      exists: true,
      data: () => ({ expiresAt: { toDate: () => pastDate } }),
    });
    mockDelete.mockResolvedValue(undefined);

    const result = await acquireThreadLock('thread-123');
    expect(mockDelete).toHaveBeenCalled();
    expect(result).toBe(true);
  });
});

describe('releaseThreadLock', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('deletes the lock document', async () => {
    mockDelete.mockResolvedValue(undefined);
    await releaseThreadLock('thread-123');
    expect(mockDoc).toHaveBeenCalledWith('thread-123');
    expect(mockDelete).toHaveBeenCalled();
  });
});
