import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/validation/pipeline.js');
import { validateSql } from '../src/validation/pipeline.js';

// Mock all domain modules
vi.mock('../src/agents/clarificationAgent.js');
vi.mock('../src/agents/ambiguityClassifier.js');
vi.mock('../src/qualityLoop.js');
vi.mock('../src/routineFastPath.js');
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

import { runPipeline, buildResponseBlocks, mergeAssumptions } from '../src/pipeline.js';
import { classifyQuestion } from '../src/agents/clarificationAgent.js';
import { classifyAmbiguity } from '../src/agents/ambiguityClassifier.js';
import { qualityLoop } from '../src/qualityLoop.js';
import { runRoutineFastPath } from '../src/routineFastPath.js';
import { reconcileConfidence } from '../src/agents/confidence.js';
import { executeQuery } from '../src/execution/runner.js';
import { chooseFormat } from '../src/execution/formatter.js';
import { buildThreadContext } from '../src/slack/threadContext.js';
import { saveResponseContext, getLatestNegativeFeedback } from '../src/state/responseContext.js';
import { saveClarificationState } from '../src/state/clarificationState.js';
import { releaseThreadLock } from '../src/state/threadLock.js';
import { getTeachingSummaries } from '../src/teachings/summaryMap.js';
import { getSampleRows } from '../src/dbt/sampleRowCache.js';
import { buildSingleValueBlocks, buildFeedbackActions, buildAssumptionBlocks, buildZeroRowBlocks, formatValue } from '../src/slack/blocks.js';
import { BigQuery } from '@google-cloud/bigquery';
import { buildClarificationBlocks } from '../src/slack/clarificationBlocks.js';
import { decideEscalation } from '../src/agents/escalationDecision.js';
import { saveEscalationState } from '../src/state/escalationState.js';
import { buildEscalationBlocks, buildUserWaitingBlocks, buildBestEffortCaveatBlocks } from '../src/slack/escalationBlocks.js';
import type { QualityResult } from '../src/qualityLoop.js';

