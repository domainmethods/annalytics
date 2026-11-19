import { beforeEach, describe, expect, it, vi } from 'vitest';

interface LeaseDoc {
  ownerToken: string;
  expiresAt: { toDate: () => Date };
}

let lease: LeaseDoc | undefined;
let transactionQueue: Promise<unknown> = Promise.resolve();
const mockCollection = vi.fn();
const mockDoc = vi.fn();

function snapshot() {
  const current = lease;
  return { exists: !!current, data: () => current };
}

// Serializes transactions like Firestore does under contention, so racing
// contenders observe each other's committed writes.
vi.mock('../../src/state/firestore.js', () => ({
  FieldValue: { serverTimestamp: () => 'timestamp' },
  getDb: () => ({
    collection: (name: string) => {
      mockCollection(name);
      return { doc: (id: string) => { mockDoc(id); return { id }; } };
    },
    runTransaction: (callback: (tx: unknown) => Promise<unknown>) => {
      const result = transactionQueue.then(() => callback({
        get: async () => snapshot(),
        set: (_ref: unknown, value: { ownerToken: string; expiresAt: Date }) => {
          lease = { ownerToken: value.ownerToken, expiresAt: { toDate: () => value.expiresAt } };
        },
        delete: () => { lease = undefined; },
      }));
      transactionQueue = result.then(() => undefined, () => undefined);
      return result;
    },
  }),
}));

import { acquireThreadLock, releaseThreadLock } from '../../src/state/threadLock.js';

beforeEach(() => {
  vi.clearAllMocks();
  lease = { ownerToken: 'old', expiresAt: { toDate: () => new Date(0) } };
});

describe('acquireThreadLock', () => {
  it('stores the lease in processing_threads keyed by thread', async () => {
    await acquireThreadLock('thread-1', 'a');
    expect(mockCollection).toHaveBeenCalledWith('processing_threads');
    expect(mockDoc).toHaveBeenCalledWith('thread-1');
  });

  it('admits exactly one contender for an expired lease', async () => {
    const results = await Promise.all([
      acquireThreadLock('thread-1', 'a'),
      acquireThreadLock('thread-1', 'b'),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('keeps an active lease and rejects a contender', async () => {
    expect(await acquireThreadLock('thread-1', 'first')).toBe(true);
    expect(await acquireThreadLock('thread-1', 'second')).toBe(false);
    expect(lease?.ownerToken).toBe('first');
  });
});

describe('releaseThreadLock', () => {
  it('ignores a late release from a previous owner', async () => {
    await acquireThreadLock('thread-1', 'new');
    await releaseThreadLock('thread-1', 'old');
    expect(lease?.ownerToken).toBe('new');
  });

  it('deletes only for the current owner and tolerates repeated releases', async () => {
    await acquireThreadLock('thread-1', 'new');
    await releaseThreadLock('thread-1', 'new');
    await releaseThreadLock('thread-1', 'new');
    expect(lease).toBeUndefined();
  });
});
