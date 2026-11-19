import { beforeEach, expect, it, vi } from 'vitest';
let data: any;
let queue = Promise.resolve();
vi.mock('../../src/state/firestore.js', () => ({
  FieldValue: { serverTimestamp: () => 'timestamp' },
  getDb: () => ({ collection: () => ({ doc: () => ({ create: async (value: any) => { if (data) throw { code: 6 }; data = value; }, get: async () => { const snapshot = data; return { exists: !!snapshot, data: () => snapshot }; }, delete: async () => { data = undefined; } }) }), runTransaction: (fn: any) => {
    const result = queue.then(() => fn({
      get: async () => { const snapshot = data; return { exists: !!snapshot, data: () => snapshot }; },
      set: (_: any, value: any) => { data = { ...value, expiresAt: { toDate: () => value.expiresAt } }; },
      delete: () => { data = undefined; },
    }));
    queue = result.then(() => undefined, () => undefined);
    return result;
  } }),
}));
import { acquireThreadLock, releaseThreadLock } from '../../src/state/threadLock.js';
beforeEach(() => { data = { ownerToken: 'old', expiresAt: { toDate: () => new Date(0) } }; });
it('allows exactly one expired-lease contender', async () => {
  const results = await Promise.all([acquireThreadLock('thread', 'a'), acquireThreadLock('thread', 'b')]);
  expect(results.filter(Boolean)).toHaveLength(1);
});
it('ignores late and repeated releases', async () => {
  await acquireThreadLock('thread', 'new');
  await releaseThreadLock('thread', 'old');
  expect(data.ownerToken).toBe('new');
  await releaseThreadLock('thread', 'new');
  await releaseThreadLock('thread', 'new');
  expect(data).toBeUndefined();
});

it('keeps an active lease and rejects a contender', async () => {
  expect(await acquireThreadLock('thread', 'first')).toBe(true);
  expect(await acquireThreadLock('thread', 'second')).toBe(false);
  expect(data.ownerToken).toBe('first');
});
it('release without ownership does nothing', async () => {
  await releaseThreadLock('thread');
  expect(data.ownerToken).toBe('old');
});
