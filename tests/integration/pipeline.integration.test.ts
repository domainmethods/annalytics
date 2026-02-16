import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// ─── Hoisted mock state ──────────────────────────────────────────
const {
  mockGenerateContent,
  mockCreateQueryJob,
  firestoreStore,
  firestoreQueryResults,
  mockDb,
} = vi.hoisted(() => {
  const mockGenerateContent = vi.fn();
  const mockCreateQueryJob = vi.fn();
  const firestoreStore = new Map<string, any>();
  const firestoreQueryResults = new Map<string, any>();

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
      ref: { update: vi.fn(async () => {}) },
    };
  }

  const mockDb = {
    doc: vi.fn((path: string) => ({
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
    })),
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
    mockCreateQueryJob,
    firestoreStore,
    firestoreQueryResults,
    mockDb,
  };
});

// ─── External service mocks (only these 3 + logging) ────────────
vi.mock('@google/genai', () => ({
  GoogleGenAI: vi.fn(function () {
    return { models: { generateContent: mockGenerateContent } };
  }),
}));

vi.mock('@google-cloud/bigquery', () => ({
  BigQuery: vi.fn(function () {
    return { createQueryJob: mockCreateQueryJob };
  }),
}));

vi.mock('../../src/state/firestore.js', () => ({
  initFirestore: vi.fn(),
  getDb: vi.fn(() => mockDb),
  FieldValue: { serverTimestamp: vi.fn(() => new Date()) },
}));

vi.mock('../../src/logging.js', () => ({
  createTraceId: () => 'trace-integration',
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  }),
  logStage: vi.fn(),
}));

// ─── Real imports (everything else is real) ──────────────────────
import { runPipeline, type PipelineConfig } from '../../src/pipeline.js';
import { parseDbtArtifacts } from '../../src/dbt/parser.js';
import { initBigQuery } from '../../src/validation/dryRun.js';
import { initBigQueryClient } from '../../src/execution/runner.js';
import { _resetCache } from '../../src/teachings/summaryMap.js';

// ─── Parse real dbt fixtures ─────────────────────────────────────
const manifest = JSON.parse(
  readFileSync(join(process.cwd(), 'tests/fixtures/manifest.json'), 'utf-8'),
);
const catalog = JSON.parse(
  readFileSync(join(process.cwd(), 'tests/fixtures/catalog.json'), 'utf-8'),
);
const tables = parseDbtArtifacts(manifest, catalog);

// ─── Helpers ─────────────────────────────────────────────────────
const VALID_SQL =
  'SELECT COUNT(*) as order_count FROM `analytics.fct_orders`';

function geminiResponse(
  data: Record<string, unknown>,
  groundingChunks: any[] = [],
) {
  return {
    text: JSON.stringify(data),
    candidates: [{ groundingMetadata: { groundingChunks } }],
  };
}

function clarificationResponse(overrides: Record<string, unknown> = {}) {
  return geminiResponse({
    route: 'data_query',
    confidence: 'high',
    reasoning: 'Clear question',
    ambiguities: [],
    assumptions: [],
    clarifying_questions: [],
    resolved_question: 'How many orders are there?',
    ...overrides,
  });
}

function sqlGenResponse(
  overrides: Record<string, unknown> = {},
  groundingChunks: any[] = [],
) {
  return geminiResponse(
    {
      sql: VALID_SQL,
      explanation: 'Counts all orders',
      tables_used: ['analytics.fct_orders'],
      confidence: 'high',
      assumptions: [],
      reasoning_chain: 'Simple count query',
      ...overrides,
    },
    groundingChunks,
  );
}

function supervisorResponse(overrides: Record<string, unknown> = {}) {
  return geminiResponse({
    verdict: 'PASS',
    confidence: 'high',
    issues: [],
    suggestions: [],
    teaching_compliance: 'no_relevant_teaching',
    ...overrides,
  });
}