const mockClassify = vi.mocked(classifyQuestion);
const mockClassifyAmbiguity = vi.mocked(classifyAmbiguity);
const mockQualityLoop = vi.mocked(qualityLoop);
const mockRunRoutineFastPath = vi.mocked(runRoutineFastPath);
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
  ownerToken: 'lease-1',
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
  mockRunRoutineFastPath.mockResolvedValue({
    kind: 'ineligible',
    ineligibleReasons: ['fast_path_disabled'],
  });
  mockClassify.mockResolvedValue(highClarification);
  mockClassifyAmbiguity.mockResolvedValue({
    type: 'user_intent',
    question: 'Which time period?',
    domain: 'revenue',
    reasoning: 'User must choose the request scope.',
  });
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
    vi.mocked(validateSql).mockResolvedValue({ valid: true, layer: 'all' });
    setupHappyPath();
  });

  it('happy path: HIGH confidence end-to-end', async () => {
    await runPipeline(baseInput);

    expect(mockClassify).toHaveBeenCalledTimes(1);
    expect(mockQualityLoop).toHaveBeenCalledTimes(1);
    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect(mockSaveCtx).toHaveBeenCalledTimes(1);
    expect(mockReleaseLock).toHaveBeenCalledTimes(1);
    expect(mockReleaseLock).toHaveBeenCalledWith('C123', 'thread-1', 'lease-1');
  });

  it('does not release the thread lock when no lease token was passed (resume paths)', async () => {
    const { ownerToken: _ownerToken, ...resumeInput } = baseInput;
    await runPipeline(resumeInput);
    expect(mockReleaseLock).not.toHaveBeenCalled();
  });

  it('generates against the clarification but keeps the original wording for review (#44)', async () => {
    await runPipeline(baseInput);

    const call = mockQualityLoop.mock.calls[0];
    expect(call[0].question).toBe('What is total revenue from all orders?');
    expect(call[2]).toBe('What is total revenue from all orders?');
    expect(call[5]).toBe('What is total revenue?');
  });

  it('reviews against input.originalQuestion when a resume supplies one (#44)', async () => {
    await runPipeline({ ...baseInput, originalQuestion: 'What is paid revenue? (Data team guidance: x)' });

    expect(mockQualityLoop.mock.calls[0][5]).toBe('What is paid revenue? (Data team guidance: x)');
    // Persisted so a later refinement reviews against the same wording.
    expect(mockSaveCtx).toHaveBeenCalledWith(expect.objectContaining({
      userQuestion: 'What is paid revenue? (Data team guidance: x)',
    }));
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

  it('shows and saves assumptions from both clarification and SQL generation (#45)', async () => {
    mockClassify.mockResolvedValue({
      ...highClarification,
      assumptions: ['Assuming this calendar month', 'Assuming USD'],
    });
    mockQualityLoop.mockResolvedValue({
      ...baseQualityResult,
      sqlResult: {
        ...baseQualityResult.sqlResult,
        assumptions: ['Assuming USD', 'Excluding test accounts'],
      },
    });

    await runPipeline(baseInput);

    const merged = ['Assuming this calendar month', 'Assuming USD', 'Excluding test accounts'];
    expect(mockBuildAssumptions).toHaveBeenCalledWith(merged, expect.any(String));
    expect(mockSaveCtx).toHaveBeenCalledWith(expect.objectContaining({ assumptions: merged }));
  });

  it('LOW confidence: suspends pipeline, posts clarification', async () => {
    mockClassify.mockResolvedValue({
      ...highClarification,
      confidence: 'low',
      clarifying_questions: ['Which time period?', 'Which product line?'],
      ambiguities: ['time period unclear', 'product scope unclear'],
    });

    await runPipeline(baseInput);

    expect(mockClassifyAmbiguity).toHaveBeenCalledWith(
      {
        question: 'What is total revenue?',
        ambiguities: ['time period unclear', 'product scope unclear'],
        clarifyingQuestions: ['Which time period?', 'Which product line?'],
        threadContext: [],
      },
      'key',
    );
    expect(mockQualityLoop).not.toHaveBeenCalled();
    expect(mockExecute).not.toHaveBeenCalled();
    expect(mockSaveClarification).toHaveBeenCalledWith(expect.objectContaining({
      ambiguityType: 'user_intent',
      ambiguityDomain: 'revenue',
    }));
    expect(mockReleaseLock).toHaveBeenCalledTimes(1);
  });

  it("LOW confidence: keeps the user's wording in clarification state on a refinement (#44)", async () => {
    mockClassify.mockResolvedValue({ ...highClarification, confidence: 'low', clarifying_questions: ['Which period?'], ambiguities: ['period'] });

    await runPipeline({ ...baseInput, originalQuestion: 'What is paid revenue? (Refinement: only EMEA)' });
    expect(mockSaveClarification.mock.calls[0][0]).toMatchObject({
      originalQuestion: baseInput.question,
      supervisorQuestion: 'What is paid revenue? (Refinement: only EMEA)',
    });

    // No rewrite: nothing extra stored (Firestore rejects undefined fields).
    await runPipeline(baseInput);
    expect(mockSaveClarification.mock.calls[1][0]).not.toHaveProperty('supervisorQuestion');
  });

  it('LOW confidence: scopes the clarification id to the conversation', async () => {
    mockClassify.mockResolvedValue({ ...highClarification, confidence: 'low', clarifying_questions: ['Which period?'], ambiguities: ['period'] });

    await runPipeline({ ...baseInput, channel: 'C_ONE' });
    await runPipeline({ ...baseInput, channel: 'C_TWO' });

    const ids = mockSaveClarification.mock.calls.map(([state]) => state.clarificationId);
    expect(ids).toEqual([`clarify_C_ONE:${baseInput.threadTs}`, `clarify_C_TWO:${baseInput.threadTs}`]);
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

  it('keeps the posted answer when context persistence fails', async () => {
    mockSaveCtx.mockRejectedValueOnce(new Error('write failed'));
    await runPipeline(baseInput);
    const updates = mockClient.chat.update.mock.calls;
    expect(updates.at(-1)![0].text).toBe(baseQualityResult.sqlResult.explanation);
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
    // Opens on the clarification decision phase and progresses to data retrieval —
    // proving status advances across stages, not just the first one.
    expect(updateCalls.some((t: string) => t?.includes('Thinking about if I need clarification'))).toBe(true);
    expect(updateCalls.some((t: string) => t?.includes('Retrieving the data'))).toBe(true);
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

  it.each(['L3-dryrun', 'L4-cost'] as const)('blocks best effort when %s fails', async (layer) => {
    mockQualityLoop.mockResolvedValue({ ...baseQualityResult, verdict: 'exhausted' });
    mockDecideEscalation.mockReturnValue({ shouldEscalate: true, behavior: 'best_effort_verify', trigger: 'quality_loop_exhausted' });
    vi.mocked(validateSql).mockResolvedValue({ valid: false, layer, bytesProcessed: baseInput.config.maxBytesProcessed * 2, error: 'Try narrowing with a date filter.' });
    await runPipeline({ ...baseInput, config: { ...baseInput.config, escalation: { mode: 'channel', channelId: 'C-ESCALATION', timeoutHours: 4 } } });
    expect(validateSql).toHaveBeenCalledWith(baseQualityResult.sqlResult.sql, baseInput.config.maxBytesProcessed);
    expect(mockExecute).not.toHaveBeenCalled();
    if (layer === 'L4-cost') expect(mockClient.chat.update).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('Try narrowing with a date range or specific filter') }),
    );
  });

  it("escalation state keeps the user's wording on a refinement (#44)", async () => {
    mockQualityLoop.mockResolvedValue({ ...baseQualityResult, verdict: 'exhausted' });
    mockDecideEscalation.mockReturnValue({ shouldEscalate: true, behavior: 'park_wait', trigger: 'quality_loop_exhausted' });
    await runPipeline({
      ...baseInput,
      question: 'What is revenue? (Refinement: last week)',
      originalQuestion: 'What is paid revenue? (Refinement: last week)',
      config: { ...baseInput.config, escalation: { mode: 'channel', channelId: 'C-ESCALATION', timeoutHours: 4 } },
    });

    expect(mockSaveEscalation).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({
          userQuestion: 'What is paid revenue? (Refinement: last week)',
        }),
      }),
      4,
    );
    expect(mockBuildEscalationBlocks).toHaveBeenCalledWith(
      expect.objectContaining({ userQuestion: 'What is paid revenue? (Refinement: last week)' }),
    );
    expect(mockClient.chat.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      text: 'Anna Lytics needs help with: "What is paid revenue? (Refinement: last week)"',
    }));
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
    // Overrides recover the verification warning from this verdict (#47).
    expect(mockSaveCtx).toHaveBeenCalledWith(expect.objectContaining({ supervisorVerdict: 'exhausted' }));
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

  it('does not call routine fast path when disabled', async () => {
    await runPipeline(baseInput);

    expect(mockRunRoutineFastPath).not.toHaveBeenCalled();
    expect(mockQualityLoop).toHaveBeenCalledTimes(1);
  });

  it('uses routine fast path when enabled and complete', async () => {
    mockRunRoutineFastPath.mockResolvedValue({
      kind: 'complete',
      quality: baseQualityResult,
      supervisorDecision: 'skipped',
      supervisorTriggers: [],
      ineligibleReasons: [],
    });

    await runPipeline({
      ...baseInput,
      config: {
        ...baseInput.config,
        fastPath: {
          enabled: true,
          maxBytesProcessed: 1_073_741_824,
          requireSupervisor: false,
        },
      },
    });

    expect(mockRunRoutineFastPath).toHaveBeenCalledTimes(1);
    expect(mockQualityLoop).not.toHaveBeenCalled();
    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect(mockSaveCtx).toHaveBeenCalledWith(expect.objectContaining({
      pipelineMode: 'routine_fast_path',
      supervisorDecision: 'skipped',
      supervisorTriggers: [],
    }));
  });

  it('falls back to qualityLoop when routine fast path requests fallback', async () => {
    mockRunRoutineFastPath.mockResolvedValue({
      kind: 'fallback',
      reasons: ['missing_grounding_citation'],
      previousAttempt: {
        sql: 'SELECT bad FROM `analytics.fct_orders`',
        error: 'missing grounding',
      },
      failureHistory: [],
      validationHistory: [],
      sqlResult: baseQualityResult.sqlResult,
      bytesProcessed: 100,
    });

    await runPipeline({
      ...baseInput,
      config: {
        ...baseInput.config,
        fastPath: {
          enabled: true,
          maxBytesProcessed: 1_073_741_824,
          requireSupervisor: false,
        },
      },
    });

    expect(mockQualityLoop).toHaveBeenCalledTimes(1);
    expect(mockQualityLoop.mock.calls[0][0].previousAttempt).toEqual({
      sql: 'SELECT bad FROM `analytics.fct_orders`',
      error: 'missing grounding',
    });
    expect(mockSaveCtx).toHaveBeenCalledWith(expect.objectContaining({
      pipelineMode: 'full_quality_loop',
      fastPathIneligibleReasons: ['missing_grounding_citation'],
    }));
  });
});

