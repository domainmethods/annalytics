import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  saveClarificationState,
  getClarificationState,
  deleteClarificationState,
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
            channel: 'C123',
            state: 'awaiting_reply',
            expiresAt: { toDate: () => futureDate },
          }),
          ref: { delete: vi.fn() },
        }],
      }),
    });

    const result = await getClarificationState('C123', '1234.5678');

    expect(result).not.toBeNull();
    expect(result!.clarificationId).toBe('clarify-123');
    expect(mockWhere).toHaveBeenCalledWith('threadTs', '==', '1234.5678');
  });

  it('returns null for non-existent threadTs', async () => {
    mockLimit.mockReturnValue({
      get: vi.fn().mockResolvedValue({ empty: true, docs: [] }),
    });

    const result = await getClarificationState('C123', 'nonexistent');

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
            channel: 'C123',
            state: 'awaiting_reply',
            expiresAt: { toDate: () => pastDate },
          }),
          ref: { delete: mockDeleteRef },
        }],
      }),
    });

    const result = await getClarificationState('C123', '1234.5678');

    expect(result).toBeNull();
    expect(mockDeleteRef).toHaveBeenCalled();
  });
});

describe('conversation scoping', () => {
  const future = () => ({ toDate: () => new Date(Date.now() + 60 * 60 * 1000) });
  const doc = (clarificationId: string, channel?: string) => ({
    data: () => ({
      clarificationId, threadTs: 'same.ts', state: 'awaiting_reply', expiresAt: future(),
      ...(channel === undefined ? {} : { channel }),
    }),
    ref: { delete: vi.fn() },
  });
  const returnDocs = (docs: unknown[]) => {
    mockLimit.mockReturnValue({ get: vi.fn().mockResolvedValue({ empty: docs.length === 0, docs }) });
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockWhere.mockReturnValue({ where: vi.fn().mockReturnValue({ limit: mockLimit }) });
  });

  it('scans a bounded number of candidates', async () => {
    returnDocs([]);
    await getClarificationState('C_ONE', 'same.ts');
    expect(mockLimit).toHaveBeenCalledWith(20);
  });

  it('returns only the state belonging to the requested conversation', async () => {
    returnDocs([doc('clar-two', 'C_TWO'), doc('clar-one', 'C_ONE')]);
    expect((await getClarificationState('C_ONE', 'same.ts'))?.clarificationId).toBe('clar-one');
    expect((await getClarificationState('C_TWO', 'same.ts'))?.clarificationId).toBe('clar-two');
  });

  it('does not see another conversation state for the same thread ts', async () => {
    returnDocs([doc('clar-two', 'C_TWO')]);
    expect(await getClarificationState('C_ONE', 'same.ts')).toBeNull();
  });

  it('never returns a legacy record without a channel', async () => {
    returnDocs([doc('legacy')]);
    expect(await getClarificationState('C_ONE', 'same.ts')).toBeNull();
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
