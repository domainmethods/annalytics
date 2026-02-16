import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// ─── Hoisted mock state ──────────────────────────────────────────
const {
  mockGenerateContent,
  mockCreateQueryJob,
  mockGetSchemaFallback,
  mockHandleDbtStatus,
  mockGetRunHistoryForModel,
  mockGetLatestRun,
  mockGenerateTeachingCandidate,
  mockSaveTeachingCandidate,
  firestoreStore,
  firestoreQueryResults,
  mockDb,
} = vi.hoisted(() => {
  const mockGenerateContent = vi.fn();
  const mockCreateQueryJob = vi.fn();
  const mockGetSchemaFallback = vi.fn();
  const mockHandleDbtStatus = vi.fn();
  const mockGetRunHistoryForModel = vi.fn();
  const mockGetLatestRun = vi.fn();
  const mockGenerateTeachingCandidate = vi.fn();
  const mockSaveTeachingCandidate = vi.fn();
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
      update: vi.fn(async (data: any) => {
        const existing = firestoreStore.get(path) || {};
        firestoreStore.set(path, { ...existing, ...data });
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
    mockGetSchemaFallback,
    mockHandleDbtStatus,
    mockGetRunHistoryForModel,
    mockGetLatestRun,
    mockGenerateTeachingCandidate,
    mockSaveTeachingCandidate,
    firestoreStore,
    firestoreQueryResults,
    mockDb,
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
  createTraceId: () => 'trace-phase2b',
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  }),
  logStage: vi.fn(),
}));

// ─── Domain-level mocks for Phase 2b features ───────────────────
vi.mock('../../src/dbt/informationSchemaFallback.js', () => ({
  getSchemaFallback: mockGetSchemaFallback,
}));

vi.mock('../../src/agents/dbtStatusAgent.js', () => ({
  handleDbtStatus: mockHandleDbtStatus,
}));

vi.mock('../../src/state/dbtRunHistory.js', () => ({
  getRunHistoryForModel: mockGetRunHistoryForModel,
  getLatestRun: mockGetLatestRun,
}));

vi.mock('../../src/teachings/candidateGenerator.js', () => ({
  generateTeachingCandidate: mockGenerateTeachingCandidate,
}));

vi.mock('../../src/state/teachingCandidates.js', () => ({
  saveTeachingCandidate: mockSaveTeachingCandidate,
}));

// Spy on generateWithSupervision to inspect arguments while keeping real implementation
vi.mock('../../src/agents/supervisorLoop.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/agents/supervisorLoop.js')>();
  return {
    ...actual,
    generateWithSupervision: vi.fn(actual.generateWithSupervision),
  };
});

// ─── Real imports ────────────────────────────────────────────────
import { runPipeline, type PipelineConfig } from '../../src/pipeline.js';
import { resumeFromEscalation, type EscalationResumeContext } from '../../src/handlers/escalationResponse.js';
import { parseDbtArtifacts } from '../../src/dbt/parser.js';
import { initBigQuery } from '../../src/validation/dryRun.js';
import { initBigQueryClient } from '../../src/execution/runner.js';
import { _resetCache } from '../../src/teachings/summaryMap.js';
import { generateWithSupervision } from '../../src/agents/supervisorLoop.js';
import { resolveEscalation as _resolveEscalation } from '../../src/state/escalationState.js';
import { buildEscalationResolvedBlocks as _buildEscalationResolvedBlocks } from '../../src/slack/escalationBlocks.js';
import type { TableContext } from '../../src/dbt/types.js';

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
  'SELECT COUNT(*) as event_count FROM `raw_dataset.raw_events`';

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
    resolved_question: 'How many events are in raw_dataset.raw_events?',
    ...overrides,
  });
}

function sqlGenResponse(overrides: Record<string, unknown> = {}) {
  return geminiResponse({
    sql: VALID_SQL,
    explanation: 'Counts all events from raw_events',
    tables_used: ['raw_dataset.raw_events'],
    confidence: 'high',
    assumptions: [],
    reasoning_chain: 'Simple count query on raw_events',
    ...overrides,
  });
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
  gcpProjectId: 'test-project',
};