describe('mergeAssumptions', () => {
  it('keeps first-seen order and drops blanks and exact duplicates', () => {
    expect(mergeAssumptions(['a', '', 'b'], ['b', 'c', 'a'])).toEqual(['a', 'b', 'c']);
  });
});

describe('buildResponseBlocks', () => {
  // blocks.js is module-mocked for the runPipeline suite above; this unit test
  // verifies the real block ORDER, so route the builders to their actual
  // implementations for the duration of these cases.
  beforeEach(async () => {
    const actual = await vi.importActual<typeof import('../src/slack/blocks.js')>(
      '../src/slack/blocks.js',
    );
    mockBuildSingleValue.mockImplementation(actual.buildSingleValueBlocks);
    mockBuildAssumptions.mockImplementation(actual.buildAssumptionBlocks);
    mockBuildFeedback.mockImplementation(actual.buildFeedbackActions);
    vi.mocked(formatValue).mockImplementation(actual.formatValue);
  });

  it('zero_rows: lists generator assumptions once, as the filters applied (#45)', async () => {
    const actual = await vi.importActual<typeof import('../src/slack/blocks.js')>('../src/slack/blocks.js');
    vi.mocked(buildZeroRowBlocks).mockImplementation(actual.buildZeroRowBlocks);
    const blocks = buildResponseBlocks(
      'zero_rows',
      { headline: 'h', explanation: 'e', assumptions: ['Excluding test accounts', 'Excluding test accounts'] } as any,
      { rows: [], columnNames: [], totalRows: 0 } as any,
      'trace-1', 'T1', 'S1', ['Assuming USD', 'Excluding test accounts'],
    );
    const text = JSON.stringify(blocks);
    expect(text.match(/Excluding test accounts/g)).toHaveLength(1);
    expect(text).toContain('Filters applied:* Excluding test accounts');
    expect(text).toContain('Assumptions:* Assuming USD');
  });

  it('single_value: answer first, then assumptions, then feedback actions', () => {
    const blocks = buildResponseBlocks(
      'single_value',
      { headline: 'unique visitors this month', explanation: 'verbose', assumptions: ['a'] } as any,
      { rows: [{ n: 90 }], columnNames: ['n'], totalRows: 1 } as any,
      'trace-1', 'T1', 'S1', ['Assumed X'],
    );
    const types = blocks.map((b) => b.type);
    expect(types[0]).toBe('section');
    const assumptionIdx = blocks.findIndex((b) => b.type === 'context');
    const feedbackIdx = blocks.map((b) => b.type).lastIndexOf('actions');
    expect(assumptionIdx).toBeGreaterThan(0); // assumptions after the answer
    expect(feedbackIdx).toBeGreaterThan(assumptionIdx); // feedback is last
    expect((blocks[0] as any).text.text).toBe('*90*\nunique visitors this month');
  });

  it('single_value: formats a BigQuery DATE wrapper like table cells (#34)', () => {
    const blocks = buildResponseBlocks(
      'single_value',
      { headline: 'first order date', explanation: '', assumptions: [] } as any,
      { rows: [{ d: BigQuery.date('2026-11-01') }], columnNames: ['d'], totalRows: 1 } as any,
      'trace-1', 'T1', 'S1', [],
    );
    expect((blocks[0] as any).text.text).toBe('*2026-11-01*\nfirst order date');
  });

  it('single_value: shows a dash for an empty cell (#34)', () => {
    const blocks = buildResponseBlocks(
      'single_value',
      { headline: 'latest refund', explanation: '', assumptions: [] } as any,
      { rows: [{ d: null }], columnNames: ['d'], totalRows: 1 } as any,
      'trace-1', 'T1', 'S1', [],
    );
    expect((blocks[0] as any).text.text).toBe('*—*\nlatest refund');
  });
});
