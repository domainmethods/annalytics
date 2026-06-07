import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock all domain modules
vi.mock('../src/agents/clarificationAgent.js');
vi.mock('../src/qualityLoop.js');
vi.mock('../src/agents/confidence.js');
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
vi.mock('../src/agents/escalationDecision.js');
vi.mock('../src/state/escalationState.js');
vi.mock('../src/slack/escalationBlocks.js');
vi.mock('../src/logging.js', () => ({
  createTraceId: () => 'trace-abc',
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() }),
  logStage: vi.fn(),
}));

import { runPipeline } from '../src/pipeline.js';
import { classifyQuestion } from '../src/agents/clarificationAgent.js';
import { qualityLoop } from '../src/qualityLoop.js';
import { reconcileConfidence } from '../src/agents/confidence.js';
import { executeQuery } from '../src/execution/runner.js';
import { chooseFormat } from '../src/execution/formatter.js';
import { buildThreadContext } from '../src/slack/threadContext.js';
import { saveResponseContext, getLatestNegativeFeedback } from '../src/state/responseContext.js';
import { saveClarificationState } from '../src/state/clarificationState.js';
import { releaseThreadLock } from '../src/state/threadLock.js';
import { getTeachingSummaries } from '../src/teachings/summaryMap.js';
import { getSampleRows } from '../src/dbt/sampleRowCache.js';
import { buildSingleValueBlocks, buildFeedbackActions, buildAssumptionBlocks } from '../src/slack/blocks.js';
import { buildClarificationBlocks } from '../src/slack/clarificationBlocks.js';
import { decideEscalation } from '../src/agents/escalationDecision.js';
import { saveEscalationState } from '../src/state/escalationState.js';
import { buildEscalationBlocks, buildUserWaitingBlocks, buildBestEffortCaveatBlocks } from '../src/slack/escalationBlocks.js';
import type { QualityResult } from '../src/qualityLoop.js';

const mockClassify = vi.mocked(classifyQuestion);
const mockQualityLoop = vi.mocked(qualityLoop);
const mockReconcile = vi.mocked(reconcileConfidence);
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
const mockBuildAssumptions = vi.mocked(buildAssumptionBlocks);
const mockBuildClarification = vi.mocked(buildClarificationBlocks);
const mockDecideEscalation = vi.mocked(decideEscalation);
const mockSaveEscalation = vi.mocked(saveEscalationState);
const mockBuildEscalationBlocks = vi.mocked(buildEscalationBlocks);
const mockBuildWaiting = vi.mocked(buildUserWaitingBlocks);
const mockBuildCaveat = vi.mocked(buildBestEffortCaveatBlocks);

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

const baseQualityResult: QualityResult = {
  sqlResult: {
    sql: 'SELECT SUM(total_amount) FROM `analytics.fct_orders`',
    explanation: 'Sums total amount',
    tablesUsed: ['analytics.fct_orders'],
    confidence: 'high',
    assumptions: [],
    reasoningChain: 'Simple sum',
    groundingCitations: [],
  },
  verdict: 'pass',
  supervisorNotes: 'Approved',
  finalConfidence: 'high',
  retryCount: 0,
  failureHistory: [],
  bytesProcessed: 100,
};

function setupHappyPath() {
  mockClient.conversations.replies.mockResolvedValue({ messages: [] });
  mockBuildThread.mockReturnValue([]);
  mockGetSummaries.mockResolvedValue([]);
  mockGetSampleRows.mockResolvedValue(null);
  mockGetNegative.mockResolvedValue(null);
  mockClassify.mockResolvedValue(highClarification);
  mockQualityLoop.mockResolvedValue(baseQualityResult);
  mockReconcile.mockReturnValue('high');
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
  mockBuildAssumptions.mockReturnValue([]);
  mockBuildClarification.mockReturnValue([{ type: 'section', text: { type: 'mrkdwn', text: 'test' } }]);
  mockClient.chat.update.mockResolvedValue({});
  mockClient.chat.postMessage.mockResolvedValue({ ts: 'esc-msg-1' });
  mockSaveCtx.mockResolvedValue(undefined);
  mockReleaseLock.mockResolvedValue(undefined);
  mockDecideEscalation.mockReturnValue({ shouldEscalate: false, behavior: 'park_wait', trigger: 'supervisor_exhausted' });
  mockSaveEscalation.mockResolvedValue(undefined);
  mockBuildEscalationBlocks.mockReturnValue([{ type: 'section', text: { type: 'mrkdwn', text: 'escalation' } }] as any);
  mockBuildWaiting.mockReturnValue([{ type: 'section', text: { type: 'mrkdwn', text: 'waiting' } }] as any);
  mockBuildCaveat.mockReturnValue([{ type: 'section', text: { type: 'mrkdwn', text: 'caveat' } }] as any);
}

