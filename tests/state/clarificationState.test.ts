import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  saveClarificationState,
  getClarificationState,
  deleteClarificationState,
  hasPendingClarification,
} from '../../src/state/clarificationState.js';

const mockSet = vi.fn();
const mockDelete = vi.fn();
const _mockGet = vi.fn();
const mockDoc = vi.fn(() => ({ set: mockSet, delete: mockDelete }));
const mockWhere = vi.fn();
const mockLimit = vi.fn();
const mockCollection = vi.fn(() => ({ doc: mockDoc, where: mockWhere }));

vi.mock('../../src/state/firestore.js', () => ({
  getDb: vi.fn(() => ({
    collection: mockCollection,
  })),
}));

describe('saveClarificationState', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSet.mockResolvedValue(undefined);
  });

  it('writes to Firestore with correct fields', async () => {
    await saveClarificationState({
      clarificationId: 'clarify-123',
      threadTs: '1234.5678',
      channel: 'C123',
      originalQuestion: 'Show me revenue',
      ambiguities: ['revenue type unclear'],
      clarifyingMessageTs: '1234.5679',
    });

    expect(mockCollection).toHaveBeenCalledWith('clarification_state');
    expect(mockDoc).toHaveBeenCalledWith('clarify-123');
    expect(mockSet).toHaveBeenCalledWith(
      expect.objectContaining({
        clarificationId: 'clarify-123',
        threadTs: '1234.5678',
        state: 'awaiting_reply',
        createdAt: expect.any(Date),
        expiresAt: expect.any(Date),
      }),
    );
  });
});

describe('getClarificationState', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWhere.mockReturnValue({ where: vi.fn().mockReturnValue({ limit: mockLimit }) });
  });

  it('retrieves state by threadTs', async () => {
    const futureDate = new Date(Date.now() + 60 * 60 * 1000);
    mockLimit.mockReturnValue({
      get: vi.fn().mockResolvedValue({
        empty: false,
        docs: [{
          data: () => ({
            clarificationId: 'clarify-123',
            threadTs: '1234.5678',
            state: 'awaiting_reply',
            expiresAt: { toDate: () => futureDate },
          }),
          ref: { delete: vi.fn() },
        }],
      }),
    });

    const result = await getClarificationState('1234.5678');

    expect(result).not.toBeNull();
    expect(result!.clarificationId).toBe('clarify-123');
    expect(mockWhere).toHaveBeenCalledWith('threadTs', '==', '1234.5678');
  });

  it('returns null for non-existent threadTs', async () => {
    mockLimit.mockReturnValue({
      get: vi.fn().mockResolvedValue({ empty: true, docs: [] }),
    });

    const result = await getClarificationState('nonexistent');

    expect(result).toBeNull();
  });

  it('returns null for expired state', async () => {
    const pastDate = new Date(Date.now() - 1000);
    const mockDeleteRef = vi.fn().mockResolvedValue(undefined);
    mockLimit.mockReturnValue({
      get: vi.fn().mockResolvedValue({
        empty: false,
        docs: [{
          data: () => ({
            clarificationId: 'clarify-expired',
            state: 'awaiting_reply',
            expiresAt: { toDate: () => pastDate },
          }),
          ref: { delete: mockDeleteRef },
        }],
      }),
    });

    const result = await getClarificationState('1234.5678');

    expect(result).toBeNull();
    expect(mockDeleteRef).toHaveBeenCalled();
  });
});

describe('deleteClarificationState', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDelete.mockResolvedValue(undefined);
  });

  it('removes the document', async () => {
    await deleteClarificationState('clarify-123');

    expect(mockCollection).toHaveBeenCalledWith('clarification_state');
    expect(mockDoc).toHaveBeenCalledWith('clarify-123');
    expect(mockDelete).toHaveBeenCalled();
  });
});

describe('hasPendingClarification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWhere.mockReturnValue({ where: vi.fn().mockReturnValue({ limit: mockLimit }) });
  });

  it('returns true only for non-expired state', async () => {
    const futureDate = new Date(Date.now() + 60 * 60 * 1000);
    mockLimit.mockReturnValue({
      get: vi.fn().mockResolvedValue({
        empty: false,
        docs: [{
          data: () => ({
            clarificationId: 'clarify-123',
            state: 'awaiting_reply',
            expiresAt: { toDate: () => futureDate },
          }),
          ref: { delete: vi.fn() },
        }],
      }),
    });

    const result = await hasPendingClarification('1234.5678');

    expect(result).toBe(true);
  });
});
