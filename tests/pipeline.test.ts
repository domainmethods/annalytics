import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../src/validation/pipeline.js');
import { validateSql } from '../src/validation/pipeline.js';

// Mock all domain modules
vi.mock('../src/agents/clarificationAgent.js');
vi.mock('../src/agents/ambiguityClassifier.js');
vi.mock('../src/agents/followUpClassifier.js');
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
const mockLogger = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() }));
vi.mock('../src/logging.js', () => ({
  createTraceId: () => 'trace-abc',
  createLogger: () => mockLogger,
  logStage: vi.fn(),
}));
// Real verifier by default; one case forces a throw to prove it never breaks an answer.
vi.mock('../src/execution/composition.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/execution/composition.js')>();
  return { ...actual, verifyComposition: vi.fn(actual.verifyComposition) };
});

import { runPipeline, buildResponseBlocks, mergeAssumptions, toPipelineConfig } from '../src/pipeline.js';
import { verifyComposition } from '../src/execution/composition.js';
import { classifyQuestion } from '../src/agents/clarificationAgent.js';
import { classifyAmbiguity } from '../src/agents/ambiguityClassifier.js';
import { classifyFollowUp } from '../src/agents/followUpClassifier.js';
import { qualityLoop } from '../src/qualityLoop.js';
import { runRoutineFastPath } from '../src/routineFastPath.js';
import { reconcileConfidence } from '../src/agents/confidence.js';
import { executeQuery } from '../src/execution/runner.js';
import { chooseFormat } from '../src/execution/formatter.js';
import { buildThreadContext } from '../src/slack/threadContext.js';
import { saveResponseContext, getLatestNegativeFeedback } from '../src/state/responseContext.js';
import { recordAmbiguityLabel, saveClarificationState } from '../src/state/clarificationState.js';
import { releaseThreadLock } from '../src/state/threadLock.js';
import { getTeachingSummaries } from '../src/teachings/summaryMap.js';
import { getSampleRows } from '../src/dbt/sampleRowCache.js';
import { buildSingleValueBlocks, buildFeedbackActions, buildAssumptionBlocks, buildZeroRowBlocks, formatValue, overrideButtonsForResultShape, buildTableBlocks, buildTruncatedBlocks } from '../src/slack/blocks.js';
import { BigQuery } from '@google-cloud/bigquery';
import { buildClarificationBlocks } from '../src/slack/clarificationBlocks.js';
import { decideEscalation } from '../src/agents/escalationDecision.js';
import { saveEscalationState } from '../src/state/escalationState.js';
import { buildEscalationBlocks, buildUserWaitingBlocks, buildBestEffortCaveatBlocks } from '../src/slack/escalationBlocks.js';
import type { QualityResult } from '../src/qualityLoop.js';

