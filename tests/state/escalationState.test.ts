import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  saveEscalationState,
  getEscalationByThread,
  getEscalationByEscalationThread,
  resolveEscalation,
  updateReminderTime,
  hasPendingEscalation,
} from '../../src/state/escalationState.js';

const mockSet = vi.fn();
const mockUpdate = vi.fn();
const mockDelete = vi.fn();
const mockGet = vi.fn();
const mockDoc = vi.fn(() => ({ set: mockSet, update: mockUpdate, delete: mockDelete, get: mockGet }));
const mockWhere = vi.fn();
const mockLimit = vi.fn();
const mockCollection = vi.fn(() => ({ doc: mockDoc, where: mockWhere }));

vi.mock('../../src/state/firestore.js', () => ({
  getDb: vi.fn(() => ({
    collection: mockCollection,
  })),
}));

describe('saveEscalationState', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSet.mockResolvedValue(undefined);
  });

  it('writes to Firestore with correct fields and computed TTL', async () => {
    await saveEscalationState({
      escalationId: 'esc-123',
      originalThreadTs: '1234.5678',
      originalChannel: 'C123',
      trigger: 'supervisor_exhausted',
      behavior: 'park_wait',
      stageToResume: 'sql_generation',
      context: {
        clarifiedQuestion: 'What is revenue?',
        userQuestion: 'Show me revenue',
        groundingCitations: [],
      },
      escalationChannel: 'C-ESCALATION',
      escalationTs: '9999.0001',
      statusMsgTs: '1234.5680',
      traceId: 'trace-abc',
    }, 4);

    expect(mockCollection).toHaveBeenCalledWith('escalation_state');
    expect(mockDoc).toHaveBeenCalledWith('esc-123');
    expect(mockSet).toHaveBeenCalledWith(
      expect.objectContaining({
        escalationId: 'esc-123',
        originalThreadTs: '1234.5678',
        pipelineState: 'awaiting_human',
        behavior: 'park_wait',
        createdAt: expect.any(Date),
        expiresAt: expect.any(Date),
        retainUntil: expect.any(Date),
      }),
    );

    const savedData = mockSet.mock.calls[0][0];
    const expectedTtlMs = 4 * 60 * 60 * 1000;
    const actualDiff = savedData.expiresAt.getTime() - savedData.createdAt.getTime();
    expect(actualDiff).toBe(expectedTtlMs);

    const expectedRetainMs = 90 * 24 * 60 * 60 * 1000;
    const retainDiff = savedData.retainUntil.getTime() - savedData.createdAt.getTime();
    expect(retainDiff).toBe(expectedRetainMs);
  });
});

describe('getEscalationByThread', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWhere.mockReturnValue({ where: vi.fn().mockReturnValue({ limit: mockLimit }) });
  });

  it('retrieves pending escalation by originalThreadTs with Date conversion', async () => {
    const futureDate = new Date(Date.now() + 4 * 60 * 60 * 1000);
    const createdDate = new Date(Date.now() - 1000);
    mockLimit.mockReturnValue({
      get: vi.fn().mockResolvedValue({
        empty: false,
        docs: [{
          data: () => ({
            escalationId: 'esc-123',
            originalThreadTs: '1234.5678',
            pipelineState: 'awaiting_human',
            createdAt: { toDate: () => createdDate },
            expiresAt: { toDate: () => futureDate },
          }),
          ref: { delete: vi.fn() },
        }],
      }),
    });

    const result = await getEscalationByThread('1234.5678');

    expect(result).not.toBeNull();
    expect(result!.status).toBe('pending');
    expect(result!.state.escalationId).toBe('esc-123');
    expect(result!.state.createdAt).toBeInstanceOf(Date);
    expect(result!.state.expiresAt).toBeInstanceOf(Date);
    expect(result!.state.createdAt.getTime()).toBe(createdDate.getTime());
    expect(mockWhere).toHaveBeenCalledWith('originalThreadTs', '==', '1234.5678');
  });

  it('returns null when no pending escalation exists', async () => {
    mockLimit.mockReturnValue({
      get: vi.fn().mockResolvedValue({ empty: true, docs: [] }),
    });

    const result = await getEscalationByThread('nonexistent');

    expect(result).toBeNull();
  });

  it('returns expired_now and marks expired escalation as timed_out', async () => {
    const pastDate = new Date(Date.now() - 1000);
    const mockUpdateRef = vi.fn().mockResolvedValue(undefined);
    mockLimit.mockReturnValue({
      get: vi.fn().mockResolvedValue({
        empty: false,
        docs: [{
          data: () => ({
            escalationId: 'esc-expired',
            pipelineState: 'awaiting_human',
            expiresAt: { toDate: () => pastDate },
          }),
          ref: { update: mockUpdateRef },
        }],
      }),
    });

    const result = await getEscalationByThread('1234.5678');

    expect(result).toMatchObject({
      status: 'expired_now',
      state: { escalationId: 'esc-expired' },
    });
    expect(mockUpdateRef).toHaveBeenCalledWith({ pipelineState: 'timed_out' });
  });

  it('returns null on a subsequent lookup after the lazy timeout flip', async () => {
    const pastDate = new Date(Date.now() - 1000);
    const mockUpdateRef = vi.fn().mockResolvedValue(undefined);
    mockLimit
      .mockReturnValueOnce({
        get: vi.fn().mockResolvedValue({
          empty: false,
          docs: [{
            data: () => ({
              escalationId: 'esc-expired',
              pipelineState: 'awaiting_human',
              expiresAt: { toDate: () => pastDate },
            }),
            ref: { update: mockUpdateRef },
          }],
        }),
      })
      .mockReturnValueOnce({
        get: vi.fn().mockResolvedValue({ empty: true, docs: [] }),
      });

    const first = await getEscalationByThread('1234.5678');
    const second = await getEscalationByThread('1234.5678');

    expect(first?.status).toBe('expired_now');
    expect(second).toBeNull();
    expect(mockUpdateRef).toHaveBeenCalledTimes(1);
  });
});

