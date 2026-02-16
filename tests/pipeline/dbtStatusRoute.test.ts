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
  mockHandleDbtStatus,
  mockGetRunHistoryForModel,
  mockGetLatestRun,
} = vi.hoisted(() => {
  const mockGenerateContent = vi.fn();
  const mockCreateQueryJob = vi.fn();
  const firestoreStore = new Map<string, any>();
  const firestoreQueryResults = new Map<string, any>();
  const mockHandleDbtStatus = vi.fn();
  const mockGetRunHistoryForModel = vi.fn();
  const mockGetLatestRun = vi.fn();

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
    mockHandleDbtStatus,
    mockGetRunHistoryForModel,
    mockGetLatestRun,
  };
});

// ─── External service mocks ──────────────────────────────────────
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
  createTraceId: () => 'trace-dbt-status',
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  }),
  logStage: vi.fn(),
}));

vi.mock('../../src/agents/dbtStatusAgent.js', () => ({
  handleDbtStatus: mockHandleDbtStatus,
}));

vi.mock('../../src/state/dbtRunHistory.js', () => ({
  getRunHistoryForModel: mockGetRunHistoryForModel,
  getLatestRun: mockGetLatestRun,
}));

// ─── Real imports ────────────────────────────────────────────────
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

const makeInput = (overrides: Record<string, unknown> = {}) => ({
  question: 'When was dim_customers last built?',
  channel: 'C123',
  threadTs: 'thread-1',
  statusMsgTs: 'status-1',
  client: mockClient as any,
  tables,
  config,
  ...overrides,
});

