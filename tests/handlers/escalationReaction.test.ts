import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/state/escalationState.js');
vi.mock('../../src/handlers/escalationResponse.js');

import type { ReactionAddedEvent } from '@slack/types';
import { getEscalationByEscalationThread } from '../../src/state/escalationState.js';
import { resumeFromEscalation } from '../../src/handlers/escalationResponse.js';
import { handleEscalationReaction } from '../../src/handlers/escalationReaction.js';
import { toPipelineConfig } from '../../src/pipeline.js';
import type { AppConfig } from '../../src/config.js';
import type { EscalationState } from '../../src/types.js';

const mockGetEscalation = vi.mocked(getEscalationByEscalationThread);
const mockResume = vi.mocked(resumeFromEscalation);

const mockClient = {
  chat: { postMessage: vi.fn() },
} as any;

const baseConfig: AppConfig = {
  slack: { botToken: 'xoxb-test', signingSecret: 'sig' },
  gemini: { apiKey: 'test-key', model: 'gemini-test' },
  gcp: { projectId: 'test-project' },
  dbt: { manifestPath: 'manifest.json', catalogPath: 'catalog.json' },
  limits: {
    costGateMaxBytes: 10e9,
    queryTimeoutMs: 30000,
    maxResultRows: 1000,
    rateLimitPerHour: 30,
  },
  escalation: {
    mode: 'channel',
    channelId: 'C-ESCALATION',
    analystUserId: undefined,
    reminderIntervalMinutes: 30,
    timeoutHours: 4,
    onNegativeFeedback: true,
  },
  fastPath: { enabled: false, maxBytesProcessed: 1e9, requireSupervisor: true },
  port: 3000,
};

const baseEscalation: EscalationState = {
  escalationId: 'esc_trace-1',
  originalThreadTs: 'thread-1',
  originalChannel: 'C-ORIGINAL',
  pipelineState: 'awaiting_human',
  trigger: 'supervisor_exhausted',
  behavior: 'best_effort_verify',
  stageToResume: 'sql_generation',
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

const baseEvent: ReactionAddedEvent = {
  type: 'reaction_added',
  user: 'U-ANALYST',
  reaction: 'white_check_mark',
  item_user: 'U-BOT',
  item: { type: 'message', channel: 'C-ESCALATION', ts: 'esc-ts-1' },
  event_ts: '1700000000.000100',
};

const tables: never[] = [];

function callHandler(event: ReactionAddedEvent, config: AppConfig = baseConfig) {
  return handleEscalationReaction({ event, client: mockClient, config, getTables: () => tables });
}

describe('handleEscalationReaction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockClient.chat.postMessage.mockResolvedValue({});
    mockResume.mockResolvedValue(undefined);
  });

  it('ignores non-✅ reactions without touching Firestore', async () => {
    await callHandler({ ...baseEvent, reaction: 'thumbsup' });

    expect(mockGetEscalation).not.toHaveBeenCalled();
    expect(mockResume).not.toHaveBeenCalled();
  });

  it('ignores reactions on non-message items', async () => {
    const fileEvent = {
      ...baseEvent,
      item: { type: 'file', channel: 'C-ESCALATION', ts: 'esc-ts-1' },
    } as unknown as ReactionAddedEvent;

    await callHandler(fileEvent);

    expect(mockGetEscalation).not.toHaveBeenCalled();
    expect(mockResume).not.toHaveBeenCalled();
  });

  it('channel mode: skips the lookup for reactions outside the escalation channel', async () => {
    await callHandler({
      ...baseEvent,
      item: { type: 'message', channel: 'C-SOMEWHERE-ELSE', ts: 'esc-ts-1' },
    });

    expect(mockGetEscalation).not.toHaveBeenCalled();
    expect(mockResume).not.toHaveBeenCalled();
  });

  it('no-ops when there is no pending escalation for the message ts (idempotency)', async () => {
    mockGetEscalation.mockResolvedValue(null);

    await callHandler(baseEvent);

    expect(mockGetEscalation).toHaveBeenCalledWith('esc-ts-1');
    expect(mockResume).not.toHaveBeenCalled();
    expect(mockClient.chat.postMessage).not.toHaveBeenCalled();
  });

  it('ignores a lookup hit whose escalation channel does not match the reacted message', async () => {
    mockGetEscalation.mockResolvedValue({
      ...baseEscalation,
      escalationChannel: 'C-OTHER-CHANNEL',
    });

    await callHandler({
      ...baseEvent,
      item: { type: 'message', channel: 'C-ESCALATION', ts: 'esc-ts-1' },
    });

    expect(mockResume).not.toHaveBeenCalled();
    expect(mockClient.chat.postMessage).not.toHaveBeenCalled();
  });

  it('replies in the escalation thread (and does not resolve) when there is no proposed SQL', async () => {
    mockGetEscalation.mockResolvedValue({
      ...baseEscalation,
      context: { ...baseEscalation.context, previousSql: undefined },
    });

    await callHandler(baseEvent);

    expect(mockClient.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'C-ESCALATION',
        thread_ts: 'esc-ts-1',
        text: expect.stringContaining('no proposed SQL'),
      }),
    );
    expect(mockResume).not.toHaveBeenCalled();
  });

  it('best_effort_verify: resumes with ✅ confirmation guidance and skips teaching candidate', async () => {
    mockGetEscalation.mockResolvedValue(baseEscalation);

    await callHandler(baseEvent);

    expect(mockResume).toHaveBeenCalledWith(
      {
        escalationId: 'esc_trace-1',
        originalChannel: 'C-ORIGINAL',
        originalThreadTs: 'thread-1',
        statusMsgTs: 'status-1',
        humanGuidance: 'Confirmed correct via ✅ reaction.',
        behavior: 'best_effort_verify',
        context: baseEscalation.context,
        traceId: 'trace-1',
      },
      mockClient,
      tables,
      toPipelineConfig(baseConfig),
      { skipTeachingCandidate: true },
    );
  });

  it('park_wait: resumes with data-team confirmation guidance and skips teaching candidate', async () => {
    mockGetEscalation.mockResolvedValue({
      ...baseEscalation,
      behavior: 'park_wait',
    });

    await callHandler(baseEvent);

    expect(mockResume).toHaveBeenCalledWith(
      expect.objectContaining({
        humanGuidance: 'The data team confirmed the proposed SQL is correct.',
        behavior: 'park_wait',
      }),
      mockClient,
      tables,
      toPipelineConfig(baseConfig),
      { skipTeachingCandidate: true },
    );
  });
});
