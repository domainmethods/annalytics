import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChannelClient, ChannelMessage } from '../../src/channels/types.js';
import type { TableContext } from '../../src/dbt/types.js';
import type { PipelineConfig } from '../../src/pipeline.js';
import type { ClarificationState } from '../../src/state/clarificationState.js';
import type { EscalationState } from '../../src/types.js';

vi.mock('../../src/state/whatsappEventDedupe.js', () => ({
  claimWhatsAppEvent: vi.fn(),
  releaseWhatsAppEventClaim: vi.fn(),
}));
vi.mock('../../src/state/rateLimiter.js', () => ({ checkRateLimit: vi.fn() }));
vi.mock('../../src/state/clarificationState.js', () => ({
  getClarificationState: vi.fn(),
  deleteClarificationState: vi.fn(),
}));
vi.mock('../../src/state/escalationState.js', () => ({ getEscalationByThread: vi.fn() }));
vi.mock('../../src/state/responseContext.js', () => ({ saveResponseContext: vi.fn() }));
vi.mock('../../src/whatsapp/pipeline.js', () => ({
  runWhatsAppPipeline: vi.fn(),
  answerWhatsAppQuestion: vi.fn(),
}));

import { checkRateLimit } from '../../src/state/rateLimiter.js';
import { getClarificationState, deleteClarificationState } from '../../src/state/clarificationState.js';
import { getEscalationByThread } from '../../src/state/escalationState.js';
import { saveResponseContext } from '../../src/state/responseContext.js';
import { claimWhatsAppEvent, releaseWhatsAppEventClaim } from '../../src/state/whatsappEventDedupe.js';
import { answerWhatsAppQuestion, runWhatsAppPipeline } from '../../src/whatsapp/pipeline.js';
import { handleWhatsAppMessages } from '../../src/handlers/whatsappMessages.js';

const mockClaimWhatsAppEvent = vi.mocked(claimWhatsAppEvent);
const mockReleaseWhatsAppEventClaim = vi.mocked(releaseWhatsAppEventClaim);
const mockCheckRateLimit = vi.mocked(checkRateLimit);
const mockGetClarificationState = vi.mocked(getClarificationState);
const mockDeleteClarificationState = vi.mocked(deleteClarificationState);
const mockGetEscalationByThread = vi.mocked(getEscalationByThread);
const mockRunWhatsAppPipeline = vi.mocked(runWhatsAppPipeline);
const mockAnswerWhatsAppQuestion = vi.mocked(answerWhatsAppQuestion);

const conversation = {
  surface: 'whatsapp' as const,
  conversationId: 'whatsapp:15551234567',
  userId: '15551234567',
};

const tables: TableContext[] = [{
  name: 'analytics.fct_orders',
  schema: 'analytics',
  description: 'Orders fact table',
  materialization: 'table',
  columns: [{
    name: 'revenue',
    description: 'Order revenue',
    dataType: 'NUMERIC',
    meta: {},
  }],
  sampleDDL: 'CREATE TABLE analytics.fct_orders (revenue NUMERIC)',
  dependsOn: [],
  tags: [],
}];

const config: PipelineConfig = {
  geminiApiKey: 'gemini-key',
  fileSearchStoreId: 'stores/test',
  maxBytesProcessed: 1_000,
  queryTimeoutMs: 30_000,
  maxResultRows: 10,
};

function message(overrides: Partial<ChannelMessage> = {}): ChannelMessage {
  return {
    surface: 'whatsapp',
    providerMessageId: 'wamid.1',
    conversation,
    text: 'What was revenue yesterday?',
    receivedAt: new Date('2026-06-21T12:00:00.000Z'),
    ...overrides,
  };
}

function client(): ChannelClient {
  return {
    sendText: vi.fn().mockResolvedValue({ messageId: 'outbound.1' }),
  };
}

function deps(overrides: Partial<Parameters<typeof handleWhatsAppMessages>[1]> = {}) {
  return {
    client: client(),
    tables,
    config,
    rateLimitPerHour: 30,
    allowedWaIds: ['15551234567'],
    ...overrides,
  };
}

