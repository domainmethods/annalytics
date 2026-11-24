import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';

// ─── Hoisted mock state ──────────────────────────────────────────
// In-memory Firestore so the real dedup / lock / rate-limit / clarification
// / escalation state modules run their real logic against a controllable store.
const {
  mockGenerateContent,
  mockRunPipeline,
  mockClassifyFollowUp,
  mockRouteFollowUp,
  firestoreStore,
  firestoreQueryResults,
  loggerWarn,
  loggerInfo,
  mockDb,
} = vi.hoisted(() => {
  const mockGenerateContent = vi.fn();
  const mockRunPipeline = vi.fn(async () => {});
  const mockClassifyFollowUp = vi.fn();
  const mockRouteFollowUp = vi.fn();
  const firestoreStore = new Map<string, any>();
  const firestoreQueryResults = new Map<string, any>();
  const loggerWarn = vi.fn();
  const loggerInfo = vi.fn();

  function createDocRef(collectionName: string, docId: string) {
    const path = `${collectionName}/${docId}`;
    return {
      path,
      get: vi.fn(async () => ({
        exists: firestoreStore.has(path),
        data: () => firestoreStore.get(path),
      })),
      set: vi.fn(async (data: any) => {
        firestoreStore.set(path, data);
      }),
      delete: vi.fn(async () => {
        firestoreStore.delete(path);
      }),
      create: vi.fn(async (data: any) => {
        if (firestoreStore.has(path)) {
          const err: any = new Error('ALREADY_EXISTS');
          err.code = 6;
          throw err;
        }
        firestoreStore.set(path, data);
      }),
      update: vi.fn(async (patch: any) => {
        firestoreStore.set(path, { ...firestoreStore.get(path), ...patch });
      }),
      ref: { update: vi.fn(async () => {}) },
    };
  }

  let transactionQueue = Promise.resolve();
  const mockDb = {
    runTransaction: vi.fn((callback: (tx: any) => Promise<any>) => {
      const result = transactionQueue.then(() => callback({
        get: (ref: any) => ref.get(),
        set: (ref: any, data: any) => ref.set(data),
        update: (ref: any, data: any) => ref.update(data),
        delete: (ref: any) => ref.delete(),
      }));
      transactionQueue = result.then(() => undefined, () => undefined);
      return result;
    }),
    doc: vi.fn((path: string) => createDocRef(...(path.split('/') as [string, string]))),
    collection: vi.fn((name: string) => {
      const chain: any = {};
      chain.doc = vi.fn((id: string) => createDocRef(name, id));
      chain.where = vi.fn(() => chain);
      chain.orderBy = vi.fn(() => chain);
      chain.limit = vi.fn(() => chain);
      chain.select = vi.fn(() => chain);
      chain.get = vi.fn(async () =>
        firestoreQueryResults.get(name) || { empty: true, docs: [] },
      );
      return chain;
    }),
  };

  return {
    mockGenerateContent,
    mockRunPipeline,
    mockClassifyFollowUp,
    mockRouteFollowUp,
    firestoreStore,
    firestoreQueryResults,
    loggerWarn,
    loggerInfo,
    mockDb,
  };
});

// ─── External service mocks ──────────────────────────────────────
vi.mock('@google/genai', () => ({
  GoogleGenAI: vi.fn(function () {
    return { models: { generateContent: mockGenerateContent } };
  }),
}));

vi.mock('../../src/state/firestore.js', () => ({
  initFirestore: vi.fn(),
  getDb: vi.fn(() => mockDb),
  FieldValue: {
    serverTimestamp: vi.fn(() => new Date()),
    increment: vi.fn((n: number) => ({ __increment: n })),
  },
}));

vi.mock('../../src/logging.js', () => ({
  createTraceId: () => 'trace-msg',
  createLogger: () => ({ info: vi.fn(), warn: loggerWarn, error: vi.fn(), child: vi.fn() }),
  logStage: vi.fn(),
  rootLogger: { info: loggerInfo, warn: loggerWarn, error: vi.fn() },
}));

// Keep toPipelineConfig real (it's pure config conversion); spy only the
// pipeline entry point so tests can assert "did this message reach the
// analytics pipeline?" without queuing a full pipeline's worth of mocks.
vi.mock('../../src/pipeline.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/pipeline.js')>();
  return { ...actual, runPipeline: mockRunPipeline };
});

// Follow-up routing is exercised at the seam only: classification and the
// chosen route are spies so tests can fail either one independently.
vi.mock('../../src/agents/followUpClassifier.js', () => ({
  classifyFollowUp: mockClassifyFollowUp,
}));
vi.mock('../../src/handlers/followUpRouter.js', () => ({
  routeFollowUp: mockRouteFollowUp,
}));
// Harvesting a teaching candidate after an escalation resolves is a model call
// nobody waits for; hold it open so it can't write into a later test.
vi.mock('../../src/teachings/candidateGenerator.js', () => ({
  generateTeachingCandidate: vi.fn(() => new Promise(() => {})),
}));

// ─── Real imports (system under test + real collaborators) ───────
import { handleMessageEvent, registerMessageHandler } from '../../src/handlers/messageHandler.js';
import { checkClarificationReply } from '../../src/handlers/messages.js';
import { registerMentions } from '../../src/handlers/mentions.js';
import { registerCommands } from '../../src/handlers/commands.js';
import { promptRefinement } from '../../src/handlers/refinePrompt.js';
import type { AppConfig } from '../../src/config.js';
import type { TableContext } from '../../src/dbt/types.js';

// ─── Fixtures ────────────────────────────────────────────────────
const config = {
  gcp: { projectId: 'test-proj' },
  gemini: { apiKey: 'test-key', model: 'gemini-pro', fileSearchStoreId: 'stores/test' },
  limits: {
    rateLimitPerHour: 100,
    costGateMaxBytes: 10e9,
    queryTimeoutMs: 30000,
    maxResultRows: 1000,
  },
  answerShares: { enabled: false },
  escalation: { mode: 'channel', channelId: undefined, analystUserId: undefined, timeoutHours: 4 },
} as unknown as AppConfig;

const escalationConfig = {
  ...config,
  escalation: {
    ...config.escalation,
    mode: 'channel',
    channelId: 'C-ESCALATION',
  },
} as unknown as AppConfig;

const tables: TableContext[] = [];
const getTables = () => tables;
const STATUS_TEXT = 'Got it. Let me get things ready...';

function intakeResponse(route: 'immediate_response' | 'analytics_pipeline', responseText: string | null) {
  return { text: JSON.stringify({ route, responseText, reasoning: 'test' }) };
}

// A direct-message event (no thread_ts → fresh top-level DM).
function dmEvent(text: string, overrides: Record<string, unknown> = {}) {
  return {
    type: 'message',
    channel_type: 'im',
    channel: 'D123',
    user: 'U1',
    text,
    ts: '1700000000.000100',
    ...overrides,
  } as any;
}

function bodyWithEventId(eventId: string) {
  return { event_id: eventId };
}

// ─── Mock Slack client ───────────────────────────────────────────
const mockClient = {
  conversations: { replies: vi.fn() },
  chat: { postMessage: vi.fn(), update: vi.fn() },
} as any;

