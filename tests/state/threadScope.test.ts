import { describe, it, expect, vi } from 'vitest';
import { findOwnedDoc, conversationThreadKey, THREAD_SCOPE_PAGE_SIZE } from '../../src/state/threadScope.js';

const doc = (id: string, channel?: string) => ({
  id,
  data: () => ({ ...(channel === undefined ? {} : { channel }) }),
});
const page = (docs: unknown[]) => ({ docs });

function fakeQuery(pages: unknown[][]) {
  const get = vi.fn();
  pages.forEach(p => get.mockResolvedValueOnce(page(p)));
  const paged = { get };
  const limit = vi.fn().mockReturnValue(paged);
  const startAfter = vi.fn().mockReturnValue({ limit });
  const query = { limit, startAfter } as any;
  return { query, limit, startAfter, get };
}

describe('conversationThreadKey', () => {
  it('joins channel and thread ts', () => {
    expect(conversationThreadKey('C1', '1.2')).toBe('C1:1.2');
  });
});

describe('findOwnedDoc', () => {
  it('returns the owned doc from the first page without paging', async () => {
    const owned = doc('a', 'C1');
    const { query, startAfter, limit } = fakeQuery([[doc('x', 'C2'), owned]]);
    expect(await findOwnedDoc(query, 'channel', 'C1')).toBe(owned);
    expect(limit).toHaveBeenCalledWith(THREAD_SCOPE_PAGE_SIZE);
    expect(startAfter).not.toHaveBeenCalled();
  });

  it('pages past a full page of foreign/legacy docs to find the owned doc', async () => {
    const first = Array.from({ length: 20 }, (_, i) => (i % 2 ? doc(`f${i}`, 'C_OTHER') : doc(`l${i}`)));
    const owned = doc('mine', 'C1');
    const { query, startAfter, limit } = fakeQuery([first, [owned]]);

    expect(await findOwnedDoc(query, 'channel', 'C1')).toBe(owned);
    expect(startAfter).toHaveBeenCalledTimes(1);
    expect(startAfter).toHaveBeenCalledWith(first[19]);
    expect(limit).toHaveBeenLastCalledWith(20);
  });

  it('returns null after a full non-matching page followed by an empty page', async () => {
    const first = Array.from({ length: 20 }, (_, i) => doc(`f${i}`, 'C_OTHER'));
    const { query, startAfter } = fakeQuery([first, []]);
    expect(await findOwnedDoc(query, 'channel', 'C1')).toBeNull();
    expect(startAfter).toHaveBeenCalledWith(first[19]);
  });

  it('returns null without paging when a partial page has no match', async () => {
    const { query, startAfter } = fakeQuery([[doc('x', 'C2')]]);
    expect(await findOwnedDoc(query, 'channel', 'C1')).toBeNull();
    expect(startAfter).not.toHaveBeenCalled();
  });

  it('never matches a doc without the owner field', async () => {
    const { query } = fakeQuery([[doc('legacy')]]);
    expect(await findOwnedDoc(query, 'channel', 'C1')).toBeNull();
  });

  it('matches any id in an owner array', async () => {
    const byUser = doc('u', 'U_ANALYST');
    const byChannel = doc('c', 'D1');
    expect(await findOwnedDoc(fakeQuery([[doc('x', 'C9'), byUser]]).query, 'channel', ['D1', 'U_ANALYST'])).toBe(byUser);
    expect(await findOwnedDoc(fakeQuery([[doc('x', 'C9'), byChannel]]).query, 'channel', ['D1', 'U_ANALYST'])).toBe(byChannel);
  });
});
