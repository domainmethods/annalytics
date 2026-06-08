import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSet = vi.fn();
const mockGet = vi.fn();
const mockUpdate = vi.fn();
const mockWhere = vi.fn();
const mockOrderBy = vi.fn();
const mockDoc = vi.fn(() => ({ set: mockSet, get: mockGet, update: mockUpdate }));
const mockCollection = vi.fn(() => ({
  doc: mockDoc,
  where: mockWhere,
  orderBy: mockOrderBy,
}));

vi.mock('../../src/state/firestore.js', () => ({
  getDb: vi.fn(() => ({
    collection: mockCollection,
  })),
}));

import {
  saveFeedbackNote,
  getPendingFeedbackNotes,
  markFeedbackNoteReviewed,
} from '../../src/state/feedbackNotes.js';

describe('saveFeedbackNote', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSet.mockResolvedValue(undefined);
  });

  it('writes the note to feedback_notes', async () => {
    await saveFeedbackNote({
      note: 'wrong table',
      userId: 'U1',
      threadTs: 'T1',
      channel: 'C1',
      traceId: 'tr1',
      clarifiedQuestion: 'q?',
    });
    expect(mockCollection).toHaveBeenCalledWith('feedback_notes');
    expect(mockSet).toHaveBeenCalledWith(
      expect.objectContaining({ note: 'wrong table', userId: 'U1', threadTs: 'T1' }),
    );
  });

  it('uses traceId as the doc id when present', async () => {
    await saveFeedbackNote({
      note: 'n',
      userId: 'U1',
      threadTs: 'T1',
      channel: 'C1',
      traceId: 'tr1',
    });
    expect(mockDoc).toHaveBeenCalledWith('tr1');
  });

  it('falls back to threadTs_userId when traceId is absent', async () => {
    await saveFeedbackNote({
      note: 'n',
      userId: 'U1',
      threadTs: 'T1',
      channel: 'C1',
    });
    expect(mockDoc).toHaveBeenCalledWith('T1_U1');
  });

  it('stamps a createdAt on the written doc', async () => {
    await saveFeedbackNote({
      note: 'n',
      userId: 'U1',
      threadTs: 'T1',
      channel: 'C1',
    });
    expect(mockSet).toHaveBeenCalledWith(
      expect.objectContaining({ createdAt: expect.any(Date) }),
    );
  });

  it('stamps status=pending so the note is discoverable by the reviewer', async () => {
    await saveFeedbackNote({
      note: 'n',
      userId: 'U1',
      threadTs: 'T1',
      channel: 'C1',
    });
    expect(mockSet).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'pending' }),
    );
  });
});

describe('getPendingFeedbackNotes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns only pending notes ordered by createdAt DESC, with the doc id', async () => {
    const date1 = new Date('2026-06-01T10:00:00Z');
    const date2 = new Date('2026-06-01T11:00:00Z');

    mockWhere.mockReturnValue({ orderBy: mockOrderBy });
    mockOrderBy.mockReturnValue({
      get: vi.fn().mockResolvedValue({
        empty: false,
        docs: [
          {
            id: 'tr2',
            data: () => ({
              note: 'used the wrong date column',
              userId: 'U2',
              threadTs: 'T2',
              channel: 'C2',
              status: 'pending',
              traceId: 'tr2',
              createdAt: { toDate: () => date2 },
            }),
          },
          {
            id: 'T1_U1',
            data: () => ({
              note: 'answer double-counted refunds',
              userId: 'U1',
              threadTs: 'T1',
              channel: 'C1',
              status: 'pending',
              createdAt: { toDate: () => date1 },
            }),
          },
        ],
      }),
    });

    const results = await getPendingFeedbackNotes();

    expect(mockCollection).toHaveBeenCalledWith('feedback_notes');
    expect(mockWhere).toHaveBeenCalledWith('status', '==', 'pending');
    expect(mockOrderBy).toHaveBeenCalledWith('createdAt', 'desc');
    expect(results).toHaveLength(2);
    expect(results[0].id).toBe('tr2');
    expect(results[0].note).toBe('used the wrong date column');
    expect(results[0].userId).toBe('U2');
    expect(results[0].createdAt).toBeInstanceOf(Date);
    expect(results[0].createdAt.getTime()).toBe(date2.getTime());
    // Doc without a traceId still carries its composite doc id back.
    expect(results[1].id).toBe('T1_U1');
    expect(results[1].traceId).toBeUndefined();
  });

  it('returns empty array when no pending notes exist', async () => {
    mockWhere.mockReturnValue({ orderBy: mockOrderBy });
    mockOrderBy.mockReturnValue({
      get: vi.fn().mockResolvedValue({ empty: true, docs: [] }),
    });

    const results = await getPendingFeedbackNotes();

    expect(results).toEqual([]);
  });
});

describe('markFeedbackNoteReviewed', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdate.mockResolvedValue(undefined);
  });

  it('flips the status field of a note document to reviewed', async () => {
    await markFeedbackNoteReviewed('tr1');

    expect(mockCollection).toHaveBeenCalledWith('feedback_notes');
    expect(mockDoc).toHaveBeenCalledWith('tr1');
    expect(mockUpdate).toHaveBeenCalledWith({ status: 'reviewed' });
  });
});