describe('runPipeline', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    setupHappyPath();
  });

  it('happy path: HIGH confidence end-to-end', async () => {
    await runPipeline(baseInput);

    expect(mockClassify).toHaveBeenCalledTimes(1);
    expect(mockQualityLoop).toHaveBeenCalledTimes(1);
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

    expect(mockQualityLoop).toHaveBeenCalledTimes(1);
    expect(mockExecute).toHaveBeenCalledTimes(1);
  });

  it('LOW confidence: suspends pipeline, posts clarification', async () => {
    mockClassify.mockResolvedValue({
      ...highClarification,
      confidence: 'low',
      clarifying_questions: ['Which time period?', 'Which product line?'],
    });

    await runPipeline(baseInput);

    expect(mockQualityLoop).not.toHaveBeenCalled();
    expect(mockExecute).not.toHaveBeenCalled();
    expect(mockSaveClarification).toHaveBeenCalledTimes(1);
    expect(mockReleaseLock).toHaveBeenCalledTimes(1);
  });

  it('quality loop fail_then_pass: proceeds to execution', async () => {
    mockQualityLoop.mockResolvedValue({
      ...baseQualityResult,
      verdict: 'fail_then_pass',
      retryCount: 1,
      failureHistory: [{ attempt: 0, failureType: 'semantic', detail: 'Missing filter' }],
    });

    await runPipeline(baseInput);

    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect(mockSaveCtx).toHaveBeenCalledTimes(1);
  });

  it('cost_exceeded: shows actionable message, no execution', async () => {
    mockQualityLoop.mockResolvedValue({
      ...baseQualityResult,
      verdict: 'cost_exceeded',
      bytesProcessed: 20e9, // 20 GB
    });

    await runPipeline(baseInput);

    expect(mockExecute).not.toHaveBeenCalled();
    expect(mockSaveCtx).not.toHaveBeenCalled();
    const updateCalls = mockClient.chat.update.mock.calls;
    const finalUpdate = updateCalls[updateCalls.length - 1][0];
    expect(finalUpdate.text).toContain('GB');
    expect(finalUpdate.text).toContain('narrowing');
  });

  it('injects negative example when thread has thumbs-down', async () => {
    mockGetNegative.mockResolvedValue({
      sql: 'SELECT bad FROM table',
      explanation: 'Wrong approach',
      tablesUsed: ['table'],
    });

    await runPipeline(baseInput);

    const qualityCall = mockQualityLoop.mock.calls[0][0];
    expect(qualityCall.negativeExample).toBeDefined();
    expect(qualityCall.negativeExample!.sql).toBe('SELECT bad FROM table');
  });

  it('progressive status updates at correct stages', async () => {
    await runPipeline(baseInput);

    const updateCalls = mockClient.chat.update.mock.calls.map(c => c[0].text);
    expect(updateCalls.some((t: string) => t?.includes('Understanding'))).toBe(true);
  });

  it('park_wait escalation: no execution, state saved, user notified', async () => {
    mockQualityLoop.mockResolvedValue({
      ...baseQualityResult,
      verdict: 'exhausted',
      sqlResult: { ...baseQualityResult.sqlResult, confidence: 'low' },
      finalConfidence: 'low',
      supervisorNotes: 'Could not approve after 3 attempts',
      failureHistory: [
        { attempt: 0, failureType: 'semantic', detail: 'Bad query' },
        { attempt: 1, failureType: 'semantic', detail: 'Still bad' },
        { attempt: 2, failureType: 'semantic', detail: 'Exhausted' },
      ],
    });
    mockDecideEscalation.mockReturnValue({
      shouldEscalate: true,
      behavior: 'park_wait',
      trigger: 'quality_loop_exhausted',
    });

    const inputWithEscalation = {
      ...baseInput,
      config: {
        ...baseInput.config,
        escalation: {
          mode: 'channel' as const,
          channelId: 'C-ESCALATION',
          timeoutHours: 4,
        },
      },
    };

    await runPipeline(inputWithEscalation);

    expect(mockExecute).not.toHaveBeenCalled();
    expect(mockClient.chat.update).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('data team'),
      }),
    );
    expect(mockClient.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'C-ESCALATION' }),
    );
    expect(mockSaveEscalation).toHaveBeenCalledWith(
      expect.objectContaining({
        behavior: 'park_wait',
        originalThreadTs: 'thread-1',
        escalationChannel: 'C-ESCALATION',
      }),
      4,
    );
    expect(mockReleaseLock).toHaveBeenCalledTimes(1);

    // Verify escalation message includes per-attempt failure diagnostics
    expect(mockBuildEscalationBlocks).toHaveBeenCalledWith(
      expect.objectContaining({
        stuckDescription: expect.stringContaining('Attempt 1:'),
      }),
    );
    expect(mockBuildEscalationBlocks).toHaveBeenCalledWith(
      expect.objectContaining({
        stuckDescription: expect.stringContaining('[semantic]'),
      }),
    );
  });

  it('best_effort_verify escalation: execution happens, caveat shown, state saved', async () => {
    mockQualityLoop.mockResolvedValue({
      ...baseQualityResult,
      verdict: 'exhausted',
      sqlResult: { ...baseQualityResult.sqlResult, confidence: 'medium' },
      finalConfidence: 'medium',
      supervisorNotes: 'Uncertain about join logic',
      failureHistory: [
        { attempt: 0, failureType: 'semantic', detail: 'Uncertain' },
      ],
    });
    mockDecideEscalation.mockReturnValue({
      shouldEscalate: true,
      behavior: 'best_effort_verify',
      trigger: 'quality_loop_exhausted',
    });
    mockReconcile.mockReturnValue('medium');

    const inputWithEscalation = {
      ...baseInput,
      config: {
        ...baseInput.config,
        escalation: {
          mode: 'channel' as const,
          channelId: 'C-ESCALATION',
          timeoutHours: 4,
        },
      },
    };

    await runPipeline(inputWithEscalation);

    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect(mockBuildCaveat).toHaveBeenCalledWith('Uncertain about join logic');
    expect(mockSaveCtx).toHaveBeenCalledTimes(1);
    expect(mockSaveEscalation).toHaveBeenCalledWith(
      expect.objectContaining({
        behavior: 'best_effort_verify',
        originalThreadTs: 'thread-1',
      }),
      4,
    );
    expect(mockClient.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'C-ESCALATION' }),
    );
  });

  it('exhausted without escalation config: aborts with error message', async () => {
    mockQualityLoop.mockResolvedValue({
      ...baseQualityResult,
      verdict: 'exhausted',
      finalConfidence: 'low',
      supervisorNotes: 'Could not approve',
      failureHistory: [{ attempt: 0, failureType: 'semantic', detail: 'Bad' }],
    });
    mockDecideEscalation.mockReturnValue({
      shouldEscalate: true,
      behavior: 'park_wait',
      trigger: 'quality_loop_exhausted',
    });

    await runPipeline(baseInput);

    // No escalation channel → no park_wait, falls through to abort
    expect(mockSaveEscalation).not.toHaveBeenCalled();
    expect(mockExecute).not.toHaveBeenCalled();
    expect(mockSaveCtx).not.toHaveBeenCalled();
    const updateCalls = mockClient.chat.update.mock.calls;
    const finalUpdate = updateCalls[updateCalls.length - 1][0];
    expect(finalUpdate.text).toContain('wasn\'t able to generate');
    expect(mockReleaseLock).toHaveBeenCalledTimes(1);
  });

  it('passes failureHistory to decideEscalation', async () => {
    const failureHistory = [
      { attempt: 0, failureType: 'structural' as const, detail: 'DML' },
      { attempt: 1, failureType: 'dry_run' as const, detail: 'Table not found' },
    ];
    mockQualityLoop.mockResolvedValue({
      ...baseQualityResult,
      verdict: 'exhausted',
      failureHistory,
    });

    await runPipeline(baseInput);

    expect(mockDecideEscalation).toHaveBeenCalledWith(
      'exhausted',
      baseQualityResult.sqlResult.confidence,
      failureHistory,
    );
  });

  it('persists failureHistory in ResponseContext', async () => {
    const failureHistory = [
      { attempt: 0, failureType: 'semantic' as const, detail: 'Missing filter' },
    ];
    mockQualityLoop.mockResolvedValue({
      ...baseQualityResult,
      verdict: 'fail_then_pass',
      failureHistory,
    });

    await runPipeline(baseInput);

    expect(mockSaveCtx).toHaveBeenCalledWith(
      expect.objectContaining({ failureHistory }),
    );
  });

  it('passes status callbacks to qualityLoop', async () => {
    await runPipeline(baseInput);

    const callbacksArg = mockQualityLoop.mock.calls[0][4];
    expect(callbacksArg).toBeDefined();
    expect(callbacksArg!.onGenerate).toBeDefined();
    expect(callbacksArg!.onValidate).toBeDefined();
    expect(callbacksArg!.onReview).toBeDefined();
    expect(callbacksArg!.onRetry).toBeDefined();
  });
});
