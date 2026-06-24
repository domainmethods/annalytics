import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PipelineConfig } from '../../src/pipeline.js';
import type { ResponseContext } from '../../src/types.js';
import type { WhatsAppClient } from '../../src/whatsapp/client.js';
import type { WhatsAppInteractiveAction } from '../../src/whatsapp/payload.js';

vi.mock('../../src/state/whatsappEventDedupe.js', () => ({
  claimWhatsAppEvent: vi.fn(),
  markWhatsAppEventVisible: vi.fn(),
  releaseWhatsAppEventClaim: vi.fn(),
}));
vi.mock('../../src/state/whatsappActionContext.js', () => ({
  createWhatsAppActionContext: vi.fn(),
  getWhatsAppActionContext: vi.fn(),
}));
vi.mock('../../src/state/responseContext.js', () => ({
  getResponseContext: vi.fn(),
  recordFeedbackByResponseContextKey: vi.fn(),
}));
vi.mock('../../src/state/whatsappPendingFeedback.js', () => ({
  saveWhatsAppPendingFeedback: vi.fn(),
}));
vi.mock('../../src/logging.js', () => ({
  rootLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));
vi.mock('../../src/whatsapp/overrides.js', () => ({
  renderWhatsAppTableOverride: vi.fn(),
  renderWhatsAppSummaryOverride: vi.fn(),
}));

import {
  claimWhatsAppEvent,
  markWhatsAppEventVisible,
  releaseWhatsAppEventClaim,
} from '../../src/state/whatsappEventDedupe.js';
import {
  createWhatsAppActionContext,
  getWhatsAppActionContext,
  type StoredWhatsAppActionContext,
} from '../../src/state/whatsappActionContext.js';
import {
  getResponseContext,
  recordFeedbackByResponseContextKey,
} from '../../src/state/responseContext.js';
import { saveWhatsAppPendingFeedback } from '../../src/state/whatsappPendingFeedback.js';
import {
  renderWhatsAppSummaryOverride,
  renderWhatsAppTableOverride,
} from '../../src/whatsapp/overrides.js';
import { rootLogger } from '../../src/logging.js';
import { handleWhatsAppActions } from '../../src/whatsapp/actions.js';
import {
  renderWhatsAppExpiredAction,
  renderWhatsAppFeedbackAck,
  renderWhatsAppSafeError,
} from '../../src/whatsapp/renderer.js';
import type { WhatsAppActionKind } from '../../src/whatsapp/actionIds.js';

const mockClaimWhatsAppEvent = vi.mocked(claimWhatsAppEvent);
const mockMarkWhatsAppEventVisible = vi.mocked(markWhatsAppEventVisible);
const mockReleaseWhatsAppEventClaim = vi.mocked(releaseWhatsAppEventClaim);
const mockCreateWhatsAppActionContext = vi.mocked(createWhatsAppActionContext);
const mockGetWhatsAppActionContext = vi.mocked(getWhatsAppActionContext);
const mockGetResponseContext = vi.mocked(getResponseContext);
const mockRecordFeedbackByResponseContextKey = vi.mocked(recordFeedbackByResponseContextKey);
const mockSaveWhatsAppPendingFeedback = vi.mocked(saveWhatsAppPendingFeedback);
const mockRenderWhatsAppTableOverride = vi.mocked(renderWhatsAppTableOverride);
const mockRenderWhatsAppSummaryOverride = vi.mocked(renderWhatsAppSummaryOverride);

const conversation = {
  surface: 'whatsapp' as const,
  conversationId: 'whatsapp:15551234567',
  userId: '15551234567',
};

const config: PipelineConfig = {
  geminiApiKey: 'gemini-key',
  maxBytesProcessed: 1_000,
  queryTimeoutMs: 30_000,
  maxResultRows: 10,
};

function action(actionId: string): WhatsAppInteractiveAction {
  return {
    providerMessageId: 'wamid.action',
    conversation,
    receivedAt: new Date('2026-06-23T00:00:00.000Z'),
    actionId,
    actionTitle: 'Action',
    kind: 'button_reply',
  };
}

function client(): WhatsAppClient {
  return {
    sendText: vi.fn().mockResolvedValue({ messageId: 'outbound.text' }),
    sendInteractive: vi.fn().mockResolvedValue({ messageId: 'outbound.interactive' }),
  };
}

function ctx(overrides: Partial<ResponseContext> = {}): ResponseContext {
  return {
    surface: 'whatsapp',
    responseId: 'trace-1',
    threadTs: 'whatsapp:15551234567',
    statusMsgTs: 'wamid.outbound',
    clarifiedQuestion: 'What was revenue?',
    assumptions: [],
    reasoningChain: 'Used fct_orders.',
    generatedSql: 'SELECT 1',
    explanation: 'Revenue was 1.',
    tablesUsed: [],
    confidence: 'high',
    clarificationConfidence: 'high',
    primaryAgentConfidence: 'high',
    supervisorConfidence: 'high',
    queryResults: { rowCount: 1, columnNames: ['revenue'], bytesProcessed: 0 },
    pipelineDurationMs: 10,
    traceId: 'trace-1',
    createdAt: new Date('2026-06-23T00:00:00.000Z'),
    groundingCitations: [],
    teachingsUsed: [],
    supervisorVerdict: 'pass',
    supervisorNotes: 'Looks valid.',
    ...overrides,
  };
}

function storedAction(
  kind: WhatsAppActionKind,
  responseContextKey = 'response-key',
): StoredWhatsAppActionContext {
  return {
    id: 'ctx_parent',
    kind,
    responseContextKey,
    conversationId: conversation.conversationId,
    userId: conversation.userId,
    createdAt: new Date('2026-06-23T00:00:00.000Z'),
    expiresAt: new Date('2026-06-24T00:00:00.000Z'),
  };
}

function deps(testClient = client(), allowedWaIds: string[] = []) {
  return {
    client: testClient,
    tables: [],
    config,
    rateLimitPerHour: 100,
    allowedWaIds,
  };
}

describe('handleWhatsAppActions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockClaimWhatsAppEvent.mockResolvedValue(true);
    mockMarkWhatsAppEventVisible.mockResolvedValue(undefined);
    mockReleaseWhatsAppEventClaim.mockResolvedValue(undefined);
    mockRecordFeedbackByResponseContextKey.mockResolvedValue(undefined);
    mockSaveWhatsAppPendingFeedback.mockResolvedValue(undefined);
  });

  it('records positive feedback and acknowledges the action', async () => {
    mockGetWhatsAppActionContext.mockResolvedValue(storedAction('ok'));
    const testClient = client();

    await handleWhatsAppActions([action('wa:v1:ok:ctx_ok')], deps(testClient));

    expect(mockClaimWhatsAppEvent).toHaveBeenCalledWith('wamid.action');
    expect(mockGetWhatsAppActionContext).toHaveBeenCalledWith('ctx_ok');
    expect(mockRecordFeedbackByResponseContextKey).toHaveBeenCalledWith('response-key', 'positive');
    expect(testClient.sendText).toHaveBeenCalledWith(
      conversation,
      renderWhatsAppFeedbackAck('positive'),
    );
    expect(mockMarkWhatsAppEventVisible).toHaveBeenCalledWith('wamid.action');
  });

  it('treats missing response context during feedback write as an expired action', async () => {
    mockGetWhatsAppActionContext.mockResolvedValue(storedAction('ok'));
    mockRecordFeedbackByResponseContextKey.mockRejectedValue({ code: 5 });
    const testClient = client();

    await expect(handleWhatsAppActions([action('wa:v1:ok:ctx_ok')], deps(testClient)))
      .resolves.toBeUndefined();

    expect(mockRecordFeedbackByResponseContextKey).toHaveBeenCalledWith('response-key', 'positive');
    expect(testClient.sendText).toHaveBeenCalledWith(
      conversation,
      renderWhatsAppExpiredAction(),
    );
    expect(mockMarkWhatsAppEventVisible).toHaveBeenCalledWith('wamid.action');
    expect(mockReleaseWhatsAppEventClaim).not.toHaveBeenCalled();
  });

  it('sends expired-action copy when a SQL action has no response context', async () => {
    mockGetWhatsAppActionContext.mockResolvedValue(storedAction('show_sql'));
    mockGetResponseContext.mockResolvedValue(null);
    const testClient = client();

    await handleWhatsAppActions([action('wa:v1:show_sql:ctx_sql')], deps(testClient));

    expect(mockGetResponseContext).toHaveBeenCalledWith('response-key');
    expect(testClient.sendText).toHaveBeenCalledWith(
      conversation,
      expect.stringContaining('cannot find that answer context'),
    );
    expect(mockMarkWhatsAppEventVisible).toHaveBeenCalledWith('wamid.action');
  });

  it('sends expired-action copy when the action context is missing after claim', async () => {
    mockGetWhatsAppActionContext.mockResolvedValue(null);
    const testClient = client();

    await handleWhatsAppActions([action('wa:v1:show_sql:ctx_missing')], deps(testClient));

    expect(mockGetWhatsAppActionContext).toHaveBeenCalledWith('ctx_missing');
    expect(testClient.sendText).toHaveBeenCalledWith(
      conversation,
      renderWhatsAppExpiredAction(),
    );
    expect(mockMarkWhatsAppEventVisible).toHaveBeenCalledWith('wamid.action');
    expect(mockReleaseWhatsAppEventClaim).not.toHaveBeenCalled();
  });

  it('sends expired-action copy when the action context belongs to another user', async () => {
    mockGetWhatsAppActionContext.mockResolvedValue({
      ...storedAction('show_sql'),
      userId: '15550000000',
    });
    const testClient = client();

    await handleWhatsAppActions([action('wa:v1:show_sql:ctx_wrong_user')], deps(testClient));

    expect(testClient.sendText).toHaveBeenCalledWith(
      conversation,
      renderWhatsAppExpiredAction(),
    );
    expect(mockMarkWhatsAppEventVisible).toHaveBeenCalledWith('wamid.action');
    expect(mockReleaseWhatsAppEventClaim).not.toHaveBeenCalled();
  });

  it('renders generated SQL from persisted response context without re-querying', async () => {
    mockGetWhatsAppActionContext.mockResolvedValue(storedAction('show_sql'));
    mockGetResponseContext.mockResolvedValue(ctx());
    const testClient = client();

    await handleWhatsAppActions([action('wa:v1:show_sql:ctx_sql')], deps(testClient));

    expect(testClient.sendText).toHaveBeenCalledWith(
      conversation,
      expect.stringContaining('SELECT 1'),
    );
    expect(mockRecordFeedbackByResponseContextKey).not.toHaveBeenCalled();
    expect(testClient.sendInteractive).not.toHaveBeenCalled();
  });

  it('renders reasoning from persisted response context', async () => {
    mockGetWhatsAppActionContext.mockResolvedValue(storedAction('show_reasoning'));
    mockGetResponseContext.mockResolvedValue(ctx({
      groundingCitations: [{
        sourceFile: 'reference_card:revenue',
        chunkText: 'Revenue uses completed orders.',
        relevanceScore: 0.95,
      }],
    }));
    const testClient = client();

    await handleWhatsAppActions([action('wa:v1:show_reasoning:ctx_reasoning')], deps(testClient));

    expect(testClient.sendText).toHaveBeenCalledWith(
      conversation,
      expect.stringContaining('Reasoning'),
    );
    expect(testClient.sendText).toHaveBeenCalledWith(
      conversation,
      expect.stringContaining('reference_card:revenue'),
    );
  });

  it.each([
    ['reason_wrong_number', 'wa:v1:reason_wrong_number:ctx_reason_wrong_number'],
    ['reason_wrong_data', 'wa:v1:reason_wrong_data:ctx_reason_wrong_data'],
  ] as const)('records negative feedback for %s', async (kind, actionId) => {
    mockGetWhatsAppActionContext.mockResolvedValue(storedAction(kind));
    const testClient = client();

    await handleWhatsAppActions([action(actionId)], deps(testClient));

    expect(mockRecordFeedbackByResponseContextKey).toHaveBeenCalledWith('response-key', 'negative');
    expect(testClient.sendText).toHaveBeenCalledWith(
      conversation,
      renderWhatsAppFeedbackAck('negative'),
    );
  });

  it('records negative feedback and asks for the intended question', async () => {
    mockGetWhatsAppActionContext.mockResolvedValue(storedAction('reason_not_asked'));
    const testClient = client();

    await handleWhatsAppActions([action('wa:v1:reason_not_asked:ctx_reason_not_asked')], deps(testClient));

    expect(mockRecordFeedbackByResponseContextKey).toHaveBeenCalledWith('response-key', 'negative');
    expect(testClient.sendText).toHaveBeenCalledWith(
      conversation,
      'Got it. Reply with the question you meant to ask, and I will take another run at it.',
    );
  });

  it('starts pending free-text feedback on reason_other', async () => {
    mockGetWhatsAppActionContext.mockResolvedValue({
      id: 'ctx_other',
      kind: 'reason_other',
      responseContextKey: 'response-key',
      conversationId: 'whatsapp:15551234567',
      userId: '15551234567',
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    });
    mockGetResponseContext.mockResolvedValue(ctx());
    const testClient = client();

    await handleWhatsAppActions([action('wa:v1:reason_other:ctx_other')], {
      client: testClient,
      tables: [],
      config: {} as any,
      rateLimitPerHour: 30,
      allowedWaIds: ['15551234567'],
    });

    expect(mockGetResponseContext).toHaveBeenCalledWith('response-key');
    expect(mockSaveWhatsAppPendingFeedback).toHaveBeenCalledWith({
      conversationId: 'whatsapp:15551234567',
      userId: '15551234567',
      responseContextKey: 'response-key',
      traceId: 'trace-1',
      clarifiedQuestion: 'What was revenue?',
    });
    expect(testClient.sendText).toHaveBeenCalledWith(
      conversation,
      'Reply with what was wrong, and I will attach it to this answer.',
    );
  });

  it('sends expired-action copy when reason_other response context is missing', async () => {
    mockGetWhatsAppActionContext.mockResolvedValue(storedAction('reason_other'));
    mockGetResponseContext.mockResolvedValue(null);
    const testClient = client();

    await handleWhatsAppActions([action('wa:v1:reason_other:ctx_other')], deps(testClient));

    expect(mockGetResponseContext).toHaveBeenCalledWith('response-key');
    expect(mockSaveWhatsAppPendingFeedback).not.toHaveBeenCalled();
    expect(testClient.sendText).toHaveBeenCalledWith(
      conversation,
      renderWhatsAppExpiredAction(),
    );
    expect(mockMarkWhatsAppEventVisible).toHaveBeenCalledWith('wamid.action');
  });

  it('sends problem reason picker and creates child action contexts', async () => {
    mockGetWhatsAppActionContext.mockResolvedValue(storedAction('problem'));
    mockCreateWhatsAppActionContext
      .mockResolvedValueOnce('ctx_wrong_number')
      .mockResolvedValueOnce('ctx_wrong_data')
      .mockResolvedValueOnce('ctx_not_asked')
      .mockResolvedValueOnce('ctx_other');
    const testClient = client();

    await handleWhatsAppActions([action('wa:v1:problem:ctx_problem')], deps(testClient));

    expect(mockCreateWhatsAppActionContext).toHaveBeenCalledTimes(4);
    expect(mockCreateWhatsAppActionContext).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'reason_wrong_number',
      responseContextKey: 'response-key',
      conversationId: conversation.conversationId,
      userId: conversation.userId,
    }));
    expect(mockCreateWhatsAppActionContext).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'reason_other',
      responseContextKey: 'response-key',
      conversationId: conversation.conversationId,
      userId: conversation.userId,
    }));
    expect(testClient.sendInteractive).toHaveBeenCalledWith(
      conversation,
      expect.objectContaining({
        kind: 'list',
        buttonText: 'Choose reason',
        sections: [expect.objectContaining({
          rows: [
            expect.objectContaining({ id: 'wa:v1:reason_wrong_number:ctx_wrong_number' }),
            expect.objectContaining({ id: 'wa:v1:reason_wrong_data:ctx_wrong_data' }),
            expect.objectContaining({ id: 'wa:v1:reason_not_asked:ctx_not_asked' }),
            expect.objectContaining({ id: 'wa:v1:reason_other:ctx_other' }),
          ],
        })],
      }),
    );
  });

  it('sends actions list and creates child action contexts', async () => {
    mockGetWhatsAppActionContext.mockResolvedValue(storedAction('actions'));
    mockGetResponseContext.mockResolvedValue(ctx({
      queryResults: { rowCount: 25, columnNames: ['source', 'sessions'], bytesProcessed: 0 },
    }));
    mockCreateWhatsAppActionContext
      .mockResolvedValueOnce('ctx_reasoning')
      .mockResolvedValueOnce('ctx_sql')
      .mockResolvedValueOnce('ctx_table')
      .mockResolvedValueOnce('ctx_summary');
    const testClient = client();

    await handleWhatsAppActions([action('wa:v1:actions:ctx_actions')], deps(testClient));

    expect(mockGetResponseContext).toHaveBeenCalledWith('response-key');
    expect(mockCreateWhatsAppActionContext).toHaveBeenCalledTimes(4);
    expect(mockCreateWhatsAppActionContext).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'show_reasoning',
      responseContextKey: 'response-key',
      conversationId: conversation.conversationId,
      userId: conversation.userId,
    }));
    expect(mockCreateWhatsAppActionContext).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'override_summary',
      responseContextKey: 'response-key',
      conversationId: conversation.conversationId,
      userId: conversation.userId,
    }));
    expect(testClient.sendInteractive).toHaveBeenCalledWith(
      conversation,
      expect.objectContaining({
        kind: 'list',
        buttonText: 'Open actions',
        sections: [expect.objectContaining({
          rows: [
            expect.objectContaining({ id: 'wa:v1:show_reasoning:ctx_reasoning' }),
            expect.objectContaining({ id: 'wa:v1:show_sql:ctx_sql' }),
            expect.objectContaining({ id: 'wa:v1:override_table:ctx_table' }),
            expect.objectContaining({ id: 'wa:v1:override_summary:ctx_summary' }),
          ],
        })],
      }),
    );
  });

  it('sends expired-action copy and does not create child actions when actions context is missing', async () => {
    mockGetWhatsAppActionContext.mockResolvedValue(storedAction('actions'));
    mockGetResponseContext.mockResolvedValue(null);
    const testClient = client();

    await handleWhatsAppActions([action('wa:v1:actions:ctx_actions')], deps(testClient));

    expect(mockGetResponseContext).toHaveBeenCalledWith('response-key');
    expect(mockCreateWhatsAppActionContext).not.toHaveBeenCalled();
    expect(testClient.sendInteractive).not.toHaveBeenCalled();
    expect(testClient.sendText).toHaveBeenCalledWith(
      conversation,
      renderWhatsAppExpiredAction(),
    );
    expect(mockMarkWhatsAppEventVisible).toHaveBeenCalledWith('wamid.action');
  });

  it('dispatches table override actions', async () => {
    const responseContext = ctx();
    mockGetWhatsAppActionContext.mockResolvedValue(storedAction('override_table'));
    mockGetResponseContext.mockResolvedValue(responseContext);
    mockRenderWhatsAppTableOverride.mockResolvedValue('table text');
    const testClient = client();

    await handleWhatsAppActions([action('wa:v1:override_table:ctx_table')], deps(testClient));

    expect(mockGetResponseContext).toHaveBeenCalledWith('response-key');
    expect(mockRenderWhatsAppTableOverride).toHaveBeenCalledWith(responseContext, {
      geminiApiKey: 'gemini-key',
      maxBytesProcessed: 1_000,
      maxResultRows: 10,
      queryTimeoutMs: 30_000,
    });
    expect(testClient.sendText).toHaveBeenCalledWith(conversation, 'table text');
    expect(mockMarkWhatsAppEventVisible).toHaveBeenCalledWith('wamid.action');
  });

  it('dispatches summary override actions', async () => {
    const responseContext = ctx();
    mockGetWhatsAppActionContext.mockResolvedValue(storedAction('override_summary'));
    mockGetResponseContext.mockResolvedValue(responseContext);
    mockRenderWhatsAppSummaryOverride.mockResolvedValue('summary text');
    const testClient = client();

    await handleWhatsAppActions([action('wa:v1:override_summary:ctx_summary')], deps(testClient));

    expect(mockGetResponseContext).toHaveBeenCalledWith('response-key');
    expect(mockRenderWhatsAppSummaryOverride).toHaveBeenCalledWith(responseContext, {
      geminiApiKey: 'gemini-key',
      maxBytesProcessed: 1_000,
      maxResultRows: 10,
      queryTimeoutMs: 30_000,
    });
    expect(testClient.sendText).toHaveBeenCalledWith(conversation, 'summary text');
    expect(mockMarkWhatsAppEventVisible).toHaveBeenCalledWith('wamid.action');
  });

  it.each([
    ['override_table', 'wa:v1:override_table:ctx_table'],
    ['override_summary', 'wa:v1:override_summary:ctx_summary'],
  ] as const)('sends expired-action copy when %s response context is missing', async (kind, actionId) => {
    mockGetWhatsAppActionContext.mockResolvedValue(storedAction(kind));
    mockGetResponseContext.mockResolvedValue(null);
    const testClient = client();

    await handleWhatsAppActions([action(actionId)], deps(testClient));

    expect(mockGetResponseContext).toHaveBeenCalledWith('response-key');
    expect(mockRenderWhatsAppTableOverride).not.toHaveBeenCalled();
    expect(mockRenderWhatsAppSummaryOverride).not.toHaveBeenCalled();
    expect(testClient.sendText).toHaveBeenCalledWith(
      conversation,
      renderWhatsAppExpiredAction(),
    );
    expect(mockMarkWhatsAppEventVisible).toHaveBeenCalledWith('wamid.action');
  });

  it.each([
    ['override_table', 'wa:v1:override_table:ctx_table', mockRenderWhatsAppTableOverride],
    ['override_summary', 'wa:v1:override_summary:ctx_summary', mockRenderWhatsAppSummaryOverride],
  ] as const)('sends a safe visible error when %s rendering fails', async (_kind, actionId, helper) => {
    const responseContext = ctx({ traceId: 'trace-safe-error' });
    mockGetWhatsAppActionContext.mockResolvedValue(storedAction(_kind));
    mockGetResponseContext.mockResolvedValue(responseContext);
    helper.mockRejectedValue(new Error('BigQuery timeout'));
    const testClient = client();

    await expect(handleWhatsAppActions([action(actionId)], deps(testClient)))
      .resolves.toBeUndefined();

    expect(testClient.sendText).toHaveBeenCalledWith(
      conversation,
      renderWhatsAppSafeError('trace-safe-error'),
    );
    expect(vi.mocked(rootLogger.error)).toHaveBeenCalledWith(
      expect.objectContaining({
        traceId: 'trace-safe-error',
        error: 'BigQuery timeout',
        actionKind: _kind,
      }),
      'whatsapp.override_action_failed',
    );
    expect(mockMarkWhatsAppEventVisible).toHaveBeenCalledWith('wamid.action');
    expect(mockReleaseWhatsAppEventClaim).not.toHaveBeenCalled();
  });

  it('releases the event claim when a rendered override response cannot be sent', async () => {
    const responseContext = ctx({ traceId: 'trace-send-failed' });
    mockGetWhatsAppActionContext.mockResolvedValue(storedAction('override_table'));
    mockGetResponseContext.mockResolvedValue(responseContext);
    mockRenderWhatsAppTableOverride.mockResolvedValue('table text');
    const testClient = client();
    vi.mocked(testClient.sendText)
      .mockRejectedValueOnce(new Error('WhatsApp send failed'))
      .mockResolvedValueOnce({ messageId: 'safe-error' });

    await expect(handleWhatsAppActions([action('wa:v1:override_table:ctx_table')], deps(testClient)))
      .rejects.toThrow('WhatsApp send failed');

    expect(testClient.sendText).toHaveBeenCalledTimes(1);
    expect(mockReleaseWhatsAppEventClaim).toHaveBeenCalledWith('wamid.action');
    expect(mockMarkWhatsAppEventVisible).not.toHaveBeenCalled();
  });

  it('ignores disallowed users before claiming the action', async () => {
    const testClient = client();

    await handleWhatsAppActions([action('wa:v1:ok:ctx_ok')], deps(testClient, ['15550000000']));

    expect(mockClaimWhatsAppEvent).not.toHaveBeenCalled();
    expect(testClient.sendText).not.toHaveBeenCalled();
    expect(testClient.sendInteractive).not.toHaveBeenCalled();
  });

  it('skips duplicate provider action events', async () => {
    mockClaimWhatsAppEvent.mockResolvedValue(false);
    const testClient = client();

    await handleWhatsAppActions([action('wa:v1:ok:ctx_ok')], deps(testClient));

    expect(mockGetWhatsAppActionContext).not.toHaveBeenCalled();
    expect(testClient.sendText).not.toHaveBeenCalled();
    expect(mockMarkWhatsAppEventVisible).not.toHaveBeenCalled();
  });

  it('releases the event claim when an error happens before a visible response', async () => {
    mockGetWhatsAppActionContext.mockResolvedValue(storedAction('ok'));
    mockRecordFeedbackByResponseContextKey.mockRejectedValue(new Error('firestore down'));

    await expect(handleWhatsAppActions([action('wa:v1:ok:ctx_ok')], deps()))
      .rejects.toThrow('firestore down');

    expect(mockReleaseWhatsAppEventClaim).toHaveBeenCalledWith('wamid.action');
    expect(mockMarkWhatsAppEventVisible).not.toHaveBeenCalled();
  });
});