// ─── Fallback table fixture ──────────────────────────────────────
const fallbackTable: TableContext = {
  name: 'raw_dataset.raw_events',
  schema: 'raw_dataset',
  description: '',
  materialization: 'unknown',
  columns: [
    { name: 'event_id', dataType: 'STRING', description: '', meta: {} },
    { name: 'created_at', dataType: 'TIMESTAMP', description: '', meta: {} },
  ],
  sampleDDL: 'CREATE TABLE `raw_dataset.raw_events` (\n  event_id STRING,\n  created_at TIMESTAMP\n);',
  dependsOn: [],
  tags: ['no-dbt-metadata'],
};

// ─── Test suite ──────────────────────────────────────────────────
describe('Phase 2b Features — Integration', () => {
  beforeAll(() => {
    initBigQuery();
    initBigQueryClient();
  });

  beforeEach(() => {
    mockGenerateContent.mockReset();
    mockCreateQueryJob.mockReset();
    mockGetSchemaFallback.mockReset();
    mockHandleDbtStatus.mockReset();
    mockGetRunHistoryForModel.mockReset();
    mockGetLatestRun.mockReset();
    mockGenerateTeachingCandidate.mockReset();
    mockSaveTeachingCandidate.mockReset();
    firestoreStore.clear();
    firestoreQueryResults.clear();
    _resetCache();

    mockClient.conversations.replies.mockReset();
    mockClient.chat.update.mockReset();
    mockClient.chat.postMessage.mockReset();

    mockClient.conversations.replies.mockResolvedValue({ messages: [] });
    mockClient.chat.update.mockResolvedValue({});
    mockClient.chat.postMessage.mockResolvedValue({});

    vi.mocked(generateWithSupervision).mockReset();
  });

  it('INFORMATION_SCHEMA fallback provides schema for non-dbt tables', async () => {
    // Clarification: HIGH confidence, resolved question references raw_dataset.raw_events
    mockGenerateContent
      .mockResolvedValueOnce(clarificationResponse())
      .mockResolvedValueOnce(sqlGenResponse())
      .mockResolvedValueOnce(supervisorResponse());

    // getSchemaFallback returns a fallback TableContext for the non-dbt table
    mockGetSchemaFallback.mockResolvedValue(fallbackTable);

    // BigQuery: dry run + execution
    mockCreateQueryJob
      .mockResolvedValueOnce(dryRunResult())
      .mockResolvedValueOnce(executionResult([{ event_count: 100 }]));

    // Spy on generateWithSupervision: capture tables argument, then delegate to real impl
    vi.mocked(generateWithSupervision).mockImplementation(
      async (options, _apiKey, _question) => {
        // The tables passed should include the fallback table with warning description
        const fb = options.tables.find(
          (t) => t.name === 'raw_dataset.raw_events' && t.tags.includes('no-dbt-metadata'),
        );
        expect(fb).toBeDefined();
        expect(fb?.description).toContain('\u26a0\ufe0f minimal documentation');

        return {
          sqlResult: {
            sql: VALID_SQL,
            explanation: 'Counts events from raw_events',
            tablesUsed: ['raw_dataset.raw_events'],
            confidence: 'high' as const,
            assumptions: [],
            reasoningChain: 'count query',
            groundingCitations: [],
          },
          verdict: 'pass' as const,
          supervisorNotes: '',
          finalConfidence: 'high' as const,
          retryCount: 0,
        };
      },
    );

    await runPipeline({
      question: 'How many events are in raw_dataset.raw_events?',
      channel: 'C123',
      threadTs: 'thread-fallback-1',
      statusMsgTs: 'status-1',
      client: mockClient as any,
      tables,
      config,
    });

    // getSchemaFallback was called for the non-dbt reference
    expect(mockGetSchemaFallback).toHaveBeenCalledWith(
      'test-project',
      'raw_dataset',
      'raw_events',
    );

    // generateWithSupervision was called (assertions above verified fallback inclusion)
    expect(generateWithSupervision).toHaveBeenCalled();

    // Pipeline completed with result posted to Slack
    const updateCalls = mockClient.chat.update.mock.calls;
    expect(updateCalls.length).toBeGreaterThan(0);
  });

  it('dbt_status route bypasses SQL generation', async () => {
    const runHistory = [
      {
        model: 'dim_customers',
        status: 'success',
        executionTime: 12.5,
        runId: 'run-123',
        runStartedAt: new Date('2025-01-15T10:00:00Z'),
      },
    ];

    const statusAnswer =
      'dim_customers was last built on Jan 15, 2025 at 10:00 AM UTC. The build completed successfully in 12.5 seconds.';

    // Clarification returns dbt_status route
    mockGenerateContent.mockResolvedValueOnce(
      clarificationResponse({
        route: 'dbt_status',
        confidence: 'high',
        resolved_question: 'When was dim_customers last built?',
      }),
    );

    mockGetRunHistoryForModel.mockResolvedValue(runHistory);
    mockHandleDbtStatus.mockResolvedValue(statusAnswer);

    await runPipeline({
      question: 'When was dim_customers last built?',
      channel: 'C123',
      threadTs: 'thread-dbt-1',
      statusMsgTs: 'status-1',
      client: mockClient as any,
      tables,
      config,
    });

    // Only 1 Gemini call (clarification) -- no SQL generation or supervisor
    expect(mockGenerateContent).toHaveBeenCalledTimes(1);

    // generateWithSupervision was NOT called (dbt_status bypasses SQL generation)
    expect(generateWithSupervision).not.toHaveBeenCalled();

    // No BigQuery calls -- pipeline bypassed SQL generation entirely
    expect(mockCreateQueryJob).not.toHaveBeenCalled();

    // chat.update was called with the formatted string from handleDbtStatus
    const updateCalls = mockClient.chat.update.mock.calls;
    const finalUpdate = updateCalls[updateCalls.length - 1][0];
    expect(finalUpdate.text).toBe(statusAnswer);

    // ResponseContext was persisted for observability
    const savedKeys = [...firestoreStore.keys()].filter(k =>
      k.startsWith('response_context/'),
    );
    expect(savedKeys.length).toBe(1);
    const savedCtx = firestoreStore.get(savedKeys[0]);
    expect(savedCtx.generatedSql).toBe('');
    expect(savedCtx.clarifiedQuestion).toBe('When was dim_customers last built?');
  });

  it('escalation resolution generates teaching candidate', async () => {
    const mockCandidate = {
      candidateId: 'teach_esc_trace-1',
      escalationId: 'esc_trace-1',
      status: 'pending' as const,
      generatedAt: new Date(),
      originalQuestion: 'What is revenue?',
      humanResponse: 'Use LEFT JOIN on user_id',
      questionPatterns: ['revenue questions'],
      reasoning: 'Use fct_orders with LEFT JOIN',
      sanctionedSql: 'SELECT SUM(amount) FROM orders LEFT JOIN users ON orders.user_id = users.id',
      modelsReferenced: ['orders', 'users'],
      tags: ['revenue'],
    };

    mockGenerateTeachingCandidate.mockResolvedValue(mockCandidate);
    mockSaveTeachingCandidate.mockResolvedValue(undefined);

    const ctx: EscalationResumeContext = {
      escalationId: 'esc_trace-1',
      originalChannel: 'C-ORIGINAL',
      originalThreadTs: 'thread-1',
      statusMsgTs: 'status-1',
      humanGuidance: 'Use LEFT JOIN on user_id',
      behavior: 'best_effort_verify',
      context: {
        clarifiedQuestion: 'What is revenue?',
        userQuestion: 'What is revenue?',
        groundingCitations: [],
        previousSql: 'SELECT SUM(amount) FROM orders',
        supervisorNotes: 'Not sure about joins',
      },
      traceId: 'trace-1',
    };

    await resumeFromEscalation(ctx, mockClient as any, tables, config);

    // Flush microtask queue so the fire-and-forget promise chain resolves
    await vi.waitFor(() => {
      expect(mockSaveTeachingCandidate).toHaveBeenCalled();
    });

    // generateTeachingCandidate was called with correct escalation context
    expect(mockGenerateTeachingCandidate).toHaveBeenCalledWith({
      escalationId: 'esc_trace-1',
      originalQuestion: 'What is revenue?',
      clarifiedQuestion: 'What is revenue?',
      humanResponse: 'Use LEFT JOIN on user_id',
      finalSql: 'SELECT SUM(amount) FROM orders',
      supervisorNotes: 'Not sure about joins',
      apiKey: 'test-key',
    });

    // saveTeachingCandidate was called with the generated candidate
    expect(mockSaveTeachingCandidate).toHaveBeenCalledWith(mockCandidate);

    // The human response was posted to the original thread (best_effort_verify behavior)
    expect(mockClient.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'C-ORIGINAL',
        thread_ts: 'thread-1',
      }),
    );
  });
});
