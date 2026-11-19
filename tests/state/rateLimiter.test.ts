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

// Serialize transaction callbacks to model Firestore's isolation guarantee.
let transactionQueue = Promise.resolve();
const mockRunTransaction = vi.fn((callback: (tx: unknown) => Promise<unknown>) => {
  const result = transactionQueue.then(() => callback({
    get: mockDocGet,
    set: (_ref: unknown, data: unknown) => mockDocSet(data),
    update: (_ref: unknown, data: unknown) => mockDocUpdate(data),
  }));
  transactionQueue = result.then(() => undefined, () => undefined);
  return result;
});

vi.mock('../../src/state/firestore.js', () => ({
  getDb: () => ({ collection: mockCollection, runTransaction: mockRunTransaction }),
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

describe('concurrent admission', () => {
  it.each(['last slot', 'new window', 'expired window'])('%s preserves every admission', async (scenario) => {
    let stored = scenario === 'new window' ? undefined : {
      queryCount: scenario === 'last slot' ? 29 : 30,
      windowStart: new Date(Date.now() - (scenario === 'expired window' ? 7_200_000 : 0)),
    };
    mockDocGet.mockImplementation(async () => {
      const snapshot = stored && { ...stored };
      return { exists: snapshot !== undefined, data: () => snapshot && ({
        ...snapshot, windowStart: { toDate: () => snapshot.windowStart },
      }) };
    });
    mockDocSet.mockImplementation(async (data) => { stored = data; });
    mockDocUpdate.mockImplementation(async (data) => {
      stored!.queryCount = typeof data.queryCount === 'number' ? data.queryCount : stored!.queryCount + 1;
    });
    const results = await Promise.all([checkRateLimit('user-123', 30), checkRateLimit('user-123', 30)]);
    expect(results.filter(result => result.allowed)).toHaveLength(scenario === 'last slot' ? 1 : 2);
    expect(stored!.queryCount).toBe(scenario === 'last slot' ? 30 : 2);
  });
});
