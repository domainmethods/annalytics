import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockUpdate = vi.fn();
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

  it('sets negativeFeedback on the ResponseContext document', async () => {
    mockUpdate.mockResolvedValue(undefined);

    await recordFeedback('thread-1', 'msg-1', 'negative');

    expect(mockDoc).toHaveBeenCalledWith('thread-1_msg-1');
    expect(mockUpdate).toHaveBeenCalledWith({ negativeFeedback: true });
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
          generatedSql: 'SELECT bad FROM table',
          explanation: 'Bad query',
          tablesUsed: ['table'],
        }),
      }],
    });

    const result = await getLatestNegativeFeedback('thread-1');

    expect(result).not.toBeNull();
    expect(result!.sql).toBe('SELECT bad FROM table');
    expect(result!.explanation).toBe('Bad query');
    expect(mockWhere).toHaveBeenCalledWith('threadTs', '==', 'thread-1');
    expect(mockWhere).toHaveBeenCalledWith('negativeFeedback', '==', true);
  });

  it('returns null when no negative feedback exists', async () => {
    mockGet.mockResolvedValue({ empty: true });

    const result = await getLatestNegativeFeedback('thread-1');

    expect(result).toBeNull();
  });

  it('returns null when negative feedback exists in a different thread', async () => {
    mockGet.mockResolvedValue({ empty: true });

    const result = await getLatestNegativeFeedback('thread-other');

    expect(result).toBeNull();
    expect(mockWhere).toHaveBeenCalledWith('threadTs', '==', 'thread-other');
  });
});
