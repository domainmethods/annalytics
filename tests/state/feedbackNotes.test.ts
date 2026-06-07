import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSet = vi.fn();
const mockDoc = vi.fn().mockReturnValue({ set: mockSet });
const mockCollection = vi.fn().mockReturnValue({ doc: mockDoc });

vi.mock('../../src/state/firestore.js', () => ({
  getDb: () => ({
    collection: mockCollection,
  }),
}));

import { saveFeedbackNote } from '../../src/state/feedbackNotes.js';

describe('saveFeedbackNote', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDoc.mockReturnValue({ set: mockSet });
    mockCollection.mockReturnValue({ doc: mockDoc });
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
});
