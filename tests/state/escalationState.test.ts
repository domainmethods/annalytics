import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  saveEscalationState,
  claimEscalation,
  getEscalationByThread,
  getEscalationByEscalationThread,
  escalationConversation,
  getEscalationById,
  resolveEscalation,
  updateReminderTime,
  hasPendingEscalation,
  getAllPendingEscalations,
  RESOLVING_GUARD_MS,
} from '../../src/state/escalationState.js';

let transactionState = 'awaiting_human';
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
    runTransaction: async (fn: any) => fn({
      get: async () => ({ exists: true, data: () => ({ pipelineState: transactionState }) }),
      update: (_ref: any, data: any) => { transactionState = data.pipelineState; mockUpdate(data); },
    }),
  })),
}));

describe('saveEscalationState', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    transactionState = 'awaiting_human';
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
    transactionState = 'awaiting_human';
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
            originalChannel: 'C123',
            pipelineState: 'awaiting_human',
            createdAt: { toDate: () => createdDate },
            expiresAt: { toDate: () => futureDate },
          }),
          ref: { delete: vi.fn() },
        }],
      }),
    });

    const result = await getEscalationByThread('C123', '1234.5678');

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

    const result = await getEscalationByThread('C123', 'nonexistent');

    expect(result).toBeNull();
  });

  it('treats a recently claimed resolution as pending so the thread stays guarded', async () => {
    const resolvingDoc = (claimedAt: Date) => ({
      get: vi.fn().mockResolvedValue({
        empty: false,
        docs: [{
          data: () => ({
            escalationId: 'esc-123',
            originalThreadTs: '1234.5678',
            originalChannel: 'C123',
            pipelineState: 'resolving',
            claimedAt,
            createdAt: new Date(),
            expiresAt: new Date(Date.now() + 60_000),
          }),
        }],
      }),
    });
    const empty = { get: vi.fn().mockResolvedValue({ empty: true, docs: [] }) };

    mockLimit.mockReturnValueOnce(empty).mockReturnValueOnce(resolvingDoc(new Date()));
    const fresh = await getEscalationByThread('C123', '1234.5678');
    expect(fresh?.status).toBe('pending');

    mockLimit.mockReturnValueOnce(empty).mockReturnValueOnce(resolvingDoc(new Date(Date.now() - RESOLVING_GUARD_MS - 1)));
    expect(await getEscalationByThread('C123', '1234.5678')).toBeNull();
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
            originalChannel: 'C123',
            pipelineState: 'awaiting_human',
            expiresAt: { toDate: () => pastDate },
          }),
          ref: { update: mockUpdateRef },
        }],
      }),
    });

    const result = await getEscalationByThread('C123', '1234.5678');

    expect(result).toMatchObject({
      status: 'expired_now',
      state: { escalationId: 'esc-expired' },
    });
    expect(mockUpdate).toHaveBeenCalledWith({ pipelineState: 'timed_out' });
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
              originalChannel: 'C123',
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

    const first = await getEscalationByThread('C123', '1234.5678');
    const second = await getEscalationByThread('C123', '1234.5678');

    expect(first?.status).toBe('expired_now');
    expect(second).toBeNull();
    expect(mockUpdate).toHaveBeenCalledTimes(1);
  });
});