function statusPosts(): string[] {
  return mockClient.chat.postMessage.mock.calls.map((c: any[]) => c[0].text);
}

// The fake store keeps plain Dates where Firestore returns Timestamps, so a doc
// one delivery wrote is re-wrapped before the next delivery reads it.
function asTimestamps() {
  for (const [prefix, field] of [['processing_threads/', 'expiresAt'], ['rate_limits/', 'windowStart']]) {
    for (const [key, doc] of firestoreStore) {
      if (key.startsWith(prefix) && doc[field] instanceof Date) {
        const date = doc[field];
        firestoreStore.set(key, { ...doc, [field]: { toDate: () => date } });
      }
    }
  }
}

describe('handleMessageEvent — orchestration seam (integration)', () => {
  beforeAll(() => {
    // generateContent's default: route to the analytics pipeline. Individual
    // tests override with mockResolvedValueOnce for immediate responses.
    mockGenerateContent.mockResolvedValue(intakeResponse('analytics_pipeline', null));
  });

  beforeEach(() => {
    mockGenerateContent.mockReset();
    mockRunPipeline.mockReset();
    mockRunPipeline.mockResolvedValue(undefined);
    mockClassifyFollowUp.mockReset().mockResolvedValue({ intent: 'new_query', reasoning: 'test' });
    mockRouteFollowUp.mockReset().mockResolvedValue(undefined);
    firestoreStore.clear();
    firestoreQueryResults.clear();
    loggerWarn.mockReset();
    loggerInfo.mockReset();

    mockClient.conversations.replies.mockReset().mockResolvedValue({ messages: [] });
    mockClient.chat.postMessage.mockReset().mockResolvedValue({ ts: '1700000000.000200' });
    mockClient.chat.update.mockReset().mockResolvedValue({});
  });

  // ── Bug #1: greeting must get an immediate reply, never the pipeline ──
  // A greeting is now answered by the deterministic fast-path — no model call —
  // so it stays correct even when a cold, CPU-throttled container would starve
  // the Gemini round-trip (the original "hi → pipeline" failure mode).
  it('answers a DM greeting deterministically without a model call, status, or pipeline', async () => {
    // Model would route to the pipeline if reached — proving the fast-path wins.
    mockGenerateContent.mockResolvedValue(intakeResponse('analytics_pipeline', null));

    await handleMessageEvent({
      event: dmEvent('hi'),
      body: bodyWithEventId('Ev1'),
      client: mockClient,
      config,
      getTables,
    });

    // Exactly one post — the deterministic intake reply — and never the status placeholder.
    expect(mockClient.chat.postMessage).toHaveBeenCalledTimes(1);
    expect(statusPosts()[0]).toMatch(/data/i);
    expect(statusPosts()).not.toContain(STATUS_TEXT);
    expect(mockGenerateContent).not.toHaveBeenCalled();
    expect(mockRunPipeline).not.toHaveBeenCalled();

    // The thread lock must be released — intake handled the message.
    expect([...firestoreStore.keys()].some(k => k.startsWith('processing_threads/'))).toBe(false);
  });

  // ── Substantive question → pipeline ──
  it('routes a substantive DM question to the analytics pipeline with a status message', async () => {
    mockGenerateContent.mockResolvedValue(intakeResponse('analytics_pipeline', null));

    await handleMessageEvent({
      event: dmEvent('show leads last month by channel'),
      body: bodyWithEventId('Ev2'),
      client: mockClient,
      config,
      getTables,
    });

    expect(statusPosts()).toContain(STATUS_TEXT);
    expect(mockRunPipeline).toHaveBeenCalledTimes(1);
    expect(mockRunPipeline.mock.calls[0][0]).toMatchObject({
      question: 'show leads last month by channel',
      channel: 'D123',
    });
  });

  // ── Intake fail-open: an intake error must not strand the user ──
  // Uses ambiguous prose (not an obvious greeting) so the message actually
  // reaches the model — the deterministic fast-path would short-circuit "hi"
  // before any error could occur.
  it('falls through to the pipeline when intake errors (fail-open)', async () => {
    mockGenerateContent.mockRejectedValue(new Error('Gemini unavailable'));

    await handleMessageEvent({
      event: dmEvent('what can you do for me?'),
      body: bodyWithEventId('Ev3'),
      client: mockClient,
      config,
      getTables,
    });

    expect(statusPosts()).toContain(STATUS_TEXT);
    expect(mockRunPipeline).toHaveBeenCalledTimes(1);
  });

  // ── Bug: Slack retries the same event on a slow/cold ack ──
  it('processes a retried Slack event (same event_id) only once', async () => {
    mockGenerateContent.mockResolvedValue(intakeResponse('analytics_pipeline', null));

    const deliver = () =>
      handleMessageEvent({
        event: dmEvent('show revenue this quarter'),
        body: bodyWithEventId('EvRetry'),
        client: mockClient,
        config,
        getTables,
      });

    await deliver(); // first delivery
    await deliver(); // Slack retry of the identical event

    expect(mockRunPipeline).toHaveBeenCalledTimes(1);
    expect(statusPosts().filter(t => t === STATUS_TEXT)).toHaveLength(1);
  });

  // ── Slack retries can arrive concurrently before the first acks ──
  it('processes concurrent duplicate deliveries (retry race) only once', async () => {
    mockGenerateContent.mockResolvedValue(intakeResponse('analytics_pipeline', null));

    const deliver = () =>
      handleMessageEvent({
        event: dmEvent('show signups by week'),
        body: bodyWithEventId('EvRace'),
        client: mockClient,
        config,
        getTables,
      });

    await Promise.all([deliver(), deliver()]); // both in flight at once

    expect(mockRunPipeline).toHaveBeenCalledTimes(1);
    expect(statusPosts().filter(t => t === STATUS_TEXT)).toHaveLength(1);
  });

  // ── Rate limit blocks the pipeline with a user-visible message ──
  it('blocks at the rate limit with a message and no pipeline run', async () => {
    // Seed the user at the cap so the next message is refused.
    firestoreStore.set('rate_limits/U1', {
      queryCount: config.limits.rateLimitPerHour,
      windowStart: { toDate: () => new Date() },
    });
    mockGenerateContent.mockResolvedValue(intakeResponse('analytics_pipeline', null));

    await handleMessageEvent({
      event: dmEvent('show revenue'),
      body: bodyWithEventId('EvRate'),
      client: mockClient,
      config,
      getTables,
    });

    expect(mockRunPipeline).not.toHaveBeenCalled();
    expect(statusPosts().some(t => t.includes('query limit'))).toBe(true);
  });

  // ── A recognized clarification reply resumes the pipeline ──
  describe('clarification reply', () => {
    const THREAD_TS = '1700000000.000900';
    const CLARIFYING_TS = '1700000000.000800';
    const NEW_STATUS_TS = '1700000000.000200'; // what the mock postMessage returns

    // The lookup by thread is a query and the claim then reads the doc itself, so
    // a pending clarification is seeded in both. The query result stays put after
    // the doc is deleted, which is what a reply sees when its lookup ran just
    // before another reply took the clarification.
    const pendingClarification = (overrides: Record<string, unknown> = {}) => {
      const data = {
        clarificationId: 'clar-9',
        threadTs: THREAD_TS,
        channel: 'D123',
        originalQuestion: 'revenue?',
        clarifyingQuestions: ['Which period?', 'Gross or net?'],
        clarifyingMessageTs: CLARIFYING_TS,
        state: 'awaiting_reply',
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        ...overrides,
      };
      firestoreQueryResults.set('clarification_state', {
        empty: false,
        docs: [{ data: () => data, ref: { delete: vi.fn(async () => {}) } }],
      });
      firestoreStore.set('clarification_state/clar-9', data);
    };

    // A genuine thread reply (carries thread_ts) → checkClarificationReply claims it.
    const answer = () => handleMessageEvent({
      event: dmEvent('last quarter', { thread_ts: THREAD_TS, ts: '1700000000.000950' }),
      body: bodyWithEventId('EvClarReply'),
      client: mockClient,
      config,
      getTables,
    });

    it('resumes with the clarified question on a new status message below the reply', async () => {
      pendingClarification();

      await answer();

      expect(mockClient.chat.postMessage).toHaveBeenCalledWith({
        channel: 'D123',
        thread_ts: THREAD_TS,
        text: STATUS_TEXT,
      });
      expect(mockRunPipeline).toHaveBeenCalledTimes(1);
      expect(mockRunPipeline.mock.calls[0][0]).toMatchObject({
        question: 'revenue? (Clarification: last quarter)',
        originalQuestion: 'revenue? (Clarification: last quarter)',
        threadTs: THREAD_TS,
        statusMsgTs: NEW_STATUS_TS,
      });
    });

    it('leaves the clarifying questions in the thread, without their cancel button', async () => {
      pendingClarification();

      await answer();

      expect(mockClient.chat.update).toHaveBeenCalledTimes(1);
      const redraw = mockClient.chat.update.mock.calls[0][0];
      expect(redraw).toMatchObject({
        channel: 'D123',
        ts: CLARIFYING_TS,
        text: 'Which period?\nGross or net?',
      });
      const blocks = JSON.stringify(redraw.blocks);
      expect(blocks).toContain('Which period?');
      expect(blocks).toContain('Gross or net?');
      expect(blocks).not.toContain('clarification_cancel');
    });

    it('still resumes on the new status message when the clarifying message cannot be redrawn', async () => {
      pendingClarification();
      mockClient.chat.update.mockRejectedValue(new Error('ratelimited'));

      await answer();

      expect(mockRunPipeline).toHaveBeenCalledTimes(1);
      expect(mockRunPipeline.mock.calls[0][0]).toMatchObject({ statusMsgTs: NEW_STATUS_TS });
    });

    it('resumes on the clarifying message when a new status message cannot be posted', async () => {
      pendingClarification();
      mockClient.chat.postMessage.mockRejectedValue(new Error('ratelimited'));

      await answer();

      expect(mockRunPipeline).toHaveBeenCalledTimes(1);
      expect(mockRunPipeline.mock.calls[0][0]).toMatchObject({ statusMsgTs: CLARIFYING_TS });
      // The pipeline is about to write its status there; nothing to redraw.
      expect(mockClient.chat.update).not.toHaveBeenCalled();
    });

    it('resumes on the clarifying message for a clarification saved without its questions', async () => {
      // Saved before the questions were stored: it can't be redrawn without its button.
      pendingClarification({ clarifyingQuestions: undefined });

      await answer();

      expect(mockRunPipeline).toHaveBeenCalledTimes(1);
      expect(mockRunPipeline.mock.calls[0][0]).toMatchObject({ statusMsgTs: CLARIFYING_TS });
      expect(statusPosts()).not.toContain(STATUS_TEXT);
      expect(mockClient.chat.update).not.toHaveBeenCalled();
    });

    // ── The resumed run holds the thread lock like every other run ──
    const LOCK_PATH = `processing_threads/D123:${THREAD_TS}`;
    const STILL_WORKING_TEXT = "I'm still working on your previous question...";

    it('takes the thread lock for the resumed run and hands it to the pipeline to release', async () => {
      pendingClarification();

      await answer();

      const lock = firestoreStore.get(LOCK_PATH);
      expect(lock).toBeDefined();
      expect(mockRunPipeline.mock.calls[0][0].ownerToken).toBe(lock.ownerToken);
    });

    it('tells a second reply to wait while the resumed run is still working', async () => {
      pendingClarification();
      let finishRun!: () => void;
      mockRunPipeline.mockImplementationOnce(() => new Promise<void>((resolve) => { finishRun = resolve; }));

      const resumed = answer();
      await vi.waitFor(() => expect(mockRunPipeline).toHaveBeenCalledTimes(1));
      // The clarification is answered, so the next reply is an ordinary thread message.
      firestoreQueryResults.delete('clarification_state');
      // Firestore reads a stored Date back as a Timestamp; the in-memory store doesn't.
      const lock = firestoreStore.get(LOCK_PATH);
      if (lock) firestoreStore.set(LOCK_PATH, { ...lock, expiresAt: { toDate: () => lock.expiresAt } });

      await handleMessageEvent({
        event: dmEvent('and by region?', { thread_ts: THREAD_TS, ts: '1700000000.000960' }),
        body: bodyWithEventId('EvSecondReply'),
        client: mockClient,
        config,
        getTables,
      });
      finishRun();
      await resumed;

      expect(statusPosts()).toContain(STILL_WORKING_TEXT);
      expect(mockRunPipeline).toHaveBeenCalledTimes(1);
    });

    // ── The lock is taken before the answer is, so an answer is never consumed
    //    by a run that can't have the thread ──
    it('takes the thread lock before it takes the clarification', async () => {
      pendingClarification();
      const realTransaction = mockDb.runTransaction.getMockImplementation()!;
      const read: string[] = [];
      mockDb.runTransaction.mockImplementation((callback: (tx: any) => Promise<any>) =>
        realTransaction((tx: any) => callback({
          ...tx,
          get: (ref: any) => {
            read.push(ref.path.split('/')[0]);
            return tx.get(ref);
          },
        })));

      try {
        await answer();
      } finally {
        mockDb.runTransaction.mockImplementation(realTransaction);
      }

      expect(read.filter(c => c === 'processing_threads' || c === 'clarification_state'))
        .toEqual(['processing_threads', 'clarification_state']);
    });

    // Another run has the thread, and keeps it however far the clock moves.
    const heldByAnotherRun = () => firestoreStore.set(LOCK_PATH, {
      ownerToken: 'another-run',
      expiresAt: { toDate: () => new Date(Date.now() + 60_000) },
    });

    it('leaves the answer untaken and asks the user to wait when another run holds the thread', async () => {
      pendingClarification();
      heldByAnotherRun();

      await answer();

      expect(mockRunPipeline).not.toHaveBeenCalled();
      expect(statusPosts()).toEqual([STILL_WORKING_TEXT]);
      expect(mockClient.chat.postMessage).toHaveBeenCalledWith({
        channel: 'D123',
        thread_ts: THREAD_TS,
        text: STILL_WORKING_TEXT,
      });
      // Still pending, so the same answer works once the other run is done.
      expect(firestoreStore.has('clarification_state/clar-9')).toBe(true);
      expect(firestoreStore.get(LOCK_PATH).ownerToken).toBe('another-run');
    });

    it('does not count an answer it could not take against the rate limit', async () => {
      pendingClarification();
      heldByAnotherRun();

      await answer();

      expect(firestoreStore.has('rate_limits/U1')).toBe(false);
    });

    it('tells a user at the rate limit to wait, not that they are out of queries', async () => {
      pendingClarification();
      heldByAnotherRun();
      firestoreStore.set('rate_limits/U1', {
        queryCount: config.limits.rateLimitPerHour,
        windowStart: { toDate: () => new Date() },
      });

      await answer();

      expect(statusPosts()).toEqual([STILL_WORKING_TEXT]);
    });

    it('still asks the user to wait when the other run lets go of the thread a moment later', async () => {
      pendingClarification();
      heldByAnotherRun();
      const realTransaction = mockDb.runTransaction.getMockImplementation()!;
      // The other run finishes right after this reply found the thread taken.
      mockDb.runTransaction.mockImplementation(async (callback: (tx: any) => Promise<any>) => {
        let readLock = false;
        const result = await realTransaction((tx: any) => callback({
          ...tx,
          get: (ref: any) => {
            if (ref.path === LOCK_PATH) readLock = true;
            return tx.get(ref);
          },
        }));
        if (readLock) firestoreStore.delete(LOCK_PATH);
        return result;
      });

      try {
        await answer();
      } finally {
        mockDb.runTransaction.mockImplementation(realTransaction);
      }

      // Not "I'm still waiting on your answer": they just gave it.
      expect(statusPosts()).toEqual([STILL_WORKING_TEXT]);
      expect(mockRunPipeline).not.toHaveBeenCalled();
      expect(firestoreStore.has('clarification_state/clar-9')).toBe(true);
    });

    it('asks the user to wait once when Slack sends the same answer again a minute later', async () => {
      pendingClarification();
      heldByAnotherRun();
      vi.useFakeTimers({ toFake: ['Date'] });

      try {
        await answer();
        asTimestamps();
        vi.setSystemTime(Date.now() + 60_000);
        await answer();
      } finally {
        vi.useRealTimers();
      }

      expect(statusPosts()).toEqual([STILL_WORKING_TEXT]);
    });

    it('gives the thread lock back when another reply already took the clarification', async () => {
      // The lookup still shows the clarification, but its document is gone.
      pendingClarification();
      firestoreStore.delete('clarification_state/clar-9');

      await answer();

      expect(mockRunPipeline).not.toHaveBeenCalled();
      expect(statusPosts()).not.toContain(STILL_WORKING_TEXT);
      expect([...firestoreStore.keys()].some(k => k.startsWith('processing_threads/'))).toBe(false);
    });

    it('still resumes when the thread lock cannot be taken at all', async () => {
      pendingClarification();
      const realTransaction = mockDb.runTransaction.getMockImplementation()!;
      // Only the lock is unavailable; the clarification itself can still be taken.
      mockDb.runTransaction.mockImplementation((callback: (tx: any) => Promise<any>) =>
        realTransaction((tx: any) => callback({
          ...tx,
          get: (ref: any) => ref.path.startsWith('processing_threads/')
            ? Promise.reject(new Error('unavailable'))
            : tx.get(ref),
        })));

      try {
        await answer();
      } finally {
        mockDb.runTransaction.mockImplementation(realTransaction);
      }

      expect(mockRunPipeline).toHaveBeenCalledTimes(1);
      expect(mockRunPipeline.mock.calls[0][0].ownerToken).toBeUndefined();
    });

    // ── One reply answers a clarification ──
    it('lets only one of two simultaneous replies take the clarification', async () => {
      pendingClarification();
      const reply = (text: string) => checkClarificationReply({ channel: 'D123', thread_ts: THREAD_TS, text });

      const taken = await Promise.all([reply('last quarter'), reply('net')]);

      expect(taken.filter(Boolean)).toHaveLength(1);
    });

    it('resumes once when a second reply also finds the clarification', async () => {
      pendingClarification();
      let finishRun!: () => void;
      mockRunPipeline.mockImplementationOnce(() => new Promise<void>((resolve) => { finishRun = resolve; }));

      const resumed = answer();
      await vi.waitFor(() => expect(mockRunPipeline).toHaveBeenCalledTimes(1));
      // Firestore reads a stored Date back as a Timestamp; the in-memory store doesn't.
      const lock = firestoreStore.get(LOCK_PATH);
      if (lock) firestoreStore.set(LOCK_PATH, { ...lock, expiresAt: { toDate: () => lock.expiresAt } });

      // The lookup still shows this reply the clarification the first one took.
      await handleMessageEvent({
        event: dmEvent('net', { thread_ts: THREAD_TS, ts: '1700000000.000960' }),
        body: bodyWithEventId('EvSecondAnswer'),
        client: mockClient,
        config,
        getTables,
      });
      finishRun();
      await resumed;

      expect(mockRunPipeline).toHaveBeenCalledTimes(1);
      expect(statusPosts()).toContain(STILL_WORKING_TEXT);
    });
  });

  // ── Bug #4 (RED→GREEN): a pending clarification must never silently drop ──
  it('does not silently drop a DM while a clarification is pending', async () => {
    // A clarification is pending for this thread, but the incoming DM is a fresh
    // top-level message (no thread_ts) so checkClarificationReply does not claim
    // it. Guard 2 of preflightChecks then blocks the message — it must surface
    // *something* (a user-visible nudge and/or a structured log), never silence.
    firestoreQueryResults.set('clarification_state', {
      empty: false,
      docs: [{
        data: () => ({
          clarificationId: 'clar-1',
          threadTs: '1700000000.000100',
          channel: 'D123',
          originalQuestion: 'revenue?',
          clarifyingMessageTs: '1700000000.000050',
          state: 'awaiting_reply',
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        }),
        ref: { delete: vi.fn(async () => {}) },
      }],
    });
    // Intake would route this greeting to immediate_response, but preflight runs
    // first and blocks; assert on the blocking behavior.
    mockGenerateContent.mockResolvedValue(intakeResponse('analytics_pipeline', null));

    await handleMessageEvent({
      event: dmEvent('are you there?'),
      body: bodyWithEventId('Ev5'),
      client: mockClient,
      config,
      getTables,
    });

    // It must not just vanish: either a Slack message went out, or it was logged.
    const surfaced =
      mockClient.chat.postMessage.mock.calls.length > 0 ||
      loggerWarn.mock.calls.some(c => String(c[1] ?? '').includes('clarification'));
    expect(surfaced).toBe(true);
    // And it must not have leaked into the pipeline while a clarification is open.
    expect(mockRunPipeline).not.toHaveBeenCalled();
  });

  it('notifies both threads and skips the pipeline when an analyst reply arrives after timeout', async () => {
    firestoreStore.set('escalation_state/esc-late', { pipelineState: 'awaiting_human' });
    firestoreQueryResults.set('escalation_state', {
      empty: false,
      docs: [{
        data: () => ({
          escalationId: 'esc-late',
          originalThreadTs: '1700000000.000100',
          originalChannel: 'D123',
          pipelineState: 'awaiting_human',
          trigger: 'supervisor_exhausted',
          behavior: 'park_wait',
          stageToResume: 'sql_generation',
          context: {
            clarifiedQuestion: 'Show revenue',
            userQuestion: 'Show revenue',
            groundingCitations: [],
          },
          escalationChannel: 'C-ESCALATION',
          escalationTs: '1700000000.000900',
          statusMsgTs: '1700000000.000200',
          createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
          expiresAt: new Date(Date.now() - 1000),
          traceId: 'trace-late',
        }),
        ref: { update: vi.fn(async () => {}) },
      }],
    });

    await handleMessageEvent({
      event: {
        ...dmEvent('late guidance', {
          channel_type: 'channel',
          channel: 'C-ESCALATION',
          thread_ts: '1700000000.000900',
          ts: '1700000000.000950',
        }),
      },
      body: bodyWithEventId('EvLateEscalation'),
      client: mockClient,
      config: escalationConfig,
      getTables,
    });

    expect(mockClient.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'C-ESCALATION',
        thread_ts: '1700000000.000900',
        text: expect.stringContaining('timed out before your reply'),
      }),
    );
    expect(mockClient.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'D123',
        thread_ts: '1700000000.000100',
        text: expect.stringContaining("wasn't able to get an answer"),
      }),
    );
    expect(statusPosts()).not.toContain(STATUS_TEXT);
    expect(mockRunPipeline).not.toHaveBeenCalled();
  });

  // ── #48: a failed follow-up route must not fall through into SQL generation ──
  describe('follow-up routing failures (#48)', () => {
    const threadReply = () => dmEvent('how was that calculated?', {
      thread_ts: '1700000000.000100',
      ts: '1700000000.000150',
    });

    beforeEach(() => {
      mockGenerateContent.mockResolvedValue(intakeResponse('analytics_pipeline', null));
      mockClient.conversations.replies.mockResolvedValue({
        messages: [
          { user: 'U1', text: 'show revenue last month', ts: '1700000000.000100' },
          { bot_id: 'B1', text: 'Revenue last month was 42.', ts: '1700000000.000120' },
        ],
      });
    });

    it('reports a recoverable error and runs no pipeline when the explanation route fails', async () => {
      mockClassifyFollowUp.mockResolvedValue({ intent: 'meta_question', reasoning: 'test' });
      mockRouteFollowUp.mockRejectedValue(new Error('Firestore unavailable'));

      await handleMessageEvent({
        event: threadReply(),
        body: bodyWithEventId('EvMetaFail'),
        client: mockClient,
        config,
        getTables,
      });

      expect(mockRouteFollowUp).toHaveBeenCalledTimes(1);
      expect(mockRouteFollowUp.mock.calls[0][0]).toBe('meta_question');
      expect(mockRunPipeline).not.toHaveBeenCalled();
      const update = mockClient.chat.update.mock.calls.at(-1)?.[0];
      expect(update).toMatchObject({ channel: 'D123', ts: '1700000000.000200' });
      expect(update.text).toContain('trace-msg');
      expect(update.text).not.toContain('Firestore unavailable');
      expect([...firestoreStore.keys()].some(k => k.startsWith('processing_threads/'))).toBe(false);
    });

    it('still releases the lock and runs no pipeline when the error update also fails', async () => {
      mockClassifyFollowUp.mockResolvedValue({ intent: 'meta_question', reasoning: 'test' });
      mockRouteFollowUp.mockRejectedValue(new Error('Slack update failed'));
      mockClient.chat.update.mockRejectedValue(new Error('Slack down'));

      await handleMessageEvent({
        event: threadReply(),
        body: bodyWithEventId('EvMetaFailUpdate'),
        client: mockClient,
        config,
        getTables,
      });

      expect(mockRunPipeline).not.toHaveBeenCalled();
      expect([...firestoreStore.keys()].some(k => k.startsWith('processing_threads/'))).toBe(false);
    });

    it('falls back to the standard pipeline only when classification itself fails', async () => {
      mockClassifyFollowUp.mockRejectedValue(new Error('Gemini unavailable'));

      await handleMessageEvent({
        event: threadReply(),
        body: bodyWithEventId('EvClassifyFail'),
        client: mockClient,
        config,
        getTables,
      });

      expect(mockClassifyFollowUp).toHaveBeenCalledTimes(1);
      expect(mockRouteFollowUp).not.toHaveBeenCalled();
      expect(mockRunPipeline).toHaveBeenCalledTimes(1);
    });

    it('classifies the follow-up against the earlier exchange only, not against itself', async () => {
      // What Slack really returns by the time the thread is read: the follow-up
      // and the status message just posted for it are both already in the thread.
      mockClient.conversations.replies.mockResolvedValue({
        messages: [
          { user: 'U1', text: 'show revenue last month', ts: '1700000000.000100' },
          { bot_id: 'B1', text: 'Revenue last month was 42.', ts: '1700000000.000120' },
          { user: 'U1', text: 'how was that calculated?', ts: '1700000000.000150' },
          { bot_id: 'B1', text: STATUS_TEXT, ts: '1700000000.000200' },
        ],
      });

      await handleMessageEvent({
        event: threadReply(),
        body: bodyWithEventId('EvClassifyContext'),
        client: mockClient,
        config,
        getTables,
      });

      expect(mockClassifyFollowUp).toHaveBeenCalledTimes(1);
      expect(mockClassifyFollowUp.mock.calls[0][0]).toBe('how was that calculated?');
      expect(mockClassifyFollowUp.mock.calls[0][1]).toEqual([
        { role: 'user', content: 'show revenue last month' },
        { role: 'assistant', content: 'Revenue last month was 42.' },
      ]);
    });

    it('logs the intent the reply was routed on', async () => {
      mockClassifyFollowUp.mockResolvedValue({
        intent: 'meta_question',
        reasoning: 'Asks how the number was computed',
      });

      await handleMessageEvent({
        event: threadReply(),
        body: bodyWithEventId('EvClassifyLog'),
        client: mockClient,
        config,
        getTables,
      });

      expect(loggerInfo).toHaveBeenCalledWith(
        {
          intent: 'meta_question',
          reasoning: 'Asks how the number was computed',
          channel: 'D123',
          threadTs: '1700000000.000100',
        },
        'followup.classified',
      );
    });

    it('logs a classification that failed, so the fallback to the pipeline is visible', async () => {
      mockClassifyFollowUp.mockRejectedValue(new Error('Gemini unavailable'));

      await handleMessageEvent({
        event: threadReply(),
        body: bodyWithEventId('EvClassifyFailLog'),
        client: mockClient,
        config,
        getTables,
      });

      expect(loggerWarn).toHaveBeenCalledWith(
        { err: 'Gemini unavailable', channel: 'D123', threadTs: '1700000000.000100' },
        'followup.classify_failed',
      );
      expect(loggerInfo).not.toHaveBeenCalledWith(expect.anything(), 'followup.classified');
    });
  });

  describe('mention greeting then an unmentioned question (#53)', () => {
    it('treats the greeted thread as one the bot is in, so the question enters intake', async () => {
      let mentionHandler: any;
      const app = { event: vi.fn((_name: string, h: any) => { mentionHandler = h; }) } as any;
      registerMentions(app, () => config, getTables);

      await mentionHandler({
        event: { type: 'app_mention', text: '<@UBOT> hi', user: 'U1', channel: 'C-CHAN', ts: '1700000000.000100' },
        body: bodyWithEventId('EvMentionHi'),
        client: mockClient,
      });
      expect(mockClient.chat.postMessage).toHaveBeenCalledTimes(1);
      expect(mockRunPipeline).not.toHaveBeenCalled();
      // The greeting saved no answer, only the participation mark.
      expect([...firestoreStore.keys()].some(k => k.startsWith('response_context/'))).toBe(false);
      expect(firestoreStore.has('thread_participation/C-CHAN:1700000000.000100')).toBe(true);

      // The fake store's rate-limit doc holds a plain Date; clear it between users' messages.
      for (const key of [...firestoreStore.keys()]) if (key.startsWith('rate_limits/')) firestoreStore.delete(key);
      mockGenerateContent.mockResolvedValue(intakeResponse('analytics_pipeline', null));

      await handleMessageEvent({
        event: {
          type: 'message',
          channel_type: 'channel',
          channel: 'C-CHAN',
          user: 'U1',
          text: 'show leads last month by channel',
          ts: '1700000000.000300',
          thread_ts: '1700000000.000100',
        } as any,
        body: bodyWithEventId('EvUnmentioned'),
        client: mockClient,
        config,
        getTables,
      });

      expect(mockGenerateContent).toHaveBeenCalled(); // intake classified it
      expect(statusPosts()).toContain(STATUS_TEXT);
      expect(mockRunPipeline).toHaveBeenCalledTimes(1);
    });

    it('treats a /anna greeting as rooting a thread the bot is in (#53)', async () => {
      let commandHandler: any;
      const app = { command: vi.fn((_name: string, h: any) => { commandHandler = h; }) } as any;
      registerCommands(app, () => config, getTables);
      // Not a canned greeting, so the model's immediate reply is what posts.
      mockGenerateContent.mockResolvedValue(intakeResponse('immediate_response', 'Happy to help — ask me about a metric.'));

      await commandHandler({
        command: { channel_id: 'C-CHAN', user_id: 'U1', text: 'hey anna, what can you do' },
        ack: vi.fn(), respond: vi.fn(), client: mockClient,
      });
      expect(mockRunPipeline).not.toHaveBeenCalled();
      // The greeting posted top-level as 1700000000.000200, rooting a new thread.
      expect(firestoreStore.has('thread_participation/C-CHAN:1700000000.000200')).toBe(true);

      for (const key of [...firestoreStore.keys()]) if (key.startsWith('rate_limits/')) firestoreStore.delete(key);
      mockGenerateContent.mockResolvedValue(intakeResponse('analytics_pipeline', null));
      await handleMessageEvent({
        event: {
          type: 'message', channel_type: 'channel', channel: 'C-CHAN', user: 'U1',
          text: 'show leads last month by channel', ts: '1700000000.000300', thread_ts: '1700000000.000200',
        } as any,
        body: bodyWithEventId('EvCommandFollowUp'), client: mockClient, config, getTables,
      });
      expect(statusPosts()).toContain(STATUS_TEXT);
      expect(mockRunPipeline).toHaveBeenCalledTimes(1);
    });

    it('still ignores an unmentioned reply in a thread the bot never answered', async () => {
      await handleMessageEvent({
        event: {
          type: 'message',
          channel_type: 'channel',
          channel: 'C-CHAN',
          user: 'U1',
          text: 'show leads last month by channel',
          ts: '1700000000.000300',
          thread_ts: '1700000000.000100',
        } as any,
        body: bodyWithEventId('EvStranger'),
        client: mockClient,
        config,
        getTables,
      });

      expect(mockClient.chat.postMessage).not.toHaveBeenCalled();
      expect(mockRunPipeline).not.toHaveBeenCalled();
    });
  });

  // ── #51: a reply to a refine prompt refines the answer the user picked ──
  describe('refine prompt targets the selected answer (#51)', () => {
    const reply = (user: string, ts: string) => dmEvent('use net revenue instead', {
      user,
      thread_ts: '1700000000.000100',
      ts,
    });

    beforeEach(() => {
      mockGenerateContent.mockResolvedValue(intakeResponse('analytics_pipeline', null));
      mockClient.conversations.replies.mockResolvedValue({
        messages: [
          { user: 'U1', text: 'show revenue', ts: '1700000000.000100' },
          { bot_id: 'B1', text: 'Answer A', ts: '1700000000.000110' },
          { bot_id: 'B1', text: 'Answer B', ts: '1700000000.000130' },
        ],
      });
      mockClassifyFollowUp.mockResolvedValue({ intent: 'new_query', reasoning: 'test' });
    });

    it("routes the prompted user's next reply to the picked answer, once", async () => {
      await promptRefinement({
        channel: 'D123', threadTs: '1700000000.000100', statusMsgTs: '1700000000.000110', userId: 'U1', client: mockClient,
      });

      await handleMessageEvent({ event: reply('U1', '1700000000.000150'), body: bodyWithEventId('EvRefine1'), client: mockClient, config, getTables });
      expect(mockClassifyFollowUp).not.toHaveBeenCalled();
      expect(mockRouteFollowUp).toHaveBeenCalledTimes(1);
      expect(mockRouteFollowUp.mock.calls[0][0]).toBe('refinement');
      expect(mockRouteFollowUp.mock.calls[0][8]).toEqual({ refinementTargetKey: '1700000000.000100_1700000000.000110' });

      // The target is consumed: a later reply goes through normal classification.
      // (The fake store keeps rate-limit timestamps as Dates, which the real
      // limiter can't re-read; reset the window so the second message counts fresh.)
      for (const key of [...firestoreStore.keys()]) if (key.startsWith('rate_limits/')) firestoreStore.delete(key);
      await handleMessageEvent({ event: reply('U1', '1700000000.000160'), body: bodyWithEventId('EvRefine2'), client: mockClient, config, getTables });
      expect(mockClassifyFollowUp).toHaveBeenCalledTimes(1);
      expect(mockRouteFollowUp).toHaveBeenCalledTimes(1);
    });

    it('sends a short correction to the refinement, not an intake reply (#51)', async () => {
      await promptRefinement({
        channel: 'D123', threadTs: '1700000000.000100', statusMsgTs: '1700000000.000110', userId: 'U1', client: mockClient,
      });
      mockClient.chat.postMessage.mockClear();
      // Intake would answer "thanks" itself if it ran.
      await handleMessageEvent({
        event: dmEvent('thanks', { user: 'U1', thread_ts: '1700000000.000100', ts: '1700000000.000150' }),
        body: bodyWithEventId('EvRefineShort'), client: mockClient, config, getTables,
      });
      expect(mockGenerateContent).not.toHaveBeenCalled();
      expect(statusPosts()).toEqual([STATUS_TEXT]);
      expect(mockRouteFollowUp).toHaveBeenCalledTimes(1);
      expect(mockRouteFollowUp.mock.calls[0][0]).toBe('refinement');
      expect(firestoreStore.has('refinement_targets/D123:1700000000.000100_U1')).toBe(false);
    });

    it('says so, keeps the target, and runs nothing when the target cannot be read (#51)', async () => {
      await promptRefinement({
        channel: 'D123', threadTs: '1700000000.000100', statusMsgTs: '1700000000.000110', userId: 'U1', client: mockClient,
      });
      mockClient.chat.postMessage.mockClear();
      // Fail only the refine-target read; every other collection stays live.
      const realCollection = mockDb.collection.getMockImplementation()!;
      mockDb.collection.mockImplementation((name: string) => {
        const chain = realCollection(name);
        if (name !== 'refinement_targets') return chain;
        return { ...chain, doc: (id: string) => ({ ...chain.doc(id), get: async () => { throw new Error('firestore down'); } }) };
      });

      await handleMessageEvent({ event: reply('U1', '1700000000.000150'), body: bodyWithEventId('EvRefineReadFail'), client: mockClient, config, getTables });
      mockDb.collection.mockImplementation(realCollection);

      expect(statusPosts()).toEqual([expect.stringContaining("couldn't load the answer you picked")]);
      expect(mockGenerateContent).not.toHaveBeenCalled();
      expect(mockClassifyFollowUp).not.toHaveBeenCalled();
      expect(mockRouteFollowUp).not.toHaveBeenCalled();
      expect(firestoreStore.has('refinement_targets/D123:1700000000.000100_U1')).toBe(true);
    });

    it('keeps the target when the status post fails, so the retry refines the picked answer (#51)', async () => {
      await promptRefinement({
        channel: 'D123', threadTs: '1700000000.000100', statusMsgTs: '1700000000.000110', userId: 'U1', client: mockClient,
      });
      mockClient.chat.postMessage.mockRejectedValueOnce(new Error('slack down'));

      await expect(handleMessageEvent({
        event: reply('U1', '1700000000.000150'), body: bodyWithEventId('EvRefinePostFail'), client: mockClient, config, getTables,
      })).rejects.toThrow('slack down');
      expect(mockRouteFollowUp).not.toHaveBeenCalled();
      expect(firestoreStore.has('refinement_targets/D123:1700000000.000100_U1')).toBe(true);

      // Slack redelivers (the claim was released): same event, same picked answer.
      for (const key of [...firestoreStore.keys()]) if (key.startsWith('rate_limits/')) firestoreStore.delete(key);
      await handleMessageEvent({
        event: reply('U1', '1700000000.000150'), body: bodyWithEventId('EvRefinePostFail'), client: mockClient, config, getTables,
      });
      expect(mockClassifyFollowUp).not.toHaveBeenCalled();
      expect(mockRouteFollowUp).toHaveBeenCalledTimes(1);
      expect(mockRouteFollowUp.mock.calls[0][8]).toEqual({ refinementTargetKey: '1700000000.000100_1700000000.000110' });
      expect(firestoreStore.has('refinement_targets/D123:1700000000.000100_U1')).toBe(false);
    });

    it("does not apply one user's refine prompt to another user's reply", async () => {
      await promptRefinement({
        channel: 'D123', threadTs: '1700000000.000100', statusMsgTs: '1700000000.000110', userId: 'U1', client: mockClient,
      });
      await handleMessageEvent({ event: reply('U2', '1700000000.000150'), body: bodyWithEventId('EvRefineOther'), client: mockClient, config, getTables });
      expect(mockClassifyFollowUp).toHaveBeenCalledTimes(1);
      expect(mockRouteFollowUp).not.toHaveBeenCalled();
    });
  });

  // ── One listener owns a reply that @mentions the bot ──
  // In a channel thread the bot has replied in, a message that @mentions the bot
  // reaches the app twice: as a `message` event and as an `app_mention` event.
  // Each has its own event id, so event dedupe does not join them. The
  // `app_mention` listener owns such a reply; the `message` listener leaves it.
  describe('a reply that @mentions the bot', () => {
    const BOT = 'UBOT';
    const ROOT_TS = '1700000000.000100';
    const reply = {
      text: `<@${BOT}> show leads last month by channel`,
      user: 'U1', channel: 'C-CHAN', ts: '1700000000.000300', thread_ts: ROOT_TS,
    };
    const messageEvent = (overrides: Record<string, unknown> = {}) =>
      ({ type: 'message', channel_type: 'channel', ...reply, ...overrides }) as any;
    const deliverAsMessage = (eventId: string, overrides: Record<string, unknown> = {}) => handleMessageEvent({
      event: messageEvent(overrides),
      body: bodyWithEventId(eventId), client: mockClient, config, getTables, botUserId: BOT,
    });
    const registerMentionHandler = (cfg: AppConfig = config) => {
      let handler: any;
      registerMentions({ event: vi.fn((_name: string, h: any) => { handler = h; }) } as any, () => cfg, getTables);
      return (eventId: string, overrides: Record<string, unknown> = {}) => handler({
        event: { type: 'app_mention', ...reply, ...overrides }, body: bodyWithEventId(eventId), client: mockClient,
      });
    };
    const botIsInThread = () => firestoreStore.set(`thread_participation/C-CHAN:${ROOT_TS}`, {
      channel: 'C-CHAN', threadTs: ROOT_TS, expiresAt: new Date(Date.now() + 60_000),
    });
    // What Slack returns by the time the thread is read: the earlier messages,
    // then the reply being answered and the status message just posted for it.
    const threadWith = (earlier: Array<Record<string, unknown>>, replyText = reply.text) => ({
      messages: [
        ...earlier,
        { user: 'U1', text: replyText, ts: reply.ts },
        { bot_id: 'B1', text: STATUS_TEXT, ts: '1700000000.000200' },
      ],
    });

    beforeEach(() => {
      mockGenerateContent.mockResolvedValue(intakeResponse('analytics_pipeline', null));
    });

    it.each(['message', 'app_mention'])(
      'answers it once, with one rate-limit count and no "still working" notice (%s event first)',
      async (first) => {
        const deliverAsMention = registerMentionHandler();
        botIsInThread();
        const deliveries = [
          () => deliverAsMessage('EvReplyAsMessage'),
          () => deliverAsMention('EvReplyAsMention'),
        ];
        if (first === 'app_mention') deliveries.reverse();

        await deliveries[0]();
        // The first run still holds the thread when the second event arrives.
        asTimestamps();
        await deliveries[1]();

        expect(mockRunPipeline).toHaveBeenCalledTimes(1);
        expect(statusPosts().filter(t => /still working on your previous question/.test(t))).toEqual([]);
        expect(firestoreStore.get('rate_limits/U1').queryCount).toBe(1);
      },
    );

    it('takes a mentioned clarification answer once, without the mention and with no "waiting on your answer" notice', async () => {
      const deliverAsMention = registerMentionHandler();
      const pending = {
        clarificationId: 'clar-chan', threadTs: ROOT_TS, channel: 'C-CHAN', originalQuestion: 'revenue?',
        clarifyingQuestions: ['Which period?'], clarifyingMessageTs: '1700000000.000200',
        state: 'awaiting_reply', expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      };
      firestoreQueryResults.set('clarification_state', {
        empty: false, docs: [{ data: () => pending, ref: { delete: vi.fn(async () => {}) } }],
      });
      firestoreStore.set('clarification_state/clar-chan', pending);

      await deliverAsMention('EvAnswerAsMention', { text: `<@${BOT}> last quarter` });
      asTimestamps();
      await deliverAsMessage('EvAnswerAsMessage', { text: `<@${BOT}> last quarter` });

      expect(mockRunPipeline).toHaveBeenCalledTimes(1);
      expect(mockRunPipeline.mock.calls[0][0]).toMatchObject({
        question: 'revenue? (Clarification: last quarter)',
        channel: 'C-CHAN',
        threadTs: ROOT_TS,
      });
      expect(statusPosts().filter(t => /still waiting on your answer/.test(t))).toEqual([]);
    });

    it('routes a mentioned follow-up in a thread the bot has answered', async () => {
      const deliverAsMention = registerMentionHandler();
      botIsInThread();
      mockClient.conversations.replies.mockResolvedValue(threadWith([
        { user: 'U1', text: 'show revenue last month', ts: ROOT_TS },
        { bot_id: 'B1', text: 'Revenue last month was 42.', ts: '1700000000.000120' },
      ], `<@${BOT}> how was that calculated?`));
      mockClassifyFollowUp.mockResolvedValue({ intent: 'meta_question', reasoning: 'test' });

      await deliverAsMention('EvMentionFollowUp', { text: `<@${BOT}> how was that calculated?` });

      expect(mockClassifyFollowUp).toHaveBeenCalledTimes(1);
      expect(mockClassifyFollowUp.mock.calls[0][0]).toBe('how was that calculated?');
      expect(mockRouteFollowUp).toHaveBeenCalledTimes(1);
      expect(mockRouteFollowUp.mock.calls[0].slice(0, 4)).toEqual([
        'meta_question', 'how was that calculated?', ROOT_TS, 'C-CHAN',
      ]);
      expect(mockRunPipeline).not.toHaveBeenCalled();
    });

    it('sends a first mention in a thread the bot was not in straight to the pipeline', async () => {
      // Nothing of the bot's is in the thread yet, so no follow-up route has an
      // answer to work from, however the reply is worded.
      const deliverAsMention = registerMentionHandler();
      mockClient.conversations.replies.mockResolvedValue(threadWith([
        { user: 'U2', text: 'does anyone have the lead numbers?', ts: ROOT_TS },
      ]));
      mockClassifyFollowUp.mockResolvedValue({ intent: 'meta_question', reasoning: 'test' });

      await deliverAsMention('EvFirstMention');

      expect(mockClassifyFollowUp).not.toHaveBeenCalled();
      expect(mockRouteFollowUp).not.toHaveBeenCalled();
      expect(mockRunPipeline).toHaveBeenCalledTimes(1);
      expect(mockRunPipeline.mock.calls[0][0]).toMatchObject({
        question: 'show leads last month by channel',
        channel: 'C-CHAN',
        threadTs: ROOT_TS,
      });
      // The thread is marked from here on, so the next reply needs no mention.
      expect(firestoreStore.has(`thread_participation/C-CHAN:${ROOT_TS}`)).toBe(true);
    });

    it("passes on an analyst's mentioned reply in an escalation thread once, and starts no run there", async () => {
      const ESCALATION_TS = '1700000000.000900';
      const escalation = {
        escalationId: 'esc-open',
        originalThreadTs: '1700000000.000100',
        originalChannel: 'D123',
        pipelineState: 'awaiting_human',
        trigger: 'supervisor_exhausted',
        behavior: 'best_effort_verify',
        stageToResume: 'sql_generation',
        context: { clarifiedQuestion: 'Show revenue', userQuestion: 'Show revenue', groundingCitations: [] },
        escalationChannel: 'C-ESCALATION',
        escalationTs: ESCALATION_TS,
        statusMsgTs: '1700000000.000200',
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        traceId: 'trace-open',
      };
      firestoreStore.set('escalation_state/esc-open', escalation);
      firestoreQueryResults.set('escalation_state', {
        empty: false, docs: [{ data: () => escalation, ref: { update: vi.fn(async () => {}) } }],
      });
      const guidance = {
        text: `<@${BOT}> use net revenue`,
        user: 'U-ANALYST', channel: 'C-ESCALATION', ts: '1700000000.000950', thread_ts: ESCALATION_TS,
      };
      const deliverAsMention = registerMentionHandler(escalationConfig);

      await handleMessageEvent({
        event: messageEvent(guidance), body: bodyWithEventId('EvGuidanceAsMessage'),
        client: mockClient, config: escalationConfig, getTables, botUserId: BOT,
      });
      await deliverAsMention('EvGuidanceAsMention', guidance);

      expect(mockRunPipeline).not.toHaveBeenCalled();
      // One post in all: the guidance, in the thread of the person who asked.
      expect(statusPosts()).toEqual(['use net revenue']);
      expect(mockClient.chat.postMessage.mock.calls[0][0]).toMatchObject({
        channel: 'D123',
        thread_ts: '1700000000.000100',
      });
    });

    describe('on the message listener', () => {
      it.each(['channel', 'group'])('is left to the app_mention listener in a %s thread', async (channelType) => {
        botIsInThread();

        await deliverAsMessage('EvLeft', { channel_type: channelType });

        expect(mockClient.chat.postMessage).not.toHaveBeenCalled();
        expect(mockRunPipeline).not.toHaveBeenCalled();
        // The event is not claimed either: nothing here handled it.
        expect([...firestoreStore.keys()].some(k => k.startsWith('slack_event_dedupe/'))).toBe(false);
      });

      it('is left to the app_mention listener using the bot user id Bolt provides', async () => {
        let messageHandler: any;
        registerMessageHandler(
          { event: vi.fn((_name: string, h: any) => { messageHandler = h; }) } as any, () => config, getTables,
        );
        botIsInThread();

        await messageHandler({
          event: messageEvent(), body: bodyWithEventId('EvBoltContext'), client: mockClient, context: { botUserId: BOT },
        });

        expect(mockClient.chat.postMessage).not.toHaveBeenCalled();
        expect(mockRunPipeline).not.toHaveBeenCalled();
      });

      it('is still handled when the bot user id is not known', async () => {
        botIsInThread();

        await handleMessageEvent({
          event: messageEvent(), body: bodyWithEventId('EvNoBotId'), client: mockClient, config, getTables,
        });

        expect(mockRunPipeline).toHaveBeenCalledTimes(1);
      });

      it('is still handled when the reply mentions someone else', async () => {
        botIsInThread();

        await deliverAsMessage('EvOtherMention', { text: '<@UOTHER> show leads last month by channel' });

        expect(mockRunPipeline).toHaveBeenCalledTimes(1);
      });

      it.each(['im', 'mpim'])('is still handled in a direct conversation (%s)', async (channelType) => {
        await deliverAsMessage('EvDirect', { channel_type: channelType, channel: 'D123', thread_ts: undefined });

        expect(mockRunPipeline).toHaveBeenCalledTimes(1);
      });
    });
  });
});
