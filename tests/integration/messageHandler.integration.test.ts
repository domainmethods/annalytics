import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';

// ─── Hoisted mock state ──────────────────────────────────────────
// In-memory Firestore so the real dedup / lock / rate-limit / clarification
// / escalation state modules run their real logic against a controllable store.
const {
  mockGenerateContent,
  mockRunPipeline,
  firestoreStore,
  firestoreQueryResults,
  loggerWarn,
  mockDb,
} = vi.hoisted(() => {
  const mockGenerateContent = vi.fn();
  const mockRunPipeline = vi.fn(async () => {});
  const firestoreStore = new Map<string, any>();
  const firestoreQueryResults = new Map<string, any>();
  const loggerWarn = vi.fn();

  function createDocRef(collectionName: string, docId: string) {
    const path = `${collectionName}/${docId}`;
    return {
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

  const mockDb = {
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
    firestoreStore,
    firestoreQueryResults,
    loggerWarn,
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
  rootLogger: { info: vi.fn(), warn: loggerWarn, error: vi.fn() },
}));

// Keep toPipelineConfig real (it's pure config conversion); spy only the
// pipeline entry point so tests can assert "did this message reach the
// analytics pipeline?" without queuing a full pipeline's worth of mocks.
vi.mock('../../src/pipeline.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/pipeline.js')>();
  return { ...actual, runPipeline: mockRunPipeline };
});

// ─── Real imports (system under test + real collaborators) ───────
import { handleMessageEvent } from '../../src/handlers/messageHandler.js';
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
  escalation: { mode: 'channel', channelId: undefined, analystUserId: undefined, timeoutHours: 4 },
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
    firestoreStore.clear();
    firestoreQueryResults.clear();
    loggerWarn.mockReset();

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
  it('resumes the pipeline with the clarified question when a thread reply answers a clarification', async () => {
    firestoreQueryResults.set('clarification_state', {
      empty: false,
      docs: [{
        data: () => ({
          clarificationId: 'clar-9',
          threadTs: '1700000000.000900',
          channel: 'D123',
          originalQuestion: 'revenue?',
          clarifyingMessageTs: '1700000000.000800',
          state: 'awaiting_reply',
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        }),
        ref: { delete: vi.fn(async () => {}) },
      }],
    });

    await handleMessageEvent({
      // A genuine thread reply (carries thread_ts) → checkClarificationReply claims it.
      event: dmEvent('last quarter', { thread_ts: '1700000000.000900', ts: '1700000000.000950' }),
      body: bodyWithEventId('EvClarReply'),
      client: mockClient,
      config,
      getTables,
    });

    expect(mockRunPipeline).toHaveBeenCalledTimes(1);
    expect(mockRunPipeline.mock.calls[0][0]).toMatchObject({
      question: 'revenue? (Clarification: last quarter)',
      threadTs: '1700000000.000900',
      statusMsgTs: '1700000000.000800',
    });
    // No new status message — it resumes on the existing clarifying message.
    expect(statusPosts()).not.toContain(STATUS_TEXT);
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
});