function dryRunResult(bytesProcessed = 5000) {
  return [
    { metadata: { statistics: { totalBytesProcessed: String(bytesProcessed) } } },
  ];
}

function executionResult(
  rows: Record<string, unknown>[],
  totalRows?: number,
) {
  return [
    {
      getQueryResults: vi.fn().mockResolvedValue([rows]),
      getMetadata: vi.fn().mockResolvedValue([
        {
          statistics: {
            query: { totalRows: String(totalRows ?? rows.length) },
            totalBytesProcessed: '5000',
          },
        },
      ]),
    },
  ];
}

// ─── Mock Slack client ───────────────────────────────────────────
const mockClient = {
  conversations: { replies: vi.fn() },
  chat: { update: vi.fn(), postMessage: vi.fn() },
};

const config: PipelineConfig = {
  geminiApiKey: 'test-key',
  fileSearchStoreId: 'stores/test',
  maxBytesProcessed: 10e9,
  queryTimeoutMs: 30000,
  maxResultRows: 1000,
};

const makeInput = () => ({
  question: 'How many orders do we have?',
  channel: 'C123',
  threadTs: 'thread-1',
  statusMsgTs: 'status-1',
  client: mockClient as any,
  tables,
  config,
});

// ─── Test suite ──────────────────────────────────────────────────
describe('Pipeline — Integration', () => {
  beforeAll(() => {
    // Initialize BigQuery clients with mocked constructor
    initBigQuery();
    initBigQueryClient();
  });

  beforeEach(() => {
    mockGenerateContent.mockReset();
    mockCreateQueryJob.mockReset();
    firestoreStore.clear();
    firestoreQueryResults.clear();
    _resetCache();

    mockClient.conversations.replies.mockReset();
    mockClient.chat.update.mockReset();
    mockClient.chat.postMessage.mockReset();

    mockClient.conversations.replies.mockResolvedValue({ messages: [] });
    mockClient.chat.update.mockResolvedValue({});
    mockClient.chat.postMessage.mockResolvedValue({});
  });

  it('happy path: HIGH confidence end-to-end', async () => {
    // Gemini: clarification(HIGH) → sqlGen → supervisor(PASS)
    mockGenerateContent
      .mockResolvedValueOnce(clarificationResponse())
      .mockResolvedValueOnce(sqlGenResponse())
      .mockResolvedValueOnce(supervisorResponse());

    // BigQuery: dry run → execution
    mockCreateQueryJob
      .mockResolvedValueOnce(dryRunResult())
      .mockResolvedValueOnce(executionResult([{ order_count: 42 }]));

    await runPipeline(makeInput());

    // 3 Gemini calls: clarification, SQL gen, supervisor
    expect(mockGenerateContent).toHaveBeenCalledTimes(3);
    // 2 BigQuery calls: dry run, execution
    expect(mockCreateQueryJob).toHaveBeenCalledTimes(2);

    // Final Slack update contains blocks with the result
    const updateCalls = mockClient.chat.update.mock.calls;
    const finalUpdate = updateCalls[updateCalls.length - 1][0];
    expect(finalUpdate.blocks).toBeDefined();
    expect(finalUpdate.blocks.length).toBeGreaterThan(0);

    // ResponseContext was persisted
    const savedKeys = [...firestoreStore.keys()].filter(k =>
      k.startsWith('response_context/'),
    );
    expect(savedKeys.length).toBe(1);
    const savedCtx = firestoreStore.get(savedKeys[0]);
    expect(savedCtx.confidence).toBe('high');
    expect(savedCtx.generatedSql).toBe(VALID_SQL);
    expect(savedCtx.supervisorVerdict).toBe('pass');
    expect(savedCtx.traceId).toBe('trace-integration');
  });

  it('MEDIUM confidence: includes assumptions + refine button', async () => {
    mockGenerateContent
      .mockResolvedValueOnce(
        clarificationResponse({
          confidence: 'medium',
          assumptions: ['Assuming all-time revenue', 'Assuming all regions'],
        }),
      )
      .mockResolvedValueOnce(sqlGenResponse())
      .mockResolvedValueOnce(supervisorResponse());

    mockCreateQueryJob
      .mockResolvedValueOnce(dryRunResult())
      .mockResolvedValueOnce(executionResult([{ order_count: 42 }]));

    await runPipeline(makeInput());

    // Should still proceed through full pipeline
    expect(mockGenerateContent).toHaveBeenCalledTimes(3);
    expect(mockCreateQueryJob).toHaveBeenCalledTimes(2);

    // Final response includes assumptions and refine button
    const updateCalls = mockClient.chat.update.mock.calls;
    const finalUpdate = updateCalls[updateCalls.length - 1][0];
    const blocksJson = JSON.stringify(finalUpdate.blocks);
    expect(blocksJson).toContain('Assumptions');
    expect(blocksJson).toContain('all-time revenue');
    expect(blocksJson).toContain('refine_assumptions');
  });

  it('LOW confidence: suspends pipeline, posts clarification questions', async () => {
    mockGenerateContent.mockResolvedValueOnce(
      clarificationResponse({
        confidence: 'low',
        clarifying_questions: ['Which time period?', 'Which product line?'],
        ambiguities: ['Time period unclear', 'Product scope unclear'],
      }),
    );

    await runPipeline(makeInput());

    // Only 1 Gemini call (clarification — no SQL gen or supervisor)
    expect(mockGenerateContent).toHaveBeenCalledTimes(1);
    // No BigQuery calls
    expect(mockCreateQueryJob).not.toHaveBeenCalled();

    // Clarification state was saved
    const clarificationKeys = [...firestoreStore.keys()].filter(k =>
      k.startsWith('clarification_state/'),
    );
    expect(clarificationKeys.length).toBe(1);
    const savedState = firestoreStore.get(clarificationKeys[0]);
    expect(savedState.state).toBe('awaiting_reply');
    expect(savedState.originalQuestion).toBe('How many orders do we have?');
    expect(savedState.ambiguities).toEqual([
      'Time period unclear',
      'Product scope unclear',
    ]);

    // Slack was updated with clarification blocks
    const updateCalls = mockClient.chat.update.mock.calls;
    const finalUpdate = updateCalls[updateCalls.length - 1][0];
    expect(finalUpdate.blocks).toBeDefined();
    const blocksJson = JSON.stringify(finalUpdate.blocks);
    expect(blocksJson).toContain('Which time period?');
    expect(blocksJson).toContain('Which product line?');

    // No ResponseContext saved (pipeline suspended)
    const responseKeys = [...firestoreStore.keys()].filter(k =>
      k.startsWith('response_context/'),
    );
    expect(responseKeys.length).toBe(0);
  });

  it('supervisor retry: FAIL then PASS on second attempt', async () => {
    mockGenerateContent
      .mockResolvedValueOnce(clarificationResponse())
      // 1st SQL gen attempt
      .mockResolvedValueOnce(sqlGenResponse())
      // Supervisor FAIL
      .mockResolvedValueOnce(
        supervisorResponse({
          verdict: 'FAIL',
          issues: ['Missing date filter'],
          suggestions: ['Add WHERE clause for order_date'],
        }),
      )
      // 2nd SQL gen attempt (retry with feedback)
      .mockResolvedValueOnce(sqlGenResponse())
      // Supervisor PASS
      .mockResolvedValueOnce(supervisorResponse());

    mockCreateQueryJob
      .mockResolvedValueOnce(dryRunResult())
      .mockResolvedValueOnce(executionResult([{ order_count: 15 }]));

    await runPipeline(makeInput());

    // 5 Gemini calls: clarify + gen1 + supervisor(FAIL) + gen2 + supervisor(PASS)
    expect(mockGenerateContent).toHaveBeenCalledTimes(5);
    // 2 BigQuery calls (runs only after final supervisor approval)
    expect(mockCreateQueryJob).toHaveBeenCalledTimes(2);

    // ResponseContext saved with fail_then_pass verdict
    const savedKeys = [...firestoreStore.keys()].filter(k =>
      k.startsWith('response_context/'),
    );
    expect(savedKeys.length).toBe(1);
    const savedCtx = firestoreStore.get(savedKeys[0]);
    expect(savedCtx.supervisorVerdict).toBe('fail_then_pass');
  });

  it('supervisor exhausted with park_wait: suspends pipeline, saves escalation state', async () => {
    const escalationConfig: PipelineConfig = {
      ...config,
      escalation: {
        mode: 'channel',
        channelId: 'C-ESCALATION',
        analystUserId: 'U-ANALYST',
        timeoutHours: 4,
      },
    };

    // clarification(HIGH) → gen1(low) → sup(FAIL) → gen2(low) → sup(FAIL) → gen3(low) → sup(FAIL)
    mockGenerateContent
      .mockResolvedValueOnce(clarificationResponse())
      .mockResolvedValueOnce(sqlGenResponse({ confidence: 'low' }))
      .mockResolvedValueOnce(supervisorResponse({ verdict: 'FAIL', issues: ['Bad query'] }))
      .mockResolvedValueOnce(sqlGenResponse({ confidence: 'low' }))
      .mockResolvedValueOnce(supervisorResponse({ verdict: 'FAIL', issues: ['Still bad'] }))
      .mockResolvedValueOnce(sqlGenResponse({ confidence: 'low' }))
      .mockResolvedValueOnce(supervisorResponse({ verdict: 'FAIL', issues: ['Exhausted'] }));

    mockClient.chat.postMessage.mockResolvedValue({ ts: 'esc-msg-ts' });

    await runPipeline({ ...makeInput(), config: escalationConfig });

    // 7 Gemini calls (clarify + 3 gen + 3 supervisor)
    expect(mockGenerateContent).toHaveBeenCalledTimes(7);
    // No BigQuery calls — pipeline suspended before validation
    expect(mockCreateQueryJob).not.toHaveBeenCalled();

    // Escalation state saved
    const escKeys = [...firestoreStore.keys()].filter(k => k.startsWith('escalation_state/'));
    expect(escKeys.length).toBe(1);
    const escState = firestoreStore.get(escKeys[0]);
    expect(escState.pipelineState).toBe('awaiting_human');
    expect(escState.behavior).toBe('park_wait');

    // User message updated with waiting text
    const updateCalls = mockClient.chat.update.mock.calls;
    const waitingUpdate = updateCalls.find((c: any) => c[0].text?.includes('data team'));
    expect(waitingUpdate).toBeDefined();

    // Escalation posted to escalation channel
    const postCalls = mockClient.chat.postMessage.mock.calls;
    const escalationPost = postCalls.find((c: any) => c[0].channel === 'C-ESCALATION');
    expect(escalationPost).toBeDefined();

    // No ResponseContext saved (pipeline suspended)
    const responseKeys = [...firestoreStore.keys()].filter(k => k.startsWith('response_context/'));
    expect(responseKeys.length).toBe(0);
  });

  it('supervisor exhausted with best_effort_verify: executes with caveat, saves escalation', async () => {
    const escalationConfig: PipelineConfig = {
      ...config,
      escalation: {
        mode: 'channel',
        channelId: 'C-ESCALATION',
        analystUserId: 'U-ANALYST',
        timeoutHours: 4,
      },
    };

    // clarification(HIGH) → gen1(medium) → sup(FAIL) → gen2(medium) → sup(FAIL) → gen3(medium) → sup(FAIL)
    mockGenerateContent
      .mockResolvedValueOnce(clarificationResponse())
      .mockResolvedValueOnce(sqlGenResponse({ confidence: 'medium' }))
      .mockResolvedValueOnce(supervisorResponse({ verdict: 'FAIL', issues: ['Uncertain'] }))
      .mockResolvedValueOnce(sqlGenResponse({ confidence: 'medium' }))
      .mockResolvedValueOnce(supervisorResponse({ verdict: 'FAIL', issues: ['Still uncertain'] }))
      .mockResolvedValueOnce(sqlGenResponse({ confidence: 'medium' }))
      .mockResolvedValueOnce(supervisorResponse({ verdict: 'FAIL', issues: ['Exhausted'] }));

    // BigQuery: dry run → execution
    mockCreateQueryJob
      .mockResolvedValueOnce(dryRunResult())
      .mockResolvedValueOnce(executionResult([{ order_count: 42 }]));

    mockClient.chat.postMessage.mockResolvedValue({ ts: 'esc-msg-ts' });

    await runPipeline({ ...makeInput(), config: escalationConfig });

    // 7 Gemini calls (clarify + 3 gen + 3 supervisor)
    expect(mockGenerateContent).toHaveBeenCalledTimes(7);
    // 2 BigQuery calls — pipeline continues to execution
    expect(mockCreateQueryJob).toHaveBeenCalledTimes(2);

    // Response shown with caveat
    const updateCalls = mockClient.chat.update.mock.calls;
    const finalUpdate = updateCalls[updateCalls.length - 1][0];
    expect(finalUpdate.blocks).toBeDefined();
    const blocksJson = JSON.stringify(finalUpdate.blocks);
    expect(blocksJson).toContain('not fully confident');

    // Escalation state saved
    const escKeys = [...firestoreStore.keys()].filter(k => k.startsWith('escalation_state/'));
    expect(escKeys.length).toBe(1);
    const escState = firestoreStore.get(escKeys[0]);
    expect(escState.pipelineState).toBe('awaiting_human');
    expect(escState.behavior).toBe('best_effort_verify');

    // ResponseContext was also saved (pipeline completed)
    const responseKeys = [...firestoreStore.keys()].filter(k => k.startsWith('response_context/'));
    expect(responseKeys.length).toBe(1);

    // Escalation posted to escalation channel
    const postCalls = mockClient.chat.postMessage.mock.calls;
    const escalationPost = postCalls.find((c: any) => c[0].channel === 'C-ESCALATION');
    expect(escalationPost).toBeDefined();
  });

  it('negative feedback injection: thread with thumbs-down feeds into generation', async () => {
    // Pre-populate Firestore with negative feedback for this thread
    firestoreQueryResults.set('response_context', {
      empty: false,
      docs: [
        {
          data: () => ({
            generatedSql: 'SELECT bad_column FROM `analytics.fct_orders`',
            explanation: 'Wrong approach to counting orders',
            tablesUsed: ['analytics.fct_orders'],
          }),
        },
      ],
    });

    mockGenerateContent
      .mockResolvedValueOnce(clarificationResponse())
      .mockResolvedValueOnce(sqlGenResponse())
      .mockResolvedValueOnce(supervisorResponse());

    mockCreateQueryJob
      .mockResolvedValueOnce(dryRunResult())
      .mockResolvedValueOnce(executionResult([{ order_count: 42 }]));

    await runPipeline(makeInput());

    // Completes normally
    expect(mockGenerateContent).toHaveBeenCalledTimes(3);

    // SQL generation call (2nd Gemini call) has negative example in system prompt
    const sqlGenCallArg = mockGenerateContent.mock.calls[1][0];
    const systemInstruction = sqlGenCallArg.config.systemInstruction;
    expect(systemInstruction).toContain('PREVIOUS ATTEMPT');
    expect(systemInstruction).toContain('SELECT bad_column');
    expect(systemInstruction).toContain('Do NOT repeat');
  });
});