describe('conversation scoping', () => {
  const doc = (escalationId: string, pipelineState: string, originalChannel?: string) => ({
    data: () => ({
      escalationId, originalThreadTs: 'same.ts', pipelineState,
      claimedAt: new Date(), createdAt: new Date(), expiresAt: new Date(Date.now() + 60_000),
      ...(originalChannel === undefined ? {} : { originalChannel }),
    }),
    ref: { update: vi.fn() },
  });
  const snap = (docs: unknown[]) => ({ get: vi.fn().mockResolvedValue({ empty: docs.length === 0, docs }) });

  beforeEach(() => {
    vi.clearAllMocks();
    transactionState = 'awaiting_human';
    mockWhere.mockReturnValue({ where: vi.fn().mockReturnValue({ limit: mockLimit }) });
  });

  it('awaiting_human: returns only the escalation of the requested conversation', async () => {
    const docs = [doc('esc-two', 'awaiting_human', 'C_TWO'), doc('esc-one', 'awaiting_human', 'C_ONE')];
    mockLimit.mockReturnValue(snap(docs));
    const one = await getEscalationByThread('C_ONE', 'same.ts');
    const two = await getEscalationByThread('C_TWO', 'same.ts');
    expect(one?.state.escalationId).toBe('esc-one');
    expect(two?.state.escalationId).toBe('esc-two');
    expect(mockLimit).toHaveBeenCalledWith(20);
  });

  it('awaiting_human: another conversation escalation is invisible and not expired/mutated', async () => {
    mockLimit.mockReturnValue(snap([doc('esc-two', 'awaiting_human', 'C_TWO')]));
    expect(await hasPendingEscalation('C_ONE', 'same.ts')).toBe(false);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('resolving: only the requested conversation is guarded', async () => {
    const resolving = () => snap([doc('esc-two', 'resolving', 'C_TWO')]);
    const empty = snap([]);
    mockLimit.mockReturnValueOnce(empty).mockReturnValueOnce(resolving());
    expect(await getEscalationByThread('C_ONE', 'same.ts')).toBeNull();

    mockLimit.mockReturnValueOnce(empty).mockReturnValueOnce(resolving());
    const other = await getEscalationByThread('C_TWO', 'same.ts');
    expect(other?.status).toBe('pending');
    expect(other?.state.escalationId).toBe('esc-two');
  });

  it('never returns a legacy record without originalChannel', async () => {
    mockLimit.mockReturnValueOnce(snap([doc('legacy', 'awaiting_human')]))
      .mockReturnValueOnce(snap([doc('legacy', 'resolving')]));
    expect(await getEscalationByThread('C_ONE', 'same.ts')).toBeNull();
  });
});

describe('getEscalationByEscalationThread', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    transactionState = 'awaiting_human';
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
            escalationChannel: 'C_ESC',
            pipelineState: 'awaiting_human',
            createdAt: { toDate: () => createdDate },
            expiresAt: { toDate: () => futureDate },
          }),
          ref: { delete: vi.fn() },
        }],
      }),
    });

    const result = await getEscalationByEscalationThread({ channel: 'C_ESC' }, '9999.0001');

    expect(result).not.toBeNull();
    expect(result!.status).toBe('pending');
    expect(result!.state.escalationId).toBe('esc-456');
    expect(result!.state.createdAt).toBeInstanceOf(Date);
    expect(result!.state.expiresAt).toBeInstanceOf(Date);
    expect(mockWhere).toHaveBeenCalledWith('escalationTs', '==', '9999.0001');
  });
});

describe('escalation card conversation scoping', () => {
  const card = (escalationId: string, escalationChannel?: string) => ({
    data: () => ({
      escalationId, escalationTs: 'same.ts', pipelineState: 'awaiting_human',
      createdAt: new Date(), expiresAt: new Date(Date.now() + 60_000),
      ...(escalationChannel === undefined ? {} : { escalationChannel }),
    }),
    ref: { update: vi.fn() },
  });
  const snap = (docs: unknown[]) => ({ get: vi.fn().mockResolvedValue({ empty: docs.length === 0, docs }) });

  beforeEach(() => {
    vi.clearAllMocks();
    transactionState = 'awaiting_human';
    mockWhere.mockReturnValue({ where: vi.fn().mockReturnValue({ limit: mockLimit }) });
  });

  it('does not return an escalation card from a different channel sharing the escalationTs', async () => {
    mockLimit.mockReturnValue(snap([card('esc-two', 'C_TWO')]));
    expect(await getEscalationByEscalationThread({ channel: 'C_ONE' }, 'same.ts')).toBeNull();
    const two = await getEscalationByEscalationThread({ channel: 'C_TWO' }, 'same.ts');
    expect(two?.state.escalationId).toBe('esc-two');
  });

  it('picks the card of the requested channel among several sharing the escalationTs', async () => {
    mockLimit.mockReturnValue(snap([card('esc-two', 'C_TWO'), card('esc-one', 'C_ONE')]));
    const one = await getEscalationByEscalationThread({ channel: 'C_ONE' }, 'same.ts');
    expect(one?.state.escalationId).toBe('esc-one');
  });

  it('DM mode: matches a card whose escalationChannel is the analyst user id via the DM event user', async () => {
    mockLimit.mockReturnValue(snap([card('esc-dm', 'U_ANALYST')]));
    const hit = await getEscalationByEscalationThread({ channel: 'D1', user: 'U_ANALYST' }, 'same.ts');
    expect(hit?.state.escalationId).toBe('esc-dm');
  });

  it('DM mode: a different analyst user id does not match', async () => {
    mockLimit.mockReturnValue(snap([card('esc-dm', 'U_ANALYST')]));
    expect(await getEscalationByEscalationThread({ channel: 'D2', user: 'U_OTHER' }, 'same.ts')).toBeNull();
  });

  it('never returns a legacy card without escalationChannel', async () => {
    mockLimit.mockReturnValue(snap([card('legacy')]));
    expect(await getEscalationByEscalationThread({ channel: 'C_ONE' }, 'same.ts')).toBeNull();
  });
});