describe('getEscalationByEscalationThread', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWhere.mockReturnValue({ where: vi.fn().mockReturnValue({ limit: mockLimit }) });
  });

  it('retrieves pending escalation by escalationTs with Date conversion', async () => {
    const futureDate = new Date(Date.now() + 4 * 60 * 60 * 1000);
    const createdDate = new Date(Date.now() - 1000);
    mockLimit.mockReturnValue({
      get: vi.fn().mockResolvedValue({
        empty: false,
        docs: [{
          data: () => ({
            escalationId: 'esc-456',
            escalationTs: '9999.0001',
            pipelineState: 'awaiting_human',
            createdAt: { toDate: () => createdDate },
            expiresAt: { toDate: () => futureDate },
          }),
          ref: { delete: vi.fn() },
        }],
      }),
    });

    const result = await getEscalationByEscalationThread('9999.0001');

    expect(result).not.toBeNull();
    expect(result!.status).toBe('pending');
    expect(result!.state.escalationId).toBe('esc-456');
    expect(result!.state.createdAt).toBeInstanceOf(Date);
    expect(result!.state.expiresAt).toBeInstanceOf(Date);
    expect(mockWhere).toHaveBeenCalledWith('escalationTs', '==', '9999.0001');
  });
});

describe('resolveEscalation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdate.mockResolvedValue(undefined);
  });

  it('updates pipelineState to resolved', async () => {
    await resolveEscalation('esc-123');

    expect(mockCollection).toHaveBeenCalledWith('escalation_state');
    expect(mockDoc).toHaveBeenCalledWith('esc-123');
    expect(mockUpdate).toHaveBeenCalledWith({ pipelineState: 'resolved' });
  });
});

describe('updateReminderTime', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdate.mockResolvedValue(undefined);
  });

  it('updates lastReminderAt to current time', async () => {
    await updateReminderTime('esc-123');

    expect(mockCollection).toHaveBeenCalledWith('escalation_state');
    expect(mockDoc).toHaveBeenCalledWith('esc-123');
    expect(mockUpdate).toHaveBeenCalledWith({
      lastReminderAt: expect.any(Date),
    });
  });
});

describe('hasPendingEscalation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWhere.mockReturnValue({ where: vi.fn().mockReturnValue({ limit: mockLimit }) });
  });

  it('returns true for non-expired pending escalation', async () => {
    const futureDate = new Date(Date.now() + 4 * 60 * 60 * 1000);
    mockLimit.mockReturnValue({
      get: vi.fn().mockResolvedValue({
        empty: false,
        docs: [{
          data: () => ({
            escalationId: 'esc-123',
            pipelineState: 'awaiting_human',
            expiresAt: { toDate: () => futureDate },
          }),
          ref: { delete: vi.fn() },
        }],
      }),
    });

    const result = await hasPendingEscalation('1234.5678');

    expect(result).toBe(true);
  });
});
