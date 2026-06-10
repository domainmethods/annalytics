import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/state/escalationState.js');
vi.mock('../../src/slack/escalationBlocks.js');
vi.mock('../../src/pipeline.js');
vi.mock('../../src/teachings/candidateGenerator.js', () => ({
  generateTeachingCandidate: vi.fn(),
}));
vi.mock('../../src/state/teachingCandidates.js', () => ({
  saveTeachingCandidate: vi.fn(),
}));

import { getEscalationByEscalationThread, resolveEscalation } from '../../src/state/escalationState.js';
import { buildEscalationResolvedBlocks } from '../../src/slack/escalationBlocks.js';
import { runPipeline } from '../../src/pipeline.js';
import { checkEscalationResponse, resumeFromEscalation } from '../../src/handlers/escalationResponse.js';
import { generateTeachingCandidate } from '../../src/teachings/candidateGenerator.js';
import { saveTeachingCandidate } from '../../src/state/teachingCandidates.js';

const mockGetEscalation = vi.mocked(getEscalationByEscalationThread);
const mockResolve = vi.mocked(resolveEscalation);
const mockBuildResolved = vi.mocked(buildEscalationResolvedBlocks);
const mockRunPipeline = vi.mocked(runPipeline);
const mockGenerateTeachingCandidate = vi.mocked(generateTeachingCandidate);
const mockSaveTeachingCandidate = vi.mocked(saveTeachingCandidate);

const mockClient = {
  chat: { postMessage: vi.fn(), update: vi.fn() },
} as any;

const baseEscalation = {
  escalationId: 'esc_trace-1',
  originalThreadTs: 'thread-1',
  originalChannel: 'C-ORIGINAL',
  pipelineState: 'awaiting_human' as const,
  trigger: 'supervisor_exhausted' as const,
  behavior: 'park_wait' as const,
  stageToResume: 'sql_generation' as const,
  context: {
    clarifiedQuestion: 'What is revenue?',
    userQuestion: 'What is revenue?',
    groundingCitations: [],
    previousSql: 'SELECT SUM(amount) FROM orders',
    supervisorNotes: 'Not sure about joins',
  },
  escalationChannel: 'C-ESCALATION',
  escalationTs: 'esc-ts-1',
  statusMsgTs: 'status-1',
  bestEffortSql: 'SELECT SUM(amount) FROM orders',
  createdAt: new Date(),
  expiresAt: new Date(Date.now() + 3600000),
  traceId: 'trace-1',
};

describe('checkEscalationResponse', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null when no thread_ts', async () => {
    const result = await checkEscalationResponse({ channel: 'C-ESCALATION' });
    expect(result).toBeNull();
    expect(mockGetEscalation).not.toHaveBeenCalled();
  });

  it('returns null when no pending escalation (expired or not found)', async () => {
    mockGetEscalation.mockResolvedValue(null);
    const result = await checkEscalationResponse({
      channel: 'C-ESCALATION',
      thread_ts: 'esc-ts-unknown',
      text: 'Use LEFT JOIN',
    });
    expect(result).toBeNull();
  });
});

