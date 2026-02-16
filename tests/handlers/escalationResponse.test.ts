import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/state/escalationState.js');
vi.mock('../../src/slack/escalationBlocks.js');
vi.mock('../../src/pipeline.js');

import { getEscalationByEscalationThread, resolveEscalation } from '../../src/state/escalationState.js';
import { buildEscalationResolvedBlocks } from '../../src/slack/escalationBlocks.js';
import { runPipeline } from '../../src/pipeline.js';
import { checkEscalationResponse, resumeFromEscalation } from '../../src/handlers/escalationResponse.js';

const mockGetEscalation = vi.mocked(getEscalationByEscalationThread);
const mockResolve = vi.mocked(resolveEscalation);
const mockBuildResolved = vi.mocked(buildEscalationResolvedBlocks);
const mockRunPipeline = vi.mocked(runPipeline);

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
});
