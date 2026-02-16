import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock all domain modules
vi.mock('../src/agents/clarificationAgent.js');
vi.mock('../src/agents/supervisorLoop.js');
vi.mock('../src/agents/confidence.js');
vi.mock('../src/validation/pipeline.js');
vi.mock('../src/execution/runner.js');
vi.mock('../src/execution/formatter.js');
vi.mock('../src/slack/threadContext.js');
vi.mock('../src/slack/blocks.js');
vi.mock('../src/slack/clarificationBlocks.js');
vi.mock('../src/state/responseContext.js');
vi.mock('../src/state/clarificationState.js');
vi.mock('../src/state/threadLock.js');
vi.mock('../src/teachings/summaryMap.js');
vi.mock('../src/dbt/sampleRowCache.js');
vi.mock('../src/logging.js', () => ({
  createTraceId: () => 'trace-abc',
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() }),
  logStage: vi.fn(),
}));

import { runPipeline } from '../src/pipeline.js';
import { classifyQuestion } from '../src/agents/clarificationAgent.js';
import { generateWithSupervision } from '../src/agents/supervisorLoop.js';
import { reconcileConfidence } from '../src/agents/confidence.js';
import { validateSql } from '../src/validation/pipeline.js';
import { executeQuery } from '../src/execution/runner.js';
import { chooseFormat } from '../src/execution/formatter.js';
import { buildThreadContext } from '../src/slack/threadContext.js';
import { saveResponseContext, getLatestNegativeFeedback } from '../src/state/responseContext.js';
import { saveClarificationState } from '../src/state/clarificationState.js';
import { releaseThreadLock } from '../src/state/threadLock.js';
import { getTeachingSummaries } from '../src/teachings/summaryMap.js';
import { getSampleRows } from '../src/dbt/sampleRowCache.js';
import { buildSingleValueBlocks, buildFeedbackActions } from '../src/slack/blocks.js';
import { buildClarificationBlocks } from '../src/slack/clarificationBlocks.js';

const mockClassify = vi.mocked(classifyQuestion);
const mockSupervise = vi.mocked(generateWithSupervision);
const mockReconcile = vi.mocked(reconcileConfidence);
const mockValidate = vi.mocked(validateSql);
const mockExecute = vi.mocked(executeQuery);
const mockFormat = vi.mocked(chooseFormat);
const mockBuildThread = vi.mocked(buildThreadContext);
const mockSaveCtx = vi.mocked(saveResponseContext);
const mockGetNegative = vi.mocked(getLatestNegativeFeedback);
const mockSaveClarification = vi.mocked(saveClarificationState);
const mockReleaseLock = vi.mocked(releaseThreadLock);
const mockGetSummaries = vi.mocked(getTeachingSummaries);
const mockGetSampleRows = vi.mocked(getSampleRows);
const mockBuildSingleValue = vi.mocked(buildSingleValueBlocks);
const mockBuildFeedback = vi.mocked(buildFeedbackActions);
const mockBuildClarification = vi.mocked(buildClarificationBlocks);

const mockClient = {
  conversations: { replies: vi.fn() },
  chat: { update: vi.fn(), postMessage: vi.fn() },
};

const baseInput = {
  question: 'What is total revenue?',
  channel: 'C123',
  threadTs: 'thread-1',
  statusMsgTs: 'status-1',
  client: mockClient as any,
  tables: [],
  config: {
    geminiApiKey: 'key',
    fileSearchStoreId: 'stores/test',
    maxBytesProcessed: 10e9,
    queryTimeoutMs: 30000,
    maxResultRows: 1000,
  },
};

const highClarification = {
  route: 'data_query' as const,
  confidence: 'high' as const,
  reasoning: 'Clear question',
  ambiguities: [],
  assumptions: [],
  clarifying_questions: [],
  resolved_question: 'What is total revenue from all orders?',
};

const baseSupervisedResult = {
  sqlResult: {
    sql: 'SELECT SUM(total_amount) FROM `analytics.fct_orders`',
    explanation: 'Sums total amount',
    tablesUsed: ['analytics.fct_orders'],
    confidence: 'high' as const,
    assumptions: [],
    reasoningChain: 'Simple sum',
    groundingCitations: [],
  },
  verdict: 'pass' as const,
  supervisorNotes: 'Approved',
  finalConfidence: 'high' as const,
  retryCount: 0,
};