describe('resumeFromEscalation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolve.mockResolvedValue(undefined);
    mockRunPipeline.mockResolvedValue(undefined);
    mockBuildResolved.mockReturnValue([{ type: 'section', text: { type: 'mrkdwn', text: 'resolved' } }] as any);
    mockClient.chat.postMessage.mockResolvedValue({});
    mockGenerateTeachingCandidate.mockResolvedValue({ candidateId: 'teach_default' } as any);
    mockSaveTeachingCandidate.mockResolvedValue(undefined);
  });

  it('park_wait: resumes pipeline with human guidance, resolves escalation', async () => {
    mockGetEscalation.mockResolvedValue(baseEscalation);
    const ctx = await checkEscalationResponse({
      channel: 'C-ESCALATION',
      thread_ts: 'esc-ts-1',
      text: 'Use LEFT JOIN on user_id',
    });

    await resumeFromEscalation(ctx!, mockClient, [], {
      geminiApiKey: 'key',
      maxBytesProcessed: 10e9,
      queryTimeoutMs: 30000,
      maxResultRows: 1000,
    });

    // Should call runPipeline with human guidance injected into question
    expect(mockRunPipeline).toHaveBeenCalledWith(
      expect.objectContaining({
        question: expect.stringContaining('Use LEFT JOIN on user_id'),
        channel: 'C-ORIGINAL',
        threadTs: 'thread-1',
        statusMsgTs: 'status-1',
      }),
    );
    // Should resolve escalation
    expect(mockResolve).toHaveBeenCalledWith('esc_trace-1');

    // Default (no options): teaching candidate generation still fires
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(mockGenerateTeachingCandidate).toHaveBeenCalled();
  });

  it('skipTeachingCandidate: resolves escalation without generating a teaching candidate', async () => {
    mockGetEscalation.mockResolvedValue(baseEscalation);
    const ctx = await checkEscalationResponse({
      channel: 'C-ESCALATION',
      thread_ts: 'esc-ts-1',
      text: 'Use LEFT JOIN on user_id',
    });

    await resumeFromEscalation(
      ctx!,
      mockClient,
      [],
      {
        geminiApiKey: 'key',
        maxBytesProcessed: 10e9,
        queryTimeoutMs: 30000,
        maxResultRows: 1000,
      },
      { skipTeachingCandidate: true },
    );

    // Escalation is still resolved as normal
    expect(mockRunPipeline).toHaveBeenCalled();
    expect(mockResolve).toHaveBeenCalledWith('esc_trace-1');

    // Flush microtask queue — even after settling, no teaching candidate work happened
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(mockGenerateTeachingCandidate).not.toHaveBeenCalled();
    expect(mockSaveTeachingCandidate).not.toHaveBeenCalled();
  });

  it('best_effort_verify: posts human response to original thread, resolves escalation', async () => {
    const bestEffortEscalation = {
      ...baseEscalation,
      behavior: 'best_effort_verify' as const,
    };
    mockGetEscalation.mockResolvedValue(bestEffortEscalation);
    const ctx = await checkEscalationResponse({
      channel: 'C-ESCALATION',
      thread_ts: 'esc-ts-1',
      text: 'Confirmed, the join logic is correct',
    });

    await resumeFromEscalation(ctx!, mockClient, [], {
      geminiApiKey: 'key',
      maxBytesProcessed: 10e9,
      queryTimeoutMs: 30000,
      maxResultRows: 1000,
    });

    // Should NOT call runPipeline (answer already shown)
    expect(mockRunPipeline).not.toHaveBeenCalled();
    // Should post human response to original thread
    expect(mockClient.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'C-ORIGINAL',
        thread_ts: 'thread-1',
      }),
    );
    // Should build resolved blocks with behavior
    expect(mockBuildResolved).toHaveBeenCalledWith(
      'Confirmed, the join logic is correct',
      'best_effort_verify',
    );
    // Should resolve escalation
    expect(mockResolve).toHaveBeenCalledWith('esc_trace-1');
  });

  it('generates teaching candidate on escalation resolution', async () => {
    const mockCandidate = { candidateId: 'teach_esc_trace-1' } as any;
    mockGenerateTeachingCandidate.mockResolvedValue(mockCandidate);
    mockSaveTeachingCandidate.mockResolvedValue(undefined);
    mockGetEscalation.mockResolvedValue(baseEscalation);

    const ctx = await checkEscalationResponse({
      channel: 'C-ESCALATION',
      thread_ts: 'esc-ts-1',
      text: 'Use LEFT JOIN on user_id',
    });

    await resumeFromEscalation(ctx!, mockClient, [], {
      geminiApiKey: 'test-key',
      maxBytesProcessed: 10e9,
      queryTimeoutMs: 30000,
      maxResultRows: 1000,
    });

    // Flush microtask queue so fire-and-forget promise chain resolves
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(mockGenerateTeachingCandidate).toHaveBeenCalledWith({
      escalationId: 'esc_trace-1',
      originalQuestion: 'What is revenue?',
      clarifiedQuestion: 'What is revenue?',
      humanResponse: 'Use LEFT JOIN on user_id',
      failedSql: 'SELECT SUM(amount) FROM orders',
      supervisorNotes: 'Not sure about joins',
      apiKey: 'test-key',
    });
    expect(mockSaveTeachingCandidate).toHaveBeenCalledWith(mockCandidate);
  });

  it('teaching candidate generation failure does not block resolution', async () => {
    mockGenerateTeachingCandidate.mockRejectedValue(new Error('LLM timeout'));
    mockGetEscalation.mockResolvedValue(baseEscalation);

    const ctx = await checkEscalationResponse({
      channel: 'C-ESCALATION',
      thread_ts: 'esc-ts-1',
      text: 'Use LEFT JOIN on user_id',
    });

    // Should not throw even though teaching candidate generation fails
    await expect(
      resumeFromEscalation(ctx!, mockClient, [], {
        geminiApiKey: 'key',
        maxBytesProcessed: 10e9,
        queryTimeoutMs: 30000,
        maxResultRows: 1000,
      }),
    ).resolves.toBeUndefined();

    // Flush microtask queue
    await new Promise(resolve => setTimeout(resolve, 0));

    // resolveEscalation should have been called (resolution not blocked)
    expect(mockResolve).toHaveBeenCalledWith('esc_trace-1');
    // generateTeachingCandidate was called but its failure was swallowed
    expect(mockGenerateTeachingCandidate).toHaveBeenCalled();
  });
});
