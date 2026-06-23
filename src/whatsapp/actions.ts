import type { WhatsAppClient } from './client.js';
import type { WhatsAppInteractiveAction } from './payload.js';
import type { TableContext } from '../dbt/types.js';
import type { PipelineConfig } from '../pipeline.js';
import {
  claimWhatsAppEvent,
  markWhatsAppEventVisible,
  releaseWhatsAppEventClaim,
} from '../state/whatsappEventDedupe.js';
import {
  createWhatsAppActionContext,
  getWhatsAppActionContext,
} from '../state/whatsappActionContext.js';
import {
  getResponseContext,
  recordFeedbackByResponseContextKey,
} from '../state/responseContext.js';
import { buildWhatsAppActionId, parseWhatsAppActionId, type WhatsAppActionKind } from './actionIds.js';
import { buildAnswerActionsList, buildProblemReasonPicker } from './interactive.js';
import {
  renderWhatsAppExpiredAction,
  renderWhatsAppFeedbackAck,
  renderWhatsAppReasoning,
  renderWhatsAppSql,
} from './renderer.js';

export interface HandleWhatsAppActionsDeps {
  client: WhatsAppClient;
  tables: TableContext[];
  config: PipelineConfig;
  rateLimitPerHour: number;
  allowedWaIds: string[];
}

function isAllowed(userId: string, allowedWaIds: readonly string[]): boolean {
  return allowedWaIds.length === 0 || allowedWaIds.includes(userId);
}

async function createActionId(input: {
  kind: WhatsAppActionKind;
  responseContextKey: string;
  conversationId: string;
  userId: string;
}): Promise<string> {
  const contextId = await createWhatsAppActionContext(input);
  return buildWhatsAppActionId(input.kind, contextId);
}

async function loadAction(
  actionId: string,
  actionConversationId: string,
  actionUserId: string,
) {
  const parsed = parseWhatsAppActionId(actionId);
  if (!parsed) return null;
  const stored = await getWhatsAppActionContext(parsed.contextId);
  if (!stored) return null;
  if (stored.kind !== parsed.kind) return null;
  if (stored.conversationId !== actionConversationId) return null;
  if (stored.userId !== actionUserId) return null;
  return { kind: parsed.kind, context: stored };
}

async function sendProblemPicker(
  action: WhatsAppInteractiveAction,
  deps: HandleWhatsAppActionsDeps,
  responseContextKey: string,
): Promise<void> {
  const base = {
    responseContextKey,
    conversationId: action.conversation.conversationId,
    userId: action.conversation.userId,
  };

  const wrongNumberId = await createActionId({ ...base, kind: 'reason_wrong_number' });
  const wrongDataId = await createActionId({ ...base, kind: 'reason_wrong_data' });
  const notAskedId = await createActionId({ ...base, kind: 'reason_not_asked' });
  const otherId = await createActionId({ ...base, kind: 'reason_other' });

  await deps.client.sendInteractive(
    action.conversation,
    buildProblemReasonPicker({
      wrongNumberId,
      wrongDataId,
      notAskedId,
      otherId,
    }),
  );
}

async function sendActionsList(
  action: WhatsAppInteractiveAction,
  deps: HandleWhatsAppActionsDeps,
  responseContextKey: string,
): Promise<void> {
  const responseContext = await getResponseContext(responseContextKey);
  const rowCount = responseContext?.queryResults.rowCount ?? 0;
  const columnCount = responseContext?.queryResults.columnNames.length ?? 0;
  const base = {
    responseContextKey,
    conversationId: action.conversation.conversationId,
    userId: action.conversation.userId,
  };

  const showReasoningId = await createActionId({ ...base, kind: 'show_reasoning' });
  const showSqlId = await createActionId({ ...base, kind: 'show_sql' });
  const tableId = await createActionId({ ...base, kind: 'override_table' });
  const summaryId = await createActionId({ ...base, kind: 'override_summary' });

  await deps.client.sendInteractive(
    action.conversation,
    buildAnswerActionsList({
      showReasoningId,
      showSqlId,
      tableId,
      summaryId,
      rowCount,
      columnCount,
    }),
  );
}

export async function handleWhatsAppActions(
  actions: WhatsAppInteractiveAction[],
  deps: HandleWhatsAppActionsDeps,
): Promise<void> {
  for (const action of actions) {
    if (!isAllowed(action.conversation.userId, deps.allowedWaIds)) continue;

    const claimed = await claimWhatsAppEvent(action.providerMessageId);
    if (!claimed) continue;

    let visibleResponse = false;
    try {
      const loaded = await loadAction(
        action.actionId,
        action.conversation.conversationId,
        action.conversation.userId,
      );
      if (!loaded) continue;

      const { responseContextKey } = loaded.context;
      switch (loaded.kind) {
        case 'ok':
          await recordFeedbackByResponseContextKey(responseContextKey, 'positive');
          await deps.client.sendText(action.conversation, renderWhatsAppFeedbackAck('positive'));
          visibleResponse = true;
          break;

        case 'problem':
          await sendProblemPicker(action, deps, responseContextKey);
          visibleResponse = true;
          break;

        case 'actions':
          await sendActionsList(action, deps, responseContextKey);
          visibleResponse = true;
          break;

        case 'reason_wrong_number':
        case 'reason_wrong_data':
          await recordFeedbackByResponseContextKey(responseContextKey, 'negative');
          await deps.client.sendText(action.conversation, renderWhatsAppFeedbackAck('negative'));
          visibleResponse = true;
          break;

        case 'reason_not_asked':
          await recordFeedbackByResponseContextKey(responseContextKey, 'negative');
          await deps.client.sendText(
            action.conversation,
            'Got it. Reply with the question you meant to ask, and I will take another run at it.',
          );
          visibleResponse = true;
          break;

        case 'show_sql': {
          const responseContext = await getResponseContext(responseContextKey);
          await deps.client.sendText(
            action.conversation,
            responseContext
              ? renderWhatsAppSql(responseContext.generatedSql, responseContext.traceId)
              : renderWhatsAppExpiredAction(),
          );
          visibleResponse = true;
          break;
        }

        case 'show_reasoning': {
          const responseContext = await getResponseContext(responseContextKey);
          await deps.client.sendText(
            action.conversation,
            responseContext
              ? renderWhatsAppReasoning({
                explanation: responseContext.explanation,
                assumptions: responseContext.assumptions,
                reasoningChain: responseContext.reasoningChain,
                supervisorNotes: responseContext.supervisorNotes,
                groundingCitations: responseContext.groundingCitations
                  .map(citation => ({ sourceFile: citation.sourceFile })),
                traceId: responseContext.traceId,
              })
              : renderWhatsAppExpiredAction(),
          );
          visibleResponse = true;
          break;
        }

        case 'reason_other':
        case 'override_table':
        case 'override_summary':
          break;
      }

      if (visibleResponse) {
        await markWhatsAppEventVisible(action.providerMessageId).catch(() => {});
      }
    } catch (err) {
      if (!visibleResponse) {
        await releaseWhatsAppEventClaim(action.providerMessageId).catch(() => {});
      }
      throw err;
    }
  }
}