function clarificationState(overrides: Partial<ClarificationState> = {}): ClarificationState {
  return {
    clarificationId: 'clarify_whatsapp:15551234567',
    threadTs: 'whatsapp:15551234567',
    channel: 'whatsapp:15551234567',
    originalQuestion: 'What was revenue?',
    ambiguities: ['metric definition'],
    clarifyingMessageTs: 'outbound.clarify',
    state: 'awaiting_reply',
    createdAt: new Date('2026-06-21T11:55:00.000Z'),
    expiresAt: new Date('2026-06-21T12:55:00.000Z'),
    ...overrides,
  };
}

function escalationState(overrides: Partial<EscalationState> = {}): EscalationState {
  return {
    escalationId: 'esc_1',
    originalThreadTs: 'whatsapp:15551234567',
    originalChannel: 'whatsapp:15551234567',
    pipelineState: 'awaiting_human',
    trigger: 'supervisor_exhausted',
    behavior: 'park_wait',
    stageToResume: 'sql_generation',
    context: {
      clarifiedQuestion: 'What was revenue yesterday?',
      userQuestion: 'What was revenue yesterday?',
      groundingCitations: [],
    },
    escalationChannel: 'CESC',
    escalationTs: '1719000000.000000',
    statusMsgTs: 'outbound.status',
    createdAt: new Date('2026-06-21T11:00:00.000Z'),
    expiresAt: new Date('2026-06-21T15:00:00.000Z'),
    traceId: 'trace-esc',
    ...overrides,
  };
}