const mockClassify = vi.mocked(classifyQuestion);
const mockClassifyAmbiguity = vi.mocked(classifyAmbiguity);
const mockClassifyFollowUp = vi.mocked(classifyFollowUp);
const mockQualityLoop = vi.mocked(qualityLoop);
const mockRunRoutineFastPath = vi.mocked(runRoutineFastPath);
const mockReconcile = vi.mocked(reconcileConfidence);
const mockExecute = vi.mocked(executeQuery);
const mockFormat = vi.mocked(chooseFormat);
const mockBuildThread = vi.mocked(buildThreadContext);
const mockSaveCtx = vi.mocked(saveResponseContext);
const mockGetNegative = vi.mocked(getLatestNegativeFeedback);
const mockSaveClarification = vi.mocked(saveClarificationState);
const mockRecordAmbiguity = vi.mocked(recordAmbiguityLabel);
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
  mockClassifyFollowUp.mockResolvedValue({ intent: 'new_query', reasoning: 'Unrelated question' });
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

  it('treats a failed sample read as a missing sample and still answers (#68)', async () => {
    const table = (name: string) => ({
      name, schema: 'analytics', description: '', materialization: 'table',
      columns: [], sampleDDL: '', dependsOn: [], tags: [],
    });
    const tables = [table('analytics.fct_orders'), table('analytics.dim_customers')];
    const sample = { rows: [{ id: 1 }], stale: false };
    mockGetSampleRows.mockImplementation(async (name: string) => {
      if (name === 'analytics.fct_orders') throw new Error('firestore unavailable');
      return sample;
    });

    await runPipeline({ ...baseInput, tables });

    expect(mockQualityLoop).toHaveBeenCalledTimes(1);
    const sampleRows = mockQualityLoop.mock.calls[0][0].sampleRows;
    expect(sampleRows).toEqual(new Map([['analytics.dim_customers', sample]]));
    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect(mockSaveCtx).toHaveBeenCalledTimes(1);
  });

  it('still answers when the negative-feedback read fails (#68)', async () => {
    mockGetNegative.mockRejectedValue(new Error('firestore unavailable'));

    await runPipeline(baseInput);

    expect(mockQualityLoop).toHaveBeenCalledTimes(1);
    expect(mockQualityLoop.mock.calls[0][0].negativeExample).toBeUndefined();
    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect(mockSaveCtx).toHaveBeenCalledTimes(1);
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

  it('does not persist the generator headline (no table caption reads it)', async () => {
    mockQualityLoop.mockResolvedValue({ ...baseQualityResult, sqlResult: { ...baseQualityResult.sqlResult, headline: 'Revenue by region' } } as any);
    await runPipeline(baseInput);
    expect(Object.keys(mockSaveCtx.mock.calls[0][0])).not.toContain('headline');
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
    expect(mockSaveClarification.mock.calls[0][0]).not.toHaveProperty('ambiguityType');
    // Kept so the message can be redrawn without its cancel button once answered.
    expect(mockSaveClarification.mock.calls[0][0]).toMatchObject({
      clarifyingQuestions: ['Which time period?', 'Which product line?'],
    });
    await vi.waitFor(() => expect(mockRecordAmbiguity).toHaveBeenCalledWith(
      'clarify_C123:thread-1', 'status-1',
      { ambiguityType: 'user_intent', ambiguityDomain: 'revenue', ambiguityQuestion: 'Which time period?' },
    ));
    expect(mockReleaseLock).toHaveBeenCalledTimes(1);
  });

  it('LOW confidence: posts and saves the clarification without waiting for the ambiguity label', async () => {
    mockClassify.mockResolvedValue({ ...highClarification, confidence: 'low', clarifying_questions: ['Which period?'], ambiguities: ['period'] });
    mockClassifyAmbiguity.mockReturnValue(new Promise(() => {}));

    await runPipeline(baseInput);

    expect(mockClient.chat.update).toHaveBeenCalledWith(expect.objectContaining({ ts: 'status-1', text: 'Which period?' }));
    expect(mockSaveClarification).toHaveBeenCalledTimes(1);
    expect(mockReleaseLock).toHaveBeenCalledTimes(1);
    expect(mockRecordAmbiguity).not.toHaveBeenCalled();
  });

  it('LOW confidence: a failed ambiguity label write does not affect the clarification', async () => {
    mockClassify.mockResolvedValue({ ...highClarification, confidence: 'low', clarifying_questions: ['Which period?'], ambiguities: ['period'] });
    mockRecordAmbiguity.mockRejectedValueOnce(new Error('firestore down'));

    await expect(runPipeline(baseInput)).resolves.toBeUndefined();
    await vi.waitFor(() => expect(mockRecordAmbiguity).toHaveBeenCalledTimes(1));
    expect(mockSaveClarification).toHaveBeenCalledTimes(1);
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

  it('leaves follow-up intent classification to the routing step before it', async () => {
    mockBuildThread.mockReturnValue([{ role: 'user', content: 'What is total revenue?' }]);

    await runPipeline(baseInput);

    expect(mockClassifyFollowUp).not.toHaveBeenCalled();
    expect(mockExecute).toHaveBeenCalledTimes(1);
  });

  it('pipeline failure: replaces the status with an error that carries the trace id', async () => {
    mockQualityLoop.mockRejectedValue(new Error('model unavailable'));

    await runPipeline(baseInput);

    const lastUpdate = mockClient.chat.update.mock.calls.at(-1)![0];
    expect(lastUpdate.ts).toBe('status-1');
    expect(lastUpdate.text).toContain('trace-abc');
    expect(mockExecute).not.toHaveBeenCalled();
    expect(mockReleaseLock).toHaveBeenCalledTimes(1);
  });

  it('pipeline failure: settles and releases the lock when Slack rejects the error message too', async () => {
    mockQualityLoop.mockRejectedValue(new Error('model unavailable'));
    mockClient.chat.update.mockRejectedValue(new Error('cant_update_message'));

    await expect(runPipeline(baseInput)).resolves.toBeUndefined();

    expect(mockReleaseLock).toHaveBeenCalledTimes(1);
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

  it("uses the user's own wording as the negative example's feedback, not the thread context", async () => {
    mockGetNegative.mockResolvedValue({
      sql: 'SELECT bad FROM table',
      explanation: 'Wrong approach',
      tablesUsed: ['table'],
    });
    // The context now ends with the bot's previous answer, not the user's message.
    mockBuildThread.mockReturnValue([
      { role: 'user', content: 'What is revenue?' },
      { role: 'assistant', content: 'Revenue is $5M' },
    ]);

    await runPipeline({
      ...baseInput,
      question: 'What is revenue? (Refinement: exclude refunds)',
      originalQuestion: 'whats revenue (Refinement: exclude refunds)',
    });

    expect(mockQualityLoop.mock.calls[0][0].negativeExample!.userFeedback)
      .toBe('whats revenue (Refinement: exclude refunds)');
  });

  it('leaves its own status message out of the thread context', async () => {
    const threadMessages = [
      { ts: 'thread-1', text: 'What is total revenue?' },
      { ts: 'status-1', bot_id: 'B1', text: 'Got it. Let me get things ready...' },
    ];
    mockClient.conversations.replies.mockResolvedValue({ messages: threadMessages });

    await runPipeline(baseInput);

    expect(mockBuildThread).toHaveBeenCalledWith(
      threadMessages,
      4,
      expect.objectContaining({ excludeTs: 'status-1' }),
    );
  });

  it('progressive status updates at correct stages', async () => {
    await runPipeline(baseInput);

    const updateCalls = mockClient.chat.update.mock.calls.map(c => c[0].text);
    // Opens by saying the question is being read and progresses to data retrieval —
    // proving status advances across stages, not just the first one.
    expect(updateCalls[0]).toBe('Reading your question...');
    expect(updateCalls).toContain('Retrieving the data...');
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

  describe('status while working', () => {
    const statusTexts = () => mockClient.chat.update.mock.calls.map((c) => c[0].text as string);
    const answerUpdates = () => mockClient.chat.update.mock.calls.filter((c) => c[0].blocks);
    const wait = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });
    const fastPathConfig = {
      ...baseInput.config,
      fastPath: { enabled: true, maxBytesProcessed: 1_073_741_824, requireSupervisor: false },
    };

    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('shows the elapsed time while generation is slow', async () => {
      mockQualityLoop.mockImplementation(async (_options, _key, _question, _maxBytes, callbacks) => {
        await callbacks?.onGenerate?.();
        await wait(25_000);
        return baseQualityResult;
      });

      const run = runPipeline(baseInput);
      await vi.advanceTimersByTimeAsync(25_000);
      await run;

      expect(statusTexts()).toEqual(expect.arrayContaining([
        'Researching the best approach...',
        'Researching the best approach... (10s)',
        'Researching the best approach... (20s)',
      ]));
    });

    it('shows the elapsed time while the query is slow', async () => {
      mockExecute.mockImplementation(async () => {
        await wait(25_000);
        return { rows: [{ total: 5000000 }], columnNames: ['total'], totalRows: 1, bytesProcessed: 100, truncated: false };
      });

      const run = runPipeline(baseInput);
      await vi.advanceTimersByTimeAsync(25_000);
      await run;

      expect(statusTexts()).toEqual(expect.arrayContaining([
        'Retrieving the data...',
        'Retrieving the data... (10s)',
        'Retrieving the data... (20s)',
      ]));
    });

    it('shows a status and the elapsed time while the routine fast path runs', async () => {
      mockRunRoutineFastPath.mockImplementation(async () => {
        await wait(15_000);
        return {
          kind: 'complete',
          quality: baseQualityResult,
          supervisorDecision: 'skipped',
          supervisorTriggers: [],
          ineligibleReasons: [],
        };
      });

      const run = runPipeline({ ...baseInput, config: fastPathConfig });
      await vi.advanceTimersByTimeAsync(15_000);
      await run;

      expect(statusTexts()).toEqual(expect.arrayContaining([
        'Researching the best approach...',
        'Researching the best approach... (10s)',
      ]));
    });

    it('keeps the elapsed time when the query step starts after a slow generation', async () => {
      mockQualityLoop.mockImplementation(async (_options, _key, _question, _maxBytes, callbacks) => {
        await callbacks?.onGenerate?.();
        await wait(25_000);
        return baseQualityResult;
      });

      const run = runPipeline(baseInput);
      await vi.advanceTimersByTimeAsync(25_000);
      await run;

      const retrieving = statusTexts().filter((text) => text.startsWith('Retrieving the data...'));
      expect(retrieving).toEqual(['Retrieving the data... (20s)']);
    });

    it('keeps the elapsed time when the routine fast path starts after a slow clarification', async () => {
      mockClassify.mockImplementation(async () => {
        await wait(12_000);
        return highClarification;
      });

      const run = runPipeline({ ...baseInput, config: fastPathConfig });
      await vi.advanceTimersByTimeAsync(12_000);
      await run;

      const researching = statusTexts().filter((text) => text.startsWith('Researching the best approach...'));
      expect(researching[0]).toBe('Researching the best approach... (10s)');
    });

    it('says which attempt it is on once the first attempt has been rejected', async () => {
      mockQualityLoop.mockImplementation(async (_options, _key, _question, _maxBytes, callbacks) => {
        await callbacks?.onGenerate?.();
        await callbacks?.onValidate?.();
        await callbacks?.onReview?.();
        await callbacks?.onRetry?.(1);
        await callbacks?.onGenerate?.();
        await callbacks?.onValidate?.();
        await callbacks?.onReview?.();
        return baseQualityResult;
      });

      await runPipeline(baseInput);

      const texts = statusTexts();
      const firstAttempt = [
        'Researching the best approach...',
        'Verifying the approach...',
        'Reviewing for accuracy...',
      ];
      const secondAttempt = [
        'Attempt 2 of 3: researching the best approach...',
        'Attempt 2 of 3: verifying the approach...',
        'Attempt 2 of 3: reviewing for accuracy...',
      ];
      const start = texts.indexOf(firstAttempt[0]);
      expect(texts.slice(start, start + 6)).toEqual([...firstAttempt, ...secondAttempt]);
    });

    it('leaves the answer alone once it is delivered', async () => {
      mockQualityLoop.mockImplementation(async (_options, _key, _question, _maxBytes, callbacks) => {
        await callbacks?.onGenerate?.();
        await wait(25_000);
        return baseQualityResult;
      });
      mockExecute.mockImplementation(async () => {
        await wait(25_000);
        return { rows: [{ total: 5000000 }], columnNames: ['total'], totalRows: 1, bytesProcessed: 100, truncated: false };
      });

      const run = runPipeline(baseInput);
      await vi.advanceTimersByTimeAsync(50_000);
      await run;
      const updatesAtDelivery = mockClient.chat.update.mock.calls.length;
      await vi.advanceTimersByTimeAsync(120_000);

      expect(mockClient.chat.update).toHaveBeenCalledTimes(updatesAtDelivery);
      expect(mockClient.chat.update.mock.calls.at(-1)![0].blocks).toBeDefined();
    });

    it('delivers the answer only after a status rewrite still in flight has finished', async () => {
      let finishRewrite!: () => void;
      mockClient.chat.update.mockImplementation((args: { text?: string }) => (
        args.text === 'Retrieving the data... (10s)'
          ? new Promise((resolve) => { finishRewrite = () => resolve({}); })
          : Promise.resolve({})
      ));
      mockExecute.mockImplementation(async () => {
        await wait(10_500);
        return { rows: [{ total: 5000000 }], columnNames: ['total'], totalRows: 1, bytesProcessed: 100, truncated: false };
      });

      const run = runPipeline(baseInput);
      await vi.advanceTimersByTimeAsync(11_000); // rewrite sent at 10s, query back at 10.5s
      expect(statusTexts().at(-1)).toBe('Retrieving the data... (10s)');
      expect(answerUpdates()).toHaveLength(0);

      finishRewrite();
      await run;
      expect(answerUpdates()).toHaveLength(1);
      expect(mockClient.chat.update.mock.calls.at(-1)![0].blocks).toBeDefined();
    });

    it('shows a failure message without the elapsed time', async () => {
      mockQualityLoop.mockImplementation(async (_options, _key, _question, _maxBytes, callbacks) => {
        await callbacks?.onGenerate?.();
        await wait(25_000);
        return { ...baseQualityResult, verdict: 'exhausted' };
      });

      const run = runPipeline(baseInput);
      await vi.advanceTimersByTimeAsync(25_000);
      await run;

      expect(statusTexts().at(-1)).toBe("I wasn't able to generate a valid query for that question. (trace: trace-abc)");
    });
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

  it('renders the same zero-row Slack answer and controls with or without schema columns', async () => {
    const actual = await vi.importActual<typeof import('../src/slack/blocks.js')>('../src/slack/blocks.js');
    const formatter = await vi.importActual<typeof import('../src/execution/formatter.js')>('../src/execution/formatter.js');
    vi.mocked(buildZeroRowBlocks).mockImplementation(actual.buildZeroRowBlocks);
    vi.mocked(overrideButtonsForResultShape).mockImplementation(actual.overrideButtonsForResultShape);
    const render = (columnNames: string[]) => {
      const result = { rows: [], columnNames, totalRows: 0, bytesProcessed: 0, truncated: false, durationMs: 0 };
      const format = formatter.chooseFormat(result);
      expect(format).toBe('zero_rows');
      return buildResponseBlocks(
        format,
        { ...baseQualityResult.sqlResult, assumptions: ['Excluding test accounts', 'Excluding test accounts'] },
        result,
        'trace-1', 'T1', 'S1', ['Assuming USD', 'Excluding test accounts'],
      );
    };
    const blocks = render([]);
    expect(render(['a', 'b'])).toEqual(blocks);
    const text = JSON.stringify(blocks);
    expect(text.match(/Excluding test accounts/g)).toHaveLength(1);
    expect(text).toContain('Filters applied:* Excluding test accounts');
    expect(text).toContain('Assumptions:* Assuming USD');
    const controls = blocks.flatMap(block => block.type === 'actions' ? block.elements : []);
    expect(controls.map(control => control.action_id)).toEqual([
      'refine_assumptions', 'thumbs_up_trace-1', 'thumbs_down_trace-1', 'show_reasoning_trace-1', 'show_sql_trace-1',
    ]);
  });

  describe('table answers', () => {
    beforeEach(async () => {
      const actual = await vi.importActual<typeof import('../src/slack/blocks.js')>('../src/slack/blocks.js');
      vi.mocked(buildTableBlocks).mockImplementation(actual.buildTableBlocks);
      vi.mocked(buildTruncatedBlocks).mockImplementation(actual.buildTruncatedBlocks);
      vi.mocked(overrideButtonsForResultShape).mockImplementation(actual.overrideButtonsForResultShape);
    });

    const rows = [{ channel: 'Direct', sessions: 198 }, { channel: 'Unassigned', sessions: 42 }];
    const render = (format: string, result: Record<string, unknown>, headline = 'Sessions by channel') =>
      buildResponseBlocks(
        format,
        { ...baseQualityResult.sqlResult, sql: 'SELECT channel, COUNT(*) AS sessions FROM t GROUP BY 1', headline } as any,
        { rows, columnNames: ['channel', 'sessions'], columnTypes: ['STRING', 'INT64'], totalRows: 2, bytesProcessed: 0, truncated: false, ...result } as any,
        'trace-1', 'T1', 'S1', [],
      );

    it.each(['table', 'wide_table', 'summary'])('%s: leads with the computed caption above the table', (format) => {
      const blocks = render(format, {});
      expect((blocks[0] as any).text.text).toBe('*Direct* has the highest sessions (198), followed by Unassigned (42).');
      expect((blocks[1] as any).block_id).toBe('anna_view_table');
    });

    it('hides the Table button (the answer is already a table) but keeps Summary and CSV', () => {
      const ids = render('table', {}).flatMap((b) => (b.type === 'actions' ? b.elements : [])).map((e: any) => e.action_id);
      expect(ids).not.toContain('override_table_trace-1');
      expect(ids).toEqual(expect.arrayContaining(['override_summary_trace-1', 'override_csv_trace-1', 'show_sql_trace-1', 'thumbs_up_trace-1']));
    });

    it('shows no caption when the result was truncated, never the model headline (and keeps the row notice)', () => {
      const blocks = render('table', { truncated: true, totalRows: 5000 });
      expect((blocks[0] as any).block_id).toBe('anna_view_table');
      expect(JSON.stringify(blocks)).not.toContain('Sessions by channel');
      expect(JSON.stringify(blocks)).toMatch(/Showing 2 of 5,?000/);
    });
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

describe('answer shares (ANSWER_SHARES_ENABLED)', () => {
  const COUNT_SQL = 'SELECT ch, COUNT(*) AS n FROM `proj.ds.sessions` GROUP BY ch ORDER BY n DESC';
  const DISTINCT_SQL = 'SELECT ch, COUNT(DISTINCT session_key) AS n FROM `proj.ds.sessions` GROUP BY ch';
  const pairs: [string, number][] = [['Direct', 198], ['Organic', 120], ['Unassigned', 42]];
  const queryResultOf = (rows: [string, number][]) => ({
    rows: rows.map(([ch, n]) => ({ ch, n })),
    columnNames: ['ch', 'n'],
    columnTypes: ['STRING', 'INT64'],
    totalRows: rows.length,
    bytesProcessed: 100,
    truncated: false,
  });
  const sessionsTable = {
    name: 'proj.ds.sessions', schema: 'ds', description: '', materialization: 'table',
    columns: [], sampleDDL: '', dependsOn: [], tags: [], uniqueColumns: ['session_key'],
  };
  const sharesOn = { ...baseInput.config, answerSharesEnabled: true };

  const withSql = (sql: string) =>
    mockQualityLoop.mockResolvedValue({ ...baseQualityResult, sqlResult: { ...baseQualityResult.sqlResult, sql } } as any);
  const postedBlocks = () => mockClient.chat.update.mock.calls.at(-1)![0].blocks as any[];
  const compositionLogs = () => mockLogger.info.mock.calls.filter(([, msg]) => msg === 'answer.composition');

  beforeEach(async () => {
    vi.resetAllMocks();
    vi.mocked(validateSql).mockResolvedValue({ valid: true, layer: 'all' });
    setupHappyPath();
    const actual = await vi.importActual<typeof import('../src/slack/blocks.js')>('../src/slack/blocks.js');
    const composition = await vi.importActual<typeof import('../src/execution/composition.js')>('../src/execution/composition.js');
    vi.mocked(verifyComposition).mockImplementation(composition.verifyComposition);
    vi.mocked(buildTableBlocks).mockImplementation(actual.buildTableBlocks);
    vi.mocked(buildTruncatedBlocks).mockImplementation(actual.buildTruncatedBlocks);
    vi.mocked(overrideButtonsForResultShape).mockImplementation(actual.overrideButtonsForResultShape);
    mockFormat.mockReturnValue('table');
    mockExecute.mockResolvedValue(queryResultOf(pairs) as any);
    withSql(COUNT_SQL);
  });

  it('toPipelineConfig carries the flag', () => {
    const app = { gemini: {}, limits: {}, gcp: {}, escalation: {}, fastPath: undefined } as any;
    expect(toPipelineConfig({ ...app, answerShares: { enabled: true } }).answerSharesEnabled).toBe(true);
    expect(toPipelineConfig({ ...app, answerShares: { enabled: false } }).answerSharesEnabled).toBe(false);
  });

  it('flag on: an eligible COUNT(*) answer posts a Share column, a Total row and a leader share', async () => {
    await runPipeline({ ...baseInput, config: sharesOn });
    const table = postedBlocks().find((b) => b.type === 'table');
    const cells = table.rows.map((r: any[]) => r.map((c) => c.text));
    expect(cells[0]).toEqual(['ch', 'n', 'Share']);
    expect(cells[1]).toEqual(['Direct', '198', '55%']);
    expect(cells.at(-1)).toEqual(['Total', '360', '100%']);
    expect(postedBlocks()[0].text.text).toContain('55%');
  });

  it('flag on: logs answer.composition telemetry without row values', async () => {
    await runPipeline({ ...baseInput, config: sharesOn });
    const logs = compositionLogs();
    expect(logs).toHaveLength(1);
    expect(logs[0][0]).toMatchObject({ event: 'answer.composition', eligible: true, measureKind: 'count', rowCount: 3, usedUniqueKeyCount: 0, surface: 'answer', traceId: expect.any(String) });
    const text = JSON.stringify(logs[0]);
    expect(text).not.toContain('Direct');
    expect(text).not.toContain('198');
    expect(text).not.toContain('sessions');
  });

  it('flag on: a COUNT(DISTINCT unique key) answer persists the keys the proof used', async () => {
    withSql(DISTINCT_SQL);
    await runPipeline({ ...baseInput, tables: [sessionsTable] as any, config: sharesOn });
    expect(JSON.stringify(postedBlocks())).toContain('"Share"');
    expect(mockSaveCtx).toHaveBeenCalledWith(expect.objectContaining({ compositionUniqueKeys: ['proj.ds.sessions.session_key'] }));
    expect(compositionLogs()[0][0]).toMatchObject({ eligible: true, usedUniqueKeyCount: 1 });
  });

  it('flag on: an ineligible answer logs the reason, renders Phase 1, and persists no compositionUniqueKeys', async () => {
    withSql(DISTINCT_SQL); // no unique key declared
    await runPipeline({ ...baseInput, config: sharesOn });
    expect(compositionLogs()[0][0]).toMatchObject({ event: 'answer.composition', eligible: false, reason: 'count_distinct' });
    expect(JSON.stringify(postedBlocks())).not.toContain('"Share"');
    expect(Object.keys(mockSaveCtx.mock.calls[0][0])).not.toContain('compositionUniqueKeys');
  });

  it('flag on: an eligible COUNT(*) answer persists no compositionUniqueKeys (no key used)', async () => {
    await runPipeline({ ...baseInput, config: sharesOn });
    expect(Object.keys(mockSaveCtx.mock.calls[0][0])).not.toContain('compositionUniqueKeys');
  });

  it('flag on: a 21-row result is ineligible (row_count) and the lead-in carries no share', async () => {
    const many: [string, number][] = Array.from({ length: 21 }, (_, i) => [`c${i}`, 100 - i]);
    mockExecute.mockResolvedValue(queryResultOf(many) as any);
    await runPipeline({ ...baseInput, config: sharesOn });
    expect(compositionLogs()[0][0]).toMatchObject({ eligible: false, reason: 'row_count', rowCount: 21 });
    const blocks = postedBlocks();
    expect(JSON.stringify(blocks)).not.toContain('"Share"');
    expect(JSON.stringify(blocks)).not.toContain('%');
    expect(JSON.stringify(blocks)).toMatch(/Showing 20 of 21/);
  });

  it('flag on: a verifier throw renders the Phase 1 answer and logs verifier_error', async () => {
    const phase1 = await (async () => {
      await runPipeline(baseInput);
      return postedBlocks();
    })();
    mockClient.chat.update.mockClear();
    vi.mocked(verifyComposition).mockImplementation(() => { throw new Error('boom'); });
    await runPipeline({ ...baseInput, config: sharesOn });
    expect(postedBlocks()).toEqual(phase1);
    expect(compositionLogs().at(-1)![0]).toMatchObject({ event: 'answer.composition', eligible: false, reason: 'verifier_error' });
  });

  it('flag off: blocks equal the Phase 1 output and nothing is verified or logged', async () => {
    await runPipeline(baseInput);
    expect(postedBlocks()).toMatchInlineSnapshot(`
      [
        {
          "text": {
            "text": "*Direct* has the highest n (198), followed by Organic (120).",
            "type": "mrkdwn",
          },
          "type": "section",
        },
        {
          "block_id": "anna_view_table",
          "rows": [
            [
              {
                "text": "ch",
                "type": "raw_text",
              },
              {
                "text": "n",
                "type": "raw_text",
              },
            ],
            [
              {
                "text": "Direct",
                "type": "raw_text",
              },
              {
                "text": "198",
                "type": "raw_text",
              },
            ],
            [
              {
                "text": "Organic",
                "type": "raw_text",
              },
              {
                "text": "120",
                "type": "raw_text",
              },
            ],
            [
              {
                "text": "Unassigned",
                "type": "raw_text",
              },
              {
                "text": "42",
                "type": "raw_text",
              },
            ],
          ],
          "type": "table",
        },
        {
          "elements": [],
          "type": "actions",
        },
      ]
    `);
    expect(JSON.stringify(postedBlocks())).not.toContain('"Share"');
    expect(compositionLogs()).toHaveLength(0);
    expect(verifyComposition).not.toHaveBeenCalled();
    expect(Object.keys(mockSaveCtx.mock.calls[0][0])).not.toContain('compositionUniqueKeys');
  });

  it('flag off with answerSharesEnabled:false behaves the same as absent', async () => {
    await runPipeline({ ...baseInput, config: { ...baseInput.config, answerSharesEnabled: false } });
    expect(JSON.stringify(postedBlocks())).not.toContain('"Share"');
    expect(verifyComposition).not.toHaveBeenCalled();
  });
});
