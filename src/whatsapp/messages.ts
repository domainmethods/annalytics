import type { ChannelClient, ChannelMessage } from '../channels/types.js';
import type { TableContext } from '../dbt/types.js';
import type { PipelineConfig } from '../pipeline.js';
import { checkRateLimit } from '../state/rateLimiter.js';
import { getClarificationState, deleteClarificationState } from '../state/clarificationState.js';
import { getEscalationByThread } from '../state/escalationState.js';
import { saveResponseContext } from '../state/responseContext.js';
import {
  claimWhatsAppEvent,
  markWhatsAppEventVisible,
  releaseWhatsAppEventClaim,
} from '../state/whatsappEventDedupe.js';
import type { UnsupportedWhatsAppMessage } from './payload.js';
import { answerWhatsAppQuestion, runWhatsAppPipeline } from './pipeline.js';
import { renderWhatsAppUnsupported } from './renderer.js';

export interface HandleWhatsAppMessagesDeps {
  client: ChannelClient;
  tables: TableContext[];
  config: PipelineConfig;
  rateLimitPerHour: number;
  allowedWaIds: string[];
}

function isAllowed(userId: string, allowedWaIds: readonly string[]): boolean {
  return allowedWaIds.length === 0 || allowedWaIds.includes(userId);
}

function clarifiedMessage(inbound: ChannelMessage, originalQuestion: string): ChannelMessage {
  return {
    ...inbound,
    text: `${originalQuestion} (Clarification: ${inbound.text})`,
  };
}

export async function handleWhatsAppMessages(
  messages: ChannelMessage[],
  deps: HandleWhatsAppMessagesDeps,
): Promise<void> {
  for (const inbound of messages) {
    if (!isAllowed(inbound.conversation.userId, deps.allowedWaIds)) continue;

    const claimed = await claimWhatsAppEvent(inbound.providerMessageId);
    if (!claimed) continue;

    let visibleResponse = false;

    try {
      const rateCheck = await checkRateLimit(
        inbound.conversation.conversationId,
        deps.rateLimitPerHour,
      );
      if (!rateCheck.allowed) {
        const retryAfter = rateCheck.retryAfterMinutes ?? 60;
        await deps.client.sendText(
          inbound.conversation,
          `You've hit the query limit (${deps.rateLimitPerHour}/hour). Resets in ${retryAfter} minutes.`,
        );
        visibleResponse = true;
        await markWhatsAppEventVisible(inbound.providerMessageId).catch(() => {});
        continue;
      }

      const clarification = await getClarificationState(inbound.conversation.conversationId);
      const escalationLookup = await getEscalationByThread(inbound.conversation.conversationId);
      if (escalationLookup?.status === 'pending') {
        await deps.client.sendText(
          inbound.conversation,
          "I'm still waiting for the data team on your previous question.",
        );
        visibleResponse = true;
        await markWhatsAppEventVisible(inbound.providerMessageId).catch(() => {});
        continue;
      }

      const messageForPipeline = clarification
        ? clarifiedMessage(inbound, clarification.originalQuestion)
        : inbound;

      const result = await runWhatsAppPipeline({
        message: messageForPipeline,
        client: deps.client,
        answerQuestion: input => answerWhatsAppQuestion({
          ...input,
          tables: deps.tables,
          config: deps.config,
        }),
        saveResponseContext,
        markVisible: () => markWhatsAppEventVisible(inbound.providerMessageId),
      });
      visibleResponse = result.visible;

      if (clarification && result.outcome !== 'clarification') {
        await deleteClarificationState(clarification.clarificationId);
      }
    } catch (err) {
      if (!visibleResponse) {
        await releaseWhatsAppEventClaim(inbound.providerMessageId).catch(() => {});
      }
      throw err;
    }
  }
}

export async function handleUnsupportedWhatsAppMessages(
  messages: UnsupportedWhatsAppMessage[],
  deps: HandleWhatsAppMessagesDeps,
): Promise<void> {
  for (const inbound of messages) {
    if (!isAllowed(inbound.conversation.userId, deps.allowedWaIds)) continue;

    const claimed = await claimWhatsAppEvent(inbound.providerMessageId);
    if (!claimed) continue;

    let visibleResponse = false;
    try {
      await deps.client.sendText(inbound.conversation, renderWhatsAppUnsupported());
      visibleResponse = true;
      await markWhatsAppEventVisible(inbound.providerMessageId).catch(() => {});
    } catch (err) {
      if (!visibleResponse) {
        await releaseWhatsAppEventClaim(inbound.providerMessageId).catch(() => {});
      }
      throw err;
    }
  }
}
