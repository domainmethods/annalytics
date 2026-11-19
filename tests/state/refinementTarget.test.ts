import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const store = new Map<string, any>();
const mockDoc = vi.fn((id: string) => ({
  id,
  set: vi.fn(async (data: any) => { store.set(id, data); }),
  get: vi.fn(async () => ({ exists: store.has(id), data: () => store.get(id) })),
}));

vi.mock('../../src/state/firestore.js', () => ({
  getDb: vi.fn(() => ({
    collection: vi.fn(() => ({ doc: mockDoc })),
    runTransaction: async (fn: any) => fn({
      get: async (ref: any) => ({ exists: store.has(ref.id), data: () => store.get(ref.id) }),
      delete: (ref: any) => { store.delete(ref.id); },
    }),
  })),
}));

import {
  REFINEMENT_TARGET_TTL_MS,
  consumeRefinementTarget,
  getRefinementTarget,
  saveRefinementTarget,
} from '../../src/state/refinementTarget.js';

const target = { channel: 'C1', threadTs: '1700.0001', userId: 'U1', responseKey: '1700.0001_1700.0002' };

describe('refinementTarget (#51)', () => {
  beforeEach(() => {
    store.clear();
    vi.clearAllMocks();
  });
  afterEach(() => vi.useRealTimers());

  it('saves one target per conversation thread and user, with a TTL', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-01T00:00:00Z'));
    await saveRefinementTarget(target);
    expect(mockDoc).toHaveBeenCalledWith('C1:1700.0001_U1');
    expect(store.get('C1:1700.0001_U1')).toEqual({
      ...target,
      createdAt: new Date('2026-11-01T00:00:00Z'),
      expiresAt: new Date(Date.parse('2026-11-01T00:00:00Z') + REFINEMENT_TARGET_TTL_MS),
    });
  });

  it('reads the picked answer without consuming it, until it is consumed', async () => {
    await saveRefinementTarget(target);
    expect(await getRefinementTarget('C1', '1700.0001', 'U1')).toBe('1700.0001_1700.0002');
    expect(await getRefinementTarget('C1', '1700.0001', 'U1')).toBe('1700.0001_1700.0002');
    await consumeRefinementTarget('C1', '1700.0001', 'U1', '1700.0001_1700.0002');
    expect(await getRefinementTarget('C1', '1700.0001', 'U1')).toBeNull();
  });

  it('keeps a newer pick of a different answer when consuming the old one', async () => {
    await saveRefinementTarget({ ...target, responseKey: '1700.0001_1700.0009' });
    await consumeRefinementTarget('C1', '1700.0001', 'U1', '1700.0001_1700.0002');
    expect(await getRefinementTarget('C1', '1700.0001', 'U1')).toBe('1700.0001_1700.0009');
  });

  it("does not hand one user's target to another user or thread", async () => {
    await saveRefinementTarget(target);
    expect(await getRefinementTarget('C1', '1700.0001', 'U2')).toBeNull();
    expect(await getRefinementTarget('C2', '1700.0001', 'U1')).toBeNull();
    expect(await getRefinementTarget('C1', '1700.0001', 'U1')).toBe('1700.0001_1700.0002');
  });

  it('ignores an expired target', async () => {
    store.set('C1:1700.0001_U1', { ...target, expiresAt: { toDate: () => new Date(Date.now() - 1000) } });
    expect(await getRefinementTarget('C1', '1700.0001', 'U1')).toBeNull();
  });
});