function setupHappyPath() {
  mockClient.conversations.replies.mockResolvedValue({ messages: [] });
  mockBuildThread.mockReturnValue([]);
  mockGetSummaries.mockResolvedValue([]);
  mockGetSampleRows.mockResolvedValue(null);
  mockGetNegative.mockResolvedValue(null);
  mockClassify.mockResolvedValue(highClarification);
  mockSupervise.mockResolvedValue(baseSupervisedResult);
  mockReconcile.mockReturnValue('high');
  mockValidate.mockResolvedValue({ valid: true, layer: 'all', bytesProcessed: 100 });
  mockExecute.mockResolvedValue({
    rows: [{ total: 5000000 }],
    columnNames: ['total'],
    totalRows: 1,
    bytesProcessed: 100,
    truncated: false,
  });
  mockFormat.mockReturnValue('single_value');
  mockBuildSingleValue.mockReturnValue([{ type: 'section', text: { type: 'mrkdwn', text: 'test' } }] as any);
  mockBuildFeedback.mockReturnValue({ type: 'actions', elements: [] } as any);
  mockBuildClarification.mockReturnValue([{ type: 'section', text: { type: 'mrkdwn', text: 'test' } }]);
  mockClient.chat.update.mockResolvedValue({});
  mockSaveCtx.mockResolvedValue(undefined);
  mockReleaseLock.mockResolvedValue(undefined);
}

describe('runPipeline', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupHappyPath();
  });

  it('happy path: HIGH confidence end-to-end', async () => {
    await runPipeline(baseInput);

    expect(mockClassify).toHaveBeenCalledTimes(1);
    expect(mockSupervise).toHaveBeenCalledTimes(1);
    expect(mockValidate).toHaveBeenCalledTimes(1);
    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect(mockSaveCtx).toHaveBeenCalledTimes(1);
    expect(mockReleaseLock).toHaveBeenCalledTimes(1);
  });

  it('MEDIUM confidence: includes assumptions in response', async () => {
    mockClassify.mockResolvedValue({
      ...highClarification,
      confidence: 'medium',
      assumptions: ['Assuming all-time', 'Assuming all regions'],
    });

    await runPipeline(baseInput);

    // Should still proceed to generation
    expect(mockSupervise).toHaveBeenCalledTimes(1);
    expect(mockExecute).toHaveBeenCalledTimes(1);
  });

  it('LOW confidence: suspends pipeline, posts clarification', async () => {
    mockClassify.mockResolvedValue({
      ...highClarification,
      confidence: 'low',
      clarifying_questions: ['Which time period?', 'Which product line?'],
    });

    await runPipeline(baseInput);

    // Should NOT proceed to generation
    expect(mockSupervise).not.toHaveBeenCalled();
    expect(mockExecute).not.toHaveBeenCalled();
    // Should save clarification state
    expect(mockSaveClarification).toHaveBeenCalledTimes(1);
    // Should still release lock
    expect(mockReleaseLock).toHaveBeenCalledTimes(1);
  });

  it('supervisor retry then pass', async () => {
    mockSupervise.mockResolvedValue({
      ...baseSupervisedResult,
      verdict: 'fail_then_pass',
      retryCount: 1,
    });

    await runPipeline(baseInput);

    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect(mockSaveCtx).toHaveBeenCalledTimes(1);
  });

  it('supervisor exhaustion: proceeds with low confidence caveat', async () => {
    mockSupervise.mockResolvedValue({
      ...baseSupervisedResult,
      verdict: 'exhausted',
      finalConfidence: 'low',
      supervisorNotes: 'Could not approve after 3 attempts',
    });
    mockReconcile.mockReturnValue('low');

    await runPipeline(baseInput);

    // Should still execute
    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect(mockSaveCtx).toHaveBeenCalledTimes(1);
  });

  it('injects negative example when thread has thumbs-down', async () => {
    mockGetNegative.mockResolvedValue({
      sql: 'SELECT bad FROM table',
      explanation: 'Wrong approach',
      tablesUsed: ['table'],
    });

    await runPipeline(baseInput);

    const superviseCall = mockSupervise.mock.calls[0][0];
    expect(superviseCall.negativeExample).toBeDefined();
    expect(superviseCall.negativeExample!.sql).toBe('SELECT bad FROM table');
  });

  it('progressive status updates at correct stages', async () => {
    await runPipeline(baseInput);

    const updateCalls = mockClient.chat.update.mock.calls.map(c => c[0].text);
    // Should have at least: "Understanding...", "Generating SQL...", "Reviewing answer...", then final
    expect(updateCalls.some((t: string) => t?.includes('Understanding'))).toBe(true);
    expect(updateCalls.some((t: string) => t?.includes('Generating SQL'))).toBe(true);
  });
});
