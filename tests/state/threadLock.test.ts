import { beforeEach, describe, expect, it, vi } from 'vitest';

interface LeaseDoc {
  ownerToken: string;
  expiresAt: { toDate: () => Date };
}

const leases = new Map<string, LeaseDoc>();
let transactionQueue: Promise<unknown> = Promise.resolve();
const mockCollection = vi.fn();
const mockDoc = vi.fn();

const CH = 'C_ONE';
const KEY = 'C_ONE:thread-1';

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
        get: async (ref: { id: string }) => {
          const current = leases.get(ref.id);
          return { exists: !!current, data: () => current };
        },
        set: (ref: { id: string }, value: { ownerToken: string; expiresAt: Date }) => {
          leases.set(ref.id, { ownerToken: value.ownerToken, expiresAt: { toDate: () => value.expiresAt } });
        },
        delete: (ref: { id: string }) => { leases.delete(ref.id); },
      }));
      transactionQueue = result.then(() => undefined, () => undefined);
      return result;
    },
  }),
}));

import { acquireThreadLock, releaseThreadLock } from '../../src/state/threadLock.js';

beforeEach(() => {
  vi.clearAllMocks();
  leases.clear();
  leases.set(KEY, { ownerToken: 'old', expiresAt: { toDate: () => new Date(0) } });
});

describe('acquireThreadLock', () => {
  it('stores the lease in processing_threads keyed by conversation and thread', async () => {
    await acquireThreadLock(CH, 'thread-1', 'a');
    expect(mockCollection).toHaveBeenCalledWith('processing_threads');
    expect(mockDoc).toHaveBeenCalledWith('C_ONE:thread-1');
  });

  it('admits exactly one contender for an expired lease', async () => {
    const results = await Promise.all([
      acquireThreadLock(CH, 'thread-1', 'a'),
      acquireThreadLock(CH, 'thread-1', 'b'),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('keeps an active lease and rejects a contender', async () => {
    expect(await acquireThreadLock(CH, 'thread-1', 'first')).toBe(true);
    expect(await acquireThreadLock(CH, 'thread-1', 'second')).toBe(false);
    expect(leases.get(KEY)?.ownerToken).toBe('first');
  });
});

describe('releaseThreadLock', () => {
  it('ignores a late release from a previous owner', async () => {
    await acquireThreadLock(CH, 'thread-1', 'new');
    await releaseThreadLock(CH, 'thread-1', 'old');
    expect(leases.get(KEY)?.ownerToken).toBe('new');
  });

  it('deletes only for the current owner and tolerates repeated releases', async () => {
    await acquireThreadLock(CH, 'thread-1', 'new');
    await releaseThreadLock(CH, 'thread-1', 'new');
    await releaseThreadLock(CH, 'thread-1', 'new');
    expect(leases.has(KEY)).toBe(false);
  });
});

describe('conversation scoping', () => {
  it('uses distinct lock documents for the same thread ts in different conversations', async () => {
    await acquireThreadLock('C_ONE', 'same.ts', 'a');
    await acquireThreadLock('C_TWO', 'same.ts', 'b');
    expect(mockDoc).toHaveBeenCalledWith('C_ONE:same.ts');
    expect(mockDoc).toHaveBeenCalledWith('C_TWO:same.ts');
  });

  it('does not block another conversation sharing the same thread ts', async () => {
    expect(await acquireThreadLock('C_ONE', 'same.ts', 'a')).toBe(true);
    expect(await acquireThreadLock('C_TWO', 'same.ts', 'b')).toBe(true);
    expect(await acquireThreadLock('C_ONE', 'same.ts', 'c')).toBe(false);
    expect(leases.get('C_ONE:same.ts')?.ownerToken).toBe('a');
    expect(leases.get('C_TWO:same.ts')?.ownerToken).toBe('b');
  });

  it('releasing in one conversation leaves the other conversation locked', async () => {
    await acquireThreadLock('C_ONE', 'same.ts', 'a');
    await acquireThreadLock('C_TWO', 'same.ts', 'b');
    await releaseThreadLock('C_ONE', 'same.ts', 'a');
    expect(leases.has('C_ONE:same.ts')).toBe(false);
    expect(leases.get('C_TWO:same.ts')?.ownerToken).toBe('b');
  });
});
