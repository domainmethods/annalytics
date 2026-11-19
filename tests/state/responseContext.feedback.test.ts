import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockUpdate = vi.fn();
const mockDocGet = vi.fn();
const mockDoc = vi.fn();
const mockGet = vi.fn();
const mockOrderBy = vi.fn();
const mockLimit = vi.fn();
const mockWhere = vi.fn();

vi.mock('../../src/state/firestore.js', () => ({
  getDb: () => ({
    collection: (_name: string) => ({
      doc: mockDoc,
      where: mockWhere,
    }),
  }),
}));

// Chain setup helper
function setupChain() {
  mockWhere.mockReturnValue({ where: mockWhere, orderBy: mockOrderBy, limit: mockLimit });
  mockOrderBy.mockReturnValue({ limit: mockLimit });
  mockLimit.mockReturnValue({ get: mockGet });
  mockDoc.mockReturnValue({ update: mockUpdate });
}

import {
  recordFeedback,
  recordFeedbackByResponseContextKey,
  getLatestNegativeFeedback,
} from '../../src/state/responseContext.js';

describe('recordFeedback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupChain();
  });

  it('sets negativeFeedback on the scoped ResponseContext document', async () => {
    mockUpdate.mockResolvedValue(undefined);
    mockDoc.mockReturnValue({ get: mockDocGet });
    mockDocGet.mockResolvedValue({ exists: true, data: () => ({ channel: 'C1' }), ref: { update: mockUpdate } });

    await recordFeedback('C1', 'thread-1', 'msg-1', 'negative');

    expect(mockDoc).toHaveBeenCalledWith('C1:thread-1_msg-1');
    expect(mockUpdate).toHaveBeenCalledWith({ negativeFeedback: true });
  });

  it('falls back to the legacy bare-id doc when it has no channel', async () => {
    mockDoc.mockReturnValue({ get: mockDocGet });
    mockDocGet
      .mockResolvedValueOnce({ exists: false })
      .mockResolvedValueOnce({ exists: true, data: () => ({}), ref: { update: mockUpdate } });

    await recordFeedback('C1', 'thread-1', 'msg-1', 'positive');

    expect(mockDoc).toHaveBeenNthCalledWith(1, 'C1:thread-1_msg-1');
    expect(mockDoc).toHaveBeenNthCalledWith(2, 'thread-1_msg-1');
    expect(mockUpdate).toHaveBeenCalledWith({ negativeFeedback: false });
  });

  it('does not update a legacy-id doc owned by another channel', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockDoc.mockReturnValue({ get: mockDocGet });
    mockDocGet
      .mockResolvedValueOnce({ exists: false })
      .mockResolvedValueOnce({ exists: true, data: () => ({ channel: 'C_OTHER' }), ref: { update: mockUpdate } });

    await recordFeedback('C1', 'thread-1', 'msg-1', 'negative');

    expect(mockUpdate).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('records feedback by persisted response context document key', async () => {
    mockUpdate.mockResolvedValue(undefined);

    await recordFeedbackByResponseContextKey('whatsapp:15551234567_wamid.outbound%2FA%2BB%3D', 'negative');

    expect(mockDoc).toHaveBeenCalledWith('whatsapp:15551234567_wamid.outbound%2FA%2BB%3D');
    expect(mockUpdate).toHaveBeenCalledWith({ negativeFeedback: true });
  });
});

describe('getLatestNegativeFeedback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupChain();
  });

  it('retrieves the most recent negative feedback for a thread', async () => {
    mockGet.mockResolvedValue({
      empty: false,
      docs: [{
        data: () => ({
          channel: 'C_ONE',
          generatedSql: 'SELECT bad FROM table',
          explanation: 'Bad query',
          tablesUsed: ['table'],
        }),
      }],
    });

    const result = await getLatestNegativeFeedback('C_ONE', 'thread-1');

    expect(result).not.toBeNull();
    expect(result!.sql).toBe('SELECT bad FROM table');
    expect(result!.explanation).toBe('Bad query');
    expect(mockWhere).toHaveBeenCalledWith('threadTs', '==', 'thread-1');
    expect(mockWhere).toHaveBeenCalledWith('negativeFeedback', '==', true);
  });

  it('returns null when no negative feedback exists', async () => {
    mockGet.mockResolvedValue({ empty: true, docs: [] });

    const result = await getLatestNegativeFeedback('C_ONE', 'thread-1');

    expect(result).toBeNull();
  });

  it('returns null when negative feedback exists in a different thread', async () => {
    mockGet.mockResolvedValue({ empty: true, docs: [] });

    const result = await getLatestNegativeFeedback('C_ONE', 'thread-other');

    expect(result).toBeNull();
    expect(mockWhere).toHaveBeenCalledWith('threadTs', '==', 'thread-other');
  });
});

describe('conversation scoping', () => {
  const neg = (sql: string, channel?: string) => ({
    data: () => ({
      generatedSql: sql, explanation: `why ${sql}`, tablesUsed: ['t'],
      ...(channel === undefined ? {} : { channel }),
    }),
  });

  beforeEach(() => {
    vi.clearAllMocks();
    setupChain();
  });

  it('returns only the negative feedback of the requested conversation', async () => {
    mockGet.mockResolvedValue({ docs: [neg('SELECT two', 'C_TWO'), neg('SELECT one', 'C_ONE')] });
    expect((await getLatestNegativeFeedback('C_ONE', 'same.ts'))?.sql).toBe('SELECT one');
    expect((await getLatestNegativeFeedback('C_TWO', 'same.ts'))?.sql).toBe('SELECT two');
    expect(mockLimit).toHaveBeenCalledWith(20);
  });

  it('does not leak negative feedback from another conversation', async () => {
    mockGet.mockResolvedValue({ docs: [neg('SELECT two', 'C_TWO')] });
    expect(await getLatestNegativeFeedback('C_ONE', 'same.ts')).toBeNull();
  });

  it('never returns a legacy record without a channel', async () => {
    mockGet.mockResolvedValue({ docs: [neg('SELECT legacy')] });
    expect(await getLatestNegativeFeedback('C_ONE', 'same.ts')).toBeNull();
  });
});
