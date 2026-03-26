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
  createTraceId: () => 'trace-followup',
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  }),
  logStage: vi.fn(),
  rootLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Stub out chart generation so it doesn't add extra Gemini calls
vi.mock('../../src/execution/chartRenderer.js', () => ({
  isChartable: vi.fn(() => false),
  renderChart: vi.fn(async () => null),
}));
vi.mock('../../src/agents/chartAgent.js', () => ({
  generateChartSpec: vi.fn(async () => null),
}));

// ─── Real imports ────────────────────────────────────────────────
import { routeFollowUp } from '../../src/handlers/followUpRouter.js';
import type { PipelineConfig } from '../../src/pipeline.js';
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
const VALID_SQL = 'SELECT COUNT(*) as order_count FROM `analytics.fct_orders`';

function geminiResponse(data: Record<string, unknown>, groundingChunks: any[] = []) {
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
    resolved_question: 'What is total revenue? (Refinement: break down by region)',
    ...overrides,
  });
}

function sqlGenResponse(overrides: Record<string, unknown> = {}, groundingChunks: any[] = []) {
  return geminiResponse(
    {
      sql: 'SELECT region, SUM(revenue) FROM `analytics.fct_orders` GROUP BY region',
      explanation: 'Revenue by region',
      tables_used: ['analytics.fct_orders'],
      confidence: 'high',
      assumptions: [],
      reasoning_chain: 'Grouped by region',
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
  return [{ metadata: { statistics: { totalBytesProcessed: String(bytesProcessed) } } }];
}

function executionResult(rows: Record<string, unknown>[], totalRows?: number) {
  return [
    {
      getQueryResults: vi.fn().mockResolvedValue([rows]),
      getMetadata: vi.fn().mockResolvedValue([{
        statistics: {
          query: { totalRows: String(totalRows ?? rows.length) },
          totalBytesProcessed: '5000',
        },
      }]),
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

// Pre-built ResponseContext for follow-up tests
const savedResponseContext = {
  responseId: 'resp-prev',
  threadTs: 'thread-1',
  statusMsgTs: 'prev-status-1',
  clarifiedQuestion: 'What is total revenue?',
  assumptions: ['All-time'],
  reasoningChain: 'Used fct_orders for revenue',
  generatedSql: VALID_SQL,
  explanation: 'Counts all orders',
  tablesUsed: ['analytics.fct_orders'],
  confidence: 'high',
  primaryAgentConfidence: 'high',
  queryResults: { rowCount: 1, columnNames: ['order_count'], bytesProcessed: 5000 },
  pipelineDurationMs: 2000,
  traceId: 'trace-prev',
  createdAt: new Date(),
  groundingCitations: [{ sourceFile: 'revenue_teaching.md', chunkText: 'Use fct_orders', relevanceScore: 0.9 }],
  teachingsUsed: ['revenue_teaching.md'],
  supervisorVerdict: 'pass',
  supervisorNotes: 'Approved',
  retrievedSchema: [{
    name: 'analytics.fct_orders',
    description: 'Orders fact table',
    columns: [{ name: 'revenue', description: 'Total revenue', dataType: 'FLOAT64' }],
  }],
};

// ─── Test suite ──────────────────────────────────────────────────
describe('Follow-Up Flows — Integration', () => {
  beforeAll(() => {
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

  it('meta-question: answers from ResponseContext via Flash, no SQL generation', async () => {
    // Pre-populate Firestore with a ResponseContext
    firestoreQueryResults.set('response_context', {
      empty: false,
      docs: [{
        data: () => savedResponseContext,
      }],
    });

    // Flash response for meta-question
    mockGenerateContent.mockResolvedValueOnce({
      text: 'I used fct_orders because it contains the revenue column and is the canonical orders table.',
    });

    await routeFollowUp(
      'meta_question',
      'Why did you use fct_orders?',
      'thread-1',
      'C123',
      'status-1',
      mockClient as any,
      config,
      tables,
    );

    // Only 1 Gemini call (Flash for meta-question — no clarification, no SQL gen, no supervisor)
    expect(mockGenerateContent).toHaveBeenCalledTimes(1);

    // No BigQuery calls
    expect(mockCreateQueryJob).not.toHaveBeenCalled();

    // Flash call includes ResponseContext content in user prompt
    const flashCall = mockGenerateContent.mock.calls[0][0];
    const promptText = flashCall.contents[0].parts[0].text;
    expect(promptText).toContain(VALID_SQL);
    expect(promptText).toContain('fct_orders');

    // Response posted to Slack
    expect(mockClient.chat.update).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'C123',
        ts: 'status-1',
        text: expect.stringContaining('fct_orders'),
      }),
    );
  });

  it('refinement: re-runs pipeline with composite question and previous SQL hint', async () => {
    // Pre-populate Firestore with a ResponseContext
    firestoreQueryResults.set('response_context', {
      empty: false,
      docs: [{
        data: () => savedResponseContext,
      }],
    });

    // Full pipeline mocks: clarification → SQL gen → supervisor
    mockGenerateContent
      .mockResolvedValueOnce(clarificationResponse())
      .mockResolvedValueOnce(sqlGenResponse())
      .mockResolvedValueOnce(supervisorResponse());

    // BigQuery: dry run → execution
    mockCreateQueryJob
      .mockResolvedValueOnce(dryRunResult())
      .mockResolvedValueOnce(executionResult([
        { region: 'US', revenue: 3000000 },
        { region: 'EMEA', revenue: 2000000 },
      ], 2));

    await routeFollowUp(
      'refinement',
      'break down by region',
      'thread-1',
      'C123',
      'status-1',
      mockClient as any,
      config,
      tables,
    );

    // Full pipeline: 3 Gemini calls (clarification + SQL gen + supervisor)
    expect(mockGenerateContent).toHaveBeenCalledTimes(3);

    // 2 BigQuery calls (dry run + execution)
    expect(mockCreateQueryJob).toHaveBeenCalledTimes(2);

    // SQL gen call includes previous SQL as refinement hint in system prompt
    const sqlGenCall = mockGenerateContent.mock.calls[1][0];
    const systemInstruction = sqlGenCall.config.systemInstruction;
    expect(systemInstruction).toContain('PREVIOUS SQL');
    expect(systemInstruction).toContain(VALID_SQL);
    expect(systemInstruction).toContain('modification');

    // Response saved to Firestore
    const responseKeys = [...firestoreStore.keys()].filter(k => k.startsWith('response_context/'));
    expect(responseKeys.length).toBe(1);
  });
});