describe('handleWhatsAppMessages', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockClaimWhatsAppEvent.mockResolvedValue(true);
    mockReleaseWhatsAppEventClaim.mockResolvedValue(undefined);
    mockCheckRateLimit.mockResolvedValue({ allowed: true });
    mockGetClarificationState.mockResolvedValue(null);
    mockDeleteClarificationState.mockResolvedValue(undefined);
    mockGetEscalationByThread.mockResolvedValue(null);
    mockRunWhatsAppPipeline.mockResolvedValue(undefined);
    mockAnswerWhatsAppQuestion.mockResolvedValue({
      kind: 'clarification',
      questions: ['Which metric should I use?'],
      traceId: 'trace-answerer',
    });
  });

  it('runs the WhatsApp pipeline for allowed text message', async () => {
    const inbound = message();
    const dependencies = deps();

    await handleWhatsAppMessages([inbound], dependencies);

    expect(mockClaimWhatsAppEvent).toHaveBeenCalledWith('wamid.1');
    expect(mockCheckRateLimit).toHaveBeenCalledWith('whatsapp:15551234567', 30);
    expect(mockRunWhatsAppPipeline).toHaveBeenCalledOnce();
    expect(mockRunWhatsAppPipeline).toHaveBeenCalledWith(expect.objectContaining({
      message: inbound,
      client: dependencies.client,
      saveResponseContext,
      answerQuestion: expect.any(Function),
    }));

    const runInput = mockRunWhatsAppPipeline.mock.calls[0][0];
    await runInput.answerQuestion({
      question: 'What was revenue yesterday?',
      conversationId: 'whatsapp:15551234567',
      providerMessageId: 'wamid.1',
    });
    expect(mockAnswerWhatsAppQuestion).toHaveBeenCalledWith({
      question: 'What was revenue yesterday?',
      conversationId: 'whatsapp:15551234567',
      providerMessageId: 'wamid.1',
      tables,
      config,
    });
  });

  it('skips unknown users when allowlist configured', async () => {
    await handleWhatsAppMessages([
      message({
        conversation: {
          ...conversation,
          conversationId: 'whatsapp:15557654321',
          userId: '15557654321',
        },
      }),
    ], deps());

    expect(mockClaimWhatsAppEvent).not.toHaveBeenCalled();
    expect(mockCheckRateLimit).not.toHaveBeenCalled();
    expect(mockRunWhatsAppPipeline).not.toHaveBeenCalled();
  });

  it('does not run duplicate messages when claim returns false', async () => {
    mockClaimWhatsAppEvent.mockResolvedValue(false);

    await handleWhatsAppMessages([message()], deps());

    expect(mockClaimWhatsAppEvent).toHaveBeenCalledWith('wamid.1');
    expect(mockCheckRateLimit).not.toHaveBeenCalled();
    expect(mockRunWhatsAppPipeline).not.toHaveBeenCalled();
  });

  it('sends rate-limit text and skips pipeline', async () => {
    const dependencies = deps();
    mockCheckRateLimit.mockResolvedValue({ allowed: false, retryAfterMinutes: 12 });

    await handleWhatsAppMessages([message()], dependencies);

    expect(dependencies.client.sendText).toHaveBeenCalledWith(
      conversation,
      "You've hit the query limit (30/hour). Resets in 12 minutes.",
    );
    expect(mockRunWhatsAppPipeline).not.toHaveBeenCalled();
    expect(mockReleaseWhatsAppEventClaim).not.toHaveBeenCalled();
  });

  it('resumes pending clarification and deletes clarification state after pipeline resolves', async () => {
    const state = clarificationState({
      originalQuestion: 'What was revenue?',
      clarificationId: 'clarify_1',
    });
    const inbound = message({ text: 'Use booked revenue.' });
    let resolvePipeline!: () => void;
    mockGetClarificationState.mockResolvedValue(state);
    mockRunWhatsAppPipeline.mockReturnValue(new Promise<void>((resolve) => {
      resolvePipeline = resolve;
    }));

    const handling = handleWhatsAppMessages([inbound], deps());
    await vi.waitFor(() => expect(mockRunWhatsAppPipeline).toHaveBeenCalledOnce());
    expect(mockDeleteClarificationState).not.toHaveBeenCalled();

    resolvePipeline();
    await handling;

    expect(mockRunWhatsAppPipeline).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.objectContaining({
        text: 'What was revenue? (Clarification: Use booked revenue.)',
      }),
    }));
    expect(mockDeleteClarificationState).toHaveBeenCalledWith('clarify_1');
  });

  it('rethrows and releases dedupe claim when pipeline throws before visible response', async () => {
    const error = new Error('ack failed');
    mockRunWhatsAppPipeline.mockRejectedValue(error);

    await expect(handleWhatsAppMessages([message()], deps())).rejects.toThrow('ack failed');

    expect(mockReleaseWhatsAppEventClaim).toHaveBeenCalledWith('wamid.1');
    expect(mockDeleteClarificationState).not.toHaveBeenCalled();
  });

  it('does not delete clarification state and releases dedupe claim when resumed pipeline throws', async () => {
    mockGetClarificationState.mockResolvedValue(clarificationState({ clarificationId: 'clarify_1' }));
    mockRunWhatsAppPipeline.mockRejectedValue(new Error('ack failed'));

    await expect(handleWhatsAppMessages([
      message({ text: 'Use gross revenue.' }),
    ], deps())).rejects.toThrow('ack failed');

    expect(mockDeleteClarificationState).not.toHaveBeenCalled();
    expect(mockReleaseWhatsAppEventClaim).toHaveBeenCalledWith('wamid.1');
  });

  it('guards pending escalation and keeps dedupe claim after visible wait text', async () => {
    const dependencies = deps();
    mockGetEscalationByThread.mockResolvedValue({
      status: 'pending',
      state: escalationState(),
    });

    await handleWhatsAppMessages([message()], dependencies);

    expect(mockGetEscalationByThread).toHaveBeenCalledWith('whatsapp:15551234567');
    expect(dependencies.client.sendText).toHaveBeenCalledWith(
      conversation,
      "I'm still waiting for the data team on your previous question.",
    );
    expect(mockRunWhatsAppPipeline).not.toHaveBeenCalled();
    expect(mockReleaseWhatsAppEventClaim).not.toHaveBeenCalled();
  });
});
