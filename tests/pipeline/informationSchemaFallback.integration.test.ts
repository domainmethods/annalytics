import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// ─── Hoisted mock state ──────────────────────────────────────────
const {
  mockGenerateContent,
  mockCreateQueryJob,
  mockGetSchemaFallback,
  firestoreStore,
  firestoreQueryResults,
  mockDb,
} = vi.hoisted(() => {
  const mockGenerateContent = vi.fn();
  const mockCreateQueryJob = vi.fn();
  const mockGetSchemaFallback = vi.fn();
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
    mockGetSchemaFallback,
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
  createTraceId: () => 'trace-fallback',
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  }),
  logStage: vi.fn(),
}));

vi.mock('../../src/dbt/informationSchemaFallback.js', () => ({
  getSchemaFallback: mockGetSchemaFallback,
}));

// ─── Real imports ────────────────────────────────────────────────
import { runPipeline, type PipelineConfig } from '../../src/pipeline.js';
import { parseDbtArtifacts } from '../../src/dbt/parser.js';
import { initBigQuery } from '../../src/validation/dryRun.js';
import { initBigQueryClient } from '../../src/execution/runner.js';
import { _resetCache } from '../../src/teachings/summaryMap.js';
import { qualityLoop } from '../../src/qualityLoop.js';
import type { TableContext } from '../../src/dbt/types.js';

// Spy on qualityLoop to inspect its arguments
vi.mock('../../src/qualityLoop.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/qualityLoop.js')>();
  return {
    ...actual,
    qualityLoop: vi.fn(actual.qualityLoop),
  };
});

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
    headline: 'total event count',
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

const makeInput = () => ({
  question: 'How many events are in raw_dataset.raw_events?',
  channel: 'C123',
  threadTs: 'thread-fallback-1',
  statusMsgTs: 'status-1',
  client: mockClient as any,
  tables,
  config,
});

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
describe('Pipeline — INFORMATION_SCHEMA Fallback', () => {
  beforeAll(() => {
    initBigQuery();
    initBigQueryClient();
  });

  beforeEach(() => {
    mockGenerateContent.mockReset();
    mockCreateQueryJob.mockReset();
    mockGetSchemaFallback.mockReset();
    firestoreStore.clear();
    firestoreQueryResults.clear();
    _resetCache();

    mockClient.conversations.replies.mockReset();
    mockClient.chat.update.mockReset();
    mockClient.chat.postMessage.mockReset();

    mockClient.conversations.replies.mockResolvedValue({ messages: [] });
    mockClient.chat.update.mockResolvedValue({});
    mockClient.chat.postMessage.mockResolvedValue({});

    vi.mocked(qualityLoop).mockReset();
  });

  it('includes fallback table when question references non-dbt table', async () => {
    // Mock clarification: HIGH confidence, resolved question references raw_dataset.raw_events
    mockGenerateContent
      .mockResolvedValueOnce(clarificationResponse())
      .mockResolvedValueOnce(sqlGenResponse())
      .mockResolvedValueOnce(supervisorResponse());

    // getSchemaFallback returns a table context for the non-dbt table
    mockGetSchemaFallback.mockResolvedValue(fallbackTable);

    // BigQuery: dry run + execution
    mockCreateQueryJob
      .mockResolvedValueOnce(dryRunResult())
      .mockResolvedValueOnce(executionResult([{ event_count: 100 }]));

    // Spy on qualityLoop to inspect its arguments
    vi.mocked(qualityLoop).mockImplementation(
      async (options) => {
        // Capture the tables passed to verify fallback was included
        const tablesReceived = options.tables;
        const hasFallback = tablesReceived.some(
          (t) => t.name === 'raw_dataset.raw_events' && t.tags.includes('no-dbt-metadata'),
        );
        expect(hasFallback).toBe(true);
        // Verify fallback table description has the warning
        const fb = tablesReceived.find((t) => t.name === 'raw_dataset.raw_events');
        expect(fb?.description).toContain('minimal documentation');

        return {
          sqlResult: {
            sql: VALID_SQL,
            explanation: 'Counts events',
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
          failureHistory: [],
          bytesProcessed: 5000,
        };
      },
    );

    await runPipeline(makeInput());

    // getSchemaFallback was called with the correct args
    expect(mockGetSchemaFallback).toHaveBeenCalledWith(
      'test-project',
      'raw_dataset',
      'raw_events',
    );

    // qualityLoop was called (assertions above verified fallback table was included)
    expect(qualityLoop).toHaveBeenCalled();
  });

  it('ignores numeric-segment refs like v1.0 in question text', async () => {
    // Question contains "v1.0" which matches \w+\.\w+ but has a numeric segment
    mockGenerateContent
      .mockResolvedValueOnce(clarificationResponse({
        resolved_question: 'How many events since v1.0 in raw_dataset.raw_events?',
      }))
      .mockResolvedValueOnce(sqlGenResponse())
      .mockResolvedValueOnce(supervisorResponse());

    mockGetSchemaFallback.mockResolvedValue(fallbackTable);

    mockCreateQueryJob
      .mockResolvedValueOnce(dryRunResult())
      .mockResolvedValueOnce(executionResult([{ event_count: 50 }]));

    vi.mocked(qualityLoop).mockImplementation(
      async () => ({
        sqlResult: {
          sql: VALID_SQL,
          explanation: 'Counts events',
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
        failureHistory: [],
        bytesProcessed: 5000,
      }),
    );

    await runPipeline(makeInput());

    // getSchemaFallback called for raw_dataset.raw_events but NOT for v1.0
    const calls = mockGetSchemaFallback.mock.calls;
    const datasets = calls.map((c: unknown[]) => `${c[1]}.${c[2]}`);
    expect(datasets).toContain('raw_dataset.raw_events');
    expect(datasets).not.toContain('v1.0');
  });

  it('continues without fallback when getSchemaFallback fails', async () => {
    // Mock clarification: HIGH confidence
    mockGenerateContent
      .mockResolvedValueOnce(clarificationResponse())
      .mockResolvedValueOnce(sqlGenResponse())
      .mockResolvedValueOnce(supervisorResponse());

    // getSchemaFallback throws an error
    mockGetSchemaFallback.mockRejectedValue(new Error('BigQuery unavailable'));

    // BigQuery: dry run + execution
    mockCreateQueryJob
      .mockResolvedValueOnce(dryRunResult())
      .mockResolvedValueOnce(executionResult([{ event_count: 100 }]));

    // Capture the tables passed to qualityLoop
    vi.mocked(qualityLoop).mockImplementation(
      async (options) => {
        // Should receive only original tables — no fallback
        const hasNonDbtTable = options.tables.some(
          (t) => t.tags.includes('no-dbt-metadata'),
        );
        expect(hasNonDbtTable).toBe(false);
        // Should have exactly the same number of tables as original
        expect(options.tables.length).toBe(tables.length);

        return {
          sqlResult: {
            sql: VALID_SQL,
            explanation: 'Counts events',
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
          failureHistory: [],
          bytesProcessed: 5000,
        };
      },
    );

    await runPipeline(makeInput());

    // Pipeline completed without throwing
    expect(qualityLoop).toHaveBeenCalled();

    // The pipeline still executed (chat.update was called for status messages)
    expect(mockClient.chat.update).toHaveBeenCalled();
  });
});