describe('escalationConversation', () => {
  it('returns only the channel for a non-DM channel', () => {
    expect(escalationConversation('C1', 'U1')).toEqual({ channel: 'C1' });
  });

  it('includes the user id for a DM channel', () => {
    expect(escalationConversation('D1', 'U1')).toEqual({ channel: 'D1', user: 'U1' });
  });

  it('omits the user when none is given in a DM', () => {
    expect(escalationConversation('D1', undefined)).toEqual({ channel: 'D1' });
  });
});

describe('resolveEscalation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    transactionState = 'awaiting_human';
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
    transactionState = 'awaiting_human';
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
    transactionState = 'awaiting_human';
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
            originalChannel: 'C123',
            pipelineState: 'awaiting_human',
            expiresAt: { toDate: () => futureDate },
          }),
          ref: { delete: vi.fn() },
        }],
      }),
    });

    const result = await hasPendingEscalation('C123', '1234.5678');

    expect(result).toBe(true);
  });
});

describe('getEscalationById', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    transactionState = 'awaiting_human';
  });

  it('returns the mapped state for an existing doc regardless of pipelineState', async () => {
    mockGet.mockResolvedValue({
      exists: true,
      data: () => ({
        escalationId: 'esc_fb_tr1',
        originalThreadTs: '1718000000.000100',
        originalChannel: 'C0RIGIN',
        pipelineState: 'resolved',
        context: { feedbackUserId: 'U1' },
        createdAt: { toDate: () => new Date('2026-06-01T00:00:00Z') },
        expiresAt: { toDate: () => new Date('2026-06-01T04:00:00Z') },
      }),
    });

    const state = await getEscalationById('esc_fb_tr1');

    expect(mockDoc).toHaveBeenCalledWith('esc_fb_tr1');
    expect(state?.originalChannel).toBe('C0RIGIN');
    expect(state?.context.feedbackUserId).toBe('U1');
    expect(state?.createdAt).toBeInstanceOf(Date);
  });

  it('returns null when the doc does not exist', async () => {
    mockGet.mockResolvedValue({ exists: false });
    expect(await getEscalationById('esc_gone')).toBeNull();
  });
});

describe('claimEscalation', () => {
  it('claims once and writes no undefined values', async () => {
    transactionState = 'awaiting_human';
    mockUpdate.mockClear();
    expect(await claimEscalation('esc-claim')).toBe(true);
    expect(await claimEscalation('esc-claim')).toBe(false);
    expect(mockUpdate).toHaveBeenCalledExactlyOnceWith({
      pipelineState: 'resolving', claimedAt: expect.any(Date),
    });
  });

  it.each(['resolved', 'resolving', 'timed_out'])('does not claim %s', async status => {
    transactionState = status;
    mockUpdate.mockClear();
    expect(await claimEscalation('esc-claim')).toBe(false);
    expect(mockUpdate).not.toHaveBeenCalled();
  });
});

describe('getAllPendingEscalations', () => {
  // A query over `total` awaiting_human docs, paged by limit/startAfter like Firestore.
  function pagedQuery(total: number) {
    const docs = Array.from({ length: total }, (_, i) => ({
      id: `esc_${String(i).padStart(3, '0')}`,
      data: () => ({
        escalationId: `esc_${String(i).padStart(3, '0')}`,
        pipelineState: 'awaiting_human',
        createdAt: new Date(0),
        expiresAt: new Date(0),
      }),
    }));
    const pageFrom = (start: number) => ({
      limit: (n: number) => ({ get: async () => ({ docs: docs.slice(start, start + n) }) }),
    });
    return {
      ...pageFrom(0),
      startAfter: vi.fn((doc: { id: string }) => pageFrom(docs.findIndex(d => d.id === doc.id) + 1)),
    };
  }

  beforeEach(() => vi.clearAllMocks());

  it('returns escalations beyond the first page of 50 (#54)', async () => {
    const query = pagedQuery(51);
    mockWhere.mockReturnValue(query);

    const pending = await getAllPendingEscalations();

    expect(mockWhere).toHaveBeenCalledWith('pipelineState', '==', 'awaiting_human');
    expect(pending).toHaveLength(51);
    expect(pending.at(-1)!.escalationId).toBe('esc_050');
    expect(pending.at(-1)!.expiresAt).toBeInstanceOf(Date);
  });

  it('stops after a short page and handles an exact multiple of the page size', async () => {
    const query = pagedQuery(100);
    mockWhere.mockReturnValue(query);

    expect(await getAllPendingEscalations()).toHaveLength(100);
    expect(query.startAfter).toHaveBeenCalledTimes(2);
  });

  it('returns nothing when no escalation is pending', async () => {
    mockWhere.mockReturnValue(pagedQuery(0));
    expect(await getAllPendingEscalations()).toEqual([]);
  });
});
