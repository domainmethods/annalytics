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
import { decideEscalation } from '../src/agents/escalationDecision.js';
import { saveEscalationState } from '../src/state/escalationState.js';
import { buildEscalationBlocks, buildUserWaitingBlocks, buildBestEffortCaveatBlocks } from '../src/slack/escalationBlocks.js';

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

  it('park_wait escalation: no execution, state saved, user notified', async () => {
    mockSupervise.mockResolvedValue({
      ...baseSupervisedResult,
      verdict: 'exhausted',
      sqlResult: { ...baseSupervisedResult.sqlResult, confidence: 'low' },
      finalConfidence: 'low',
      supervisorNotes: 'Could not approve after 3 attempts',
    });
    mockDecideEscalation.mockReturnValue({
      shouldEscalate: true,
      behavior: 'park_wait',
      trigger: 'supervisor_exhausted',
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

    // Should NOT execute query
    expect(mockExecute).not.toHaveBeenCalled();
    // Should update status with waiting message
    expect(mockClient.chat.update).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('data team'),
      }),
    );
    // Should post to escalation channel
    expect(mockClient.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'C-ESCALATION' }),
    );
    // Should save escalation state
    expect(mockSaveEscalation).toHaveBeenCalledWith(
      expect.objectContaining({
        behavior: 'park_wait',
        originalThreadTs: 'thread-1',
        escalationChannel: 'C-ESCALATION',
      }),
      4,
    );
    // Should still release lock (via finally)
    expect(mockReleaseLock).toHaveBeenCalledTimes(1);
  });

  it('best_effort_verify escalation: execution happens, caveat shown, state saved', async () => {
    mockSupervise.mockResolvedValue({
      ...baseSupervisedResult,
      verdict: 'exhausted',
      sqlResult: { ...baseSupervisedResult.sqlResult, confidence: 'medium' },
      finalConfidence: 'medium',
      supervisorNotes: 'Uncertain about join logic',
    });
    mockDecideEscalation.mockReturnValue({
      shouldEscalate: true,
      behavior: 'best_effort_verify',
      trigger: 'supervisor_exhausted',
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

    // Should execute query (best effort)
    expect(mockExecute).toHaveBeenCalledTimes(1);
    // Should show caveat blocks
    expect(mockBuildCaveat).toHaveBeenCalledWith('Uncertain about join logic');
    // Should save response context
    expect(mockSaveCtx).toHaveBeenCalledTimes(1);
    // Should save escalation state with best_effort_verify
    expect(mockSaveEscalation).toHaveBeenCalledWith(
      expect.objectContaining({
        behavior: 'best_effort_verify',
        originalThreadTs: 'thread-1',
      }),
      4,
    );
    // Should post to escalation channel
    expect(mockClient.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'C-ESCALATION' }),
    );
  });

  it('escalation without channelId configured: falls through to normal flow', async () => {
    mockSupervise.mockResolvedValue({
      ...baseSupervisedResult,
      verdict: 'exhausted',
      sqlResult: { ...baseSupervisedResult.sqlResult, confidence: 'low' },
      finalConfidence: 'low',
      supervisorNotes: 'Could not approve',
    });
    mockDecideEscalation.mockReturnValue({
      shouldEscalate: true,
      behavior: 'park_wait',
      trigger: 'supervisor_exhausted',
    });
    mockReconcile.mockReturnValue('low');

    // No escalation config (or no channelId) — use baseInput which has no escalation
    await runPipeline(baseInput);

    // Should NOT post waiting message or escalation
    expect(mockSaveEscalation).not.toHaveBeenCalled();
    // Should fall through to execution (no park_wait without channel)
    expect(mockExecute).toHaveBeenCalledTimes(1);
    // Should NOT show caveat (best_effort_verify also gated on channelId)
    expect(mockBuildCaveat).not.toHaveBeenCalled();
    // Should still save response context normally
    expect(mockSaveCtx).toHaveBeenCalledTimes(1);
  });
});