// ─── Test suite ──────────────────────────────────────────────────
describe('Pipeline — dbt_status route', () => {
  beforeAll(() => {
    initBigQuery();
    initBigQueryClient();
  });

  beforeEach(() => {
    mockGenerateContent.mockReset();
    mockCreateQueryJob.mockReset();
    mockHandleDbtStatus.mockReset();
    mockGetRunHistoryForModel.mockReset();
    mockGetLatestRun.mockReset();
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

  it('dbt_status route with model history bypasses SQL generation', async () => {
    const runHistory = [
      {
        model: 'dim_customers',
        status: 'success',
        executionTime: 12.5,
        runId: 'run-123',
        runStartedAt: new Date('2025-01-15T10:00:00Z'),
      },
    ];

    // Clarification returns dbt_status route
    mockGenerateContent.mockResolvedValueOnce(
      clarificationResponse({
        route: 'dbt_status',
        confidence: 'high',
        resolved_question: 'When was dim_customers last built?',
      }),
    );

    mockGetRunHistoryForModel.mockResolvedValue(runHistory);
    mockHandleDbtStatus.mockResolvedValue(
      'dim_customers was last built on Jan 15, 2025 at 10:00 AM UTC. The build completed successfully in 12.5 seconds.',
    );

    await runPipeline(makeInput());

    // Only 1 Gemini call (clarification) — no SQL generation or supervisor
    expect(mockGenerateContent).toHaveBeenCalledTimes(1);

    // No BigQuery calls — pipeline bypassed SQL generation
    expect(mockCreateQueryJob).not.toHaveBeenCalled();

    // getRunHistoryForModel called with extracted model name
    expect(mockGetRunHistoryForModel).toHaveBeenCalledWith('dim_customers');

    // handleDbtStatus called with resolved question and run history
    expect(mockHandleDbtStatus).toHaveBeenCalledWith(
      'When was dim_customers last built?',
      runHistory,
      'test-key',
    );

    // chat.update called with the formatted answer
    const updateCalls = mockClient.chat.update.mock.calls;
    const finalUpdate = updateCalls[updateCalls.length - 1][0];
    expect(finalUpdate.text).toContain('dim_customers was last built');

    // ResponseContext was saved (minimal, for observability)
    const savedKeys = [...firestoreStore.keys()].filter(k =>
      k.startsWith('response_context/'),
    );
    expect(savedKeys.length).toBe(1);
    const savedCtx = firestoreStore.get(savedKeys[0]);
    expect(savedCtx.traceId).toBe('trace-dbt-status');
    expect(savedCtx.clarifiedQuestion).toBe('When was dim_customers last built?');
  });

  it('dbt_status route extracts non-prefixed model from keyword context', async () => {
    mockGenerateContent.mockResolvedValueOnce(
      clarificationResponse({
        route: 'dbt_status',
        confidence: 'high',
        resolved_question: 'Was revenue built successfully?',
      }),
    );

    mockGetRunHistoryForModel.mockResolvedValue([]);
    mockHandleDbtStatus.mockResolvedValue(
      "I don't have any build history for that model.",
    );

    await runPipeline(
      makeInput({ question: 'Was revenue built successfully?' }),
    );

    // extractModelName should match "was revenue built" pattern
    expect(mockGetRunHistoryForModel).toHaveBeenCalledWith('revenue');
    expect(mockGetLatestRun).not.toHaveBeenCalled();
  });

  it('dbt_status route filters stopwords from keyword extraction', async () => {
    mockGenerateContent.mockResolvedValueOnce(
      clarificationResponse({
        route: 'dbt_status',
        confidence: 'high',
        resolved_question: 'Was the last build successful?',
      }),
    );

    mockGetLatestRun.mockResolvedValue([]);
    mockHandleDbtStatus.mockResolvedValue(
      "I don't have any build history for that model.",
    );

    await runPipeline(
      makeInput({ question: 'Was the last build successful?' }),
    );

    // "the" and "last" are stopwords — should fall through to getLatestRun
    expect(mockGetLatestRun).toHaveBeenCalled();
    expect(mockGetRunHistoryForModel).not.toHaveBeenCalled();
  });

  it('dbt_status route with no model name uses getLatestRun', async () => {
    const latestRunHistory = [
      {
        model: 'fct_orders',
        status: 'success',
        executionTime: 8.2,
        runId: 'run-456',
        runStartedAt: new Date('2025-01-15T12:00:00Z'),
      },
      {
        model: 'dim_customers',
        status: 'error',
        executionTime: 3.1,
        runId: 'run-456',
        runStartedAt: new Date('2025-01-15T12:00:00Z'),
        errorMessage: 'Relation does not exist',
      },
    ];

    // Clarification returns dbt_status route with no specific model in question
    mockGenerateContent.mockResolvedValueOnce(
      clarificationResponse({
        route: 'dbt_status',
        confidence: 'high',
        resolved_question: 'Did the last dbt run succeed?',
      }),
    );

    mockGetLatestRun.mockResolvedValue(latestRunHistory);
    mockHandleDbtStatus.mockResolvedValue(
      'The last dbt run had mixed results. fct_orders succeeded in 8.2s, but dim_customers failed.',
    );

    await runPipeline(
      makeInput({ question: 'Did the last dbt run succeed?' }),
    );

    // Only 1 Gemini call (clarification) — no SQL generation or supervisor
    expect(mockGenerateContent).toHaveBeenCalledTimes(1);

    // No BigQuery calls
    expect(mockCreateQueryJob).not.toHaveBeenCalled();

    // getLatestRun called instead of getRunHistoryForModel
    expect(mockGetLatestRun).toHaveBeenCalled();
    expect(mockGetRunHistoryForModel).not.toHaveBeenCalled();

    // handleDbtStatus called with resolved question and latest run history
    expect(mockHandleDbtStatus).toHaveBeenCalledWith(
      'Did the last dbt run succeed?',
      latestRunHistory,
      'test-key',
    );

    // chat.update called with the formatted answer
    const updateCalls = mockClient.chat.update.mock.calls;
    const finalUpdate = updateCalls[updateCalls.length - 1][0];
    expect(finalUpdate.text).toContain('last dbt run had mixed results');
  });
});
