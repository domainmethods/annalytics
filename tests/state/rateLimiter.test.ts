import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockDocGet = vi.fn();
const mockDocSet = vi.fn();
const mockDocUpdate = vi.fn();
const mockDoc = vi.fn().mockReturnValue({
  get: mockDocGet,
  set: mockDocSet,
  update: mockDocUpdate,
});
const mockCollection = vi.fn().mockReturnValue({ doc: mockDoc });

vi.mock('../../src/state/firestore.js', () => ({
  getDb: () => ({ collection: mockCollection }),
  FieldValue: { increment: (n: number) => `INCREMENT_${n}` },
}));

import { checkRateLimit } from '../../src/state/rateLimiter.js';

describe('checkRateLimit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('allows request when under limit', async () => {
    mockDocGet.mockResolvedValue({
      exists: true,
      data: () => ({
        queryCount: 5,
        windowStart: { toDate: () => new Date() },
      }),
    });
    mockDocUpdate.mockResolvedValue(undefined);

    const result = await checkRateLimit('user-123', 30);
    expect(result.allowed).toBe(true);
  });

  it('blocks request when at limit', async () => {
    mockDocGet.mockResolvedValue({
      exists: true,
      data: () => ({
        queryCount: 30,
        windowStart: { toDate: () => new Date() },
      }),
    });

    const result = await checkRateLimit('user-123', 30);
    expect(result.allowed).toBe(false);
    expect(result.retryAfterMinutes).toBeGreaterThan(0);
  });

  it('resets window when expired', async () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    mockDocGet.mockResolvedValue({
      exists: true,
      data: () => ({
        queryCount: 30,
        windowStart: { toDate: () => twoHoursAgo },
      }),
    });
    mockDocSet.mockResolvedValue(undefined);

    const result = await checkRateLimit('user-123', 30);
    expect(result.allowed).toBe(true);
    expect(mockDocSet).toHaveBeenCalled(); // reset the window
  });

  it('creates new entry for first-time user', async () => {
    mockDocGet.mockResolvedValue({ exists: false });
    mockDocSet.mockResolvedValue(undefined);

    const result = await checkRateLimit('new-user', 30);
    expect(result.allowed).toBe(true);
  });
});
