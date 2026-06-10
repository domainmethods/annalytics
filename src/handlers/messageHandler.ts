import type { App } from '@slack/bolt';
import type { WebClient } from '@slack/web-api';
import type { MessageEvent } from '@slack/types';
import type { GenericMessageEvent } from '@slack/types';
import type { AppConfig } from '../config.js';
import type { TableContext } from '../dbt/types.js';
import {
  canMessageEventReachPipeline,
  shouldRespond,
  checkClarificationReply,
} from './messages.js';
import { maybeHandleSlackIntake } from './slackIntake.js';
import { checkEscalationResponse, resumeFromEscalation } from './escalationResponse.js';
import { checkOverdueEscalations } from './escalationLifecycle.js';
import { checkRateLimit } from '../state/rateLimiter.js';
import { releaseThreadLock } from '../state/threadLock.js';
import {
  claimSlackEvent,
  extractSlackEventId,
  markSlackEventVisible,
  releaseSlackEventClaim,
} from '../state/slackEventDedupe.js';
import { preflightChecks } from './preflightChecks.js';
import { runPipeline, toPipelineConfig } from '../pipeline.js';
import { classifyFollowUp } from '../agents/followUpClassifier.js';
import { routeFollowUp } from './followUpRouter.js';
import { buildThreadContext } from '../slack/threadContext.js';
import { rootLogger } from '../logging.js';
import { notifyEscalationTimeout } from '../slack/escalationTimeout.js';

/**
 * Wire the `message` event (DMs + channel thread follow-ups) to {@link handleMessageEvent}.
 * Mirrors `registerMentions` / `registerCommands` so the orchestration lives in a
 * testable function instead of an inline closure in app.ts.
 */
export function registerMessageHandler(
  app: App,
  getConfig: () => AppConfig,
  getTables: () => TableContext[],
) {
  app.event('message', async ({ event, body, client }) => {
    await handleMessageEvent({ event: event as MessageEvent, body, client, config: getConfig(), getTables });
  });
}

export interface HandleMessageEventParams {
  event: MessageEvent;
  body: unknown;
  client: WebClient;
  config: AppConfig;
  getTables: () => TableContext[];
}

export async function handleMessageEvent({
  event,
  body,
  client,
  config,
  getTables,
}: HandleMessageEventParams): Promise<void> {
  // Skip bot messages, message_changed, etc.
  if ('bot_id' in event || 'subtype' in event) return;

  const msg = event as GenericMessageEvent;
  if (!canMessageEventReachPipeline(msg)) return;

  const eventId = extractSlackEventId(body);
  let visibleResponse = false;
  let lockHeld = false;
  const shouldProcess = await claimSlackEvent(eventId);
  if (!shouldProcess) return;

  try {
    // Non-blocking lifecycle check: reminders + timeouts for pending escalations
    checkOverdueEscalations(client, config.escalation).catch(err =>
      rootLogger.error({ error: (err as Error).message }, 'escalation.lifecycle.error'),
    );

    // Check for pending clarification reply FIRST
    const clarificationReply = await checkClarificationReply(msg);
    if (clarificationReply) {
      visibleResponse = true;
      await markSlackEventVisible(eventId).catch(() => {});
      // Resume pipeline with clarified question
      await runPipeline({
        question: clarificationReply.clarifiedQuestion,
        channel: clarificationReply.channel,
        threadTs: clarificationReply.threadTs,
        statusMsgTs: clarificationReply.clarifyingMessageTs,
        client,
        tables: getTables(),
        config: toPipelineConfig(config),
      });
      return;
    }

    // Check for escalation response (data team replying in escalation channel or DM)
    const isEscalationChannel = config.escalation.channelId && msg.channel === config.escalation.channelId;
    const isEscalationDm = config.escalation.mode === 'dm' && config.escalation.analystUserId;
    if ((isEscalationChannel || isEscalationDm) && msg.thread_ts) {
      const escalationCtx = await checkEscalationResponse(msg);
      if (escalationCtx) {
        visibleResponse = true;
        await markSlackEventVisible(eventId).catch(() => {});
        if (escalationCtx.status === 'expired_now') {
          await client.chat.postMessage({
            channel: escalationCtx.state.escalationChannel,
            thread_ts: escalationCtx.state.escalationTs,
            text: "This escalation timed out before your reply, so it wasn't applied. The requester was notified.",
          });
          await notifyEscalationTimeout(escalationCtx.state, client);
        } else {
          await resumeFromEscalation(escalationCtx.context, client, getTables(), toPipelineConfig(config));
        }
        return;
      }
    }

    const respond = await shouldRespond(msg);
    if (!respond) return;

    const threadTs = msg.thread_ts || msg.ts;

    // Rate limit check
    const rateCheck = await checkRateLimit(msg.user, config.limits.rateLimitPerHour);
    if (!rateCheck.allowed) {
      await client.chat.postMessage({
        channel: msg.channel,
        thread_ts: threadTs,
        text: `You've hit the query limit (${config.limits.rateLimitPerHour}/hour). Resets in ${rateCheck.retryAfterMinutes} minutes.`,
      });
      visibleResponse = true;
      await markSlackEventVisible(eventId).catch(() => {});
      return;
    }

    // Preflight: lock + clarification + escalation guards
    const passed = await preflightChecks(msg.channel, threadTs, client);
    if (!passed) return;
    lockHeld = true;

    const handledByIntake = await maybeHandleSlackIntake({
      text: msg.text || '',
      channel: msg.channel,
      threadTs,
      apiKey: config.gemini.apiKey,
      client,
      markVisible: () => markSlackEventVisible(eventId),
      releaseLock: () => releaseThreadLock(threadTs),
    });
    if (handledByIntake) {
      visibleResponse = true;
      lockHeld = false;
      return;
    }

    const statusMsg = await client.chat.postMessage({
      channel: msg.channel,
      thread_ts: threadTs,
      text: 'Got it. Let me get things ready...',
    });
    visibleResponse = true;
    await markSlackEventVisible(eventId).catch(() => {});

    // Follow-up intent routing for thread replies
    if (msg.thread_ts) {
      try {
        const threadMessages = await client.conversations.replies({
          channel: msg.channel,
          ts: threadTs,
          oldest: threadTs,
        });
        const threadContext = buildThreadContext(threadMessages.messages || [], 4, {
          summarizeOlder: true,
          stripQueryResults: true,
          maxTokens: 1000,
        });
        if (threadContext.length > 0) {
          const { intent } = await classifyFollowUp(msg.text || '', threadContext, config.gemini.apiKey);
          if (intent !== 'new_query') {
            await routeFollowUp(
              intent, msg.text || '', threadTs, msg.channel, statusMsg.ts!,
              client, toPipelineConfig(config), getTables(),
            );
            await releaseThreadLock(threadTs).catch(() => {});
            lockHeld = false;
            return;
          }
        }
      } catch {
        // Classification failed — fall through to standard pipeline
      }
    }

    lockHeld = false;
    await runPipeline({
      question: msg.text || '',
      channel: msg.channel,
      threadTs,
      statusMsgTs: statusMsg.ts!,
      client,
      tables: getTables(),
      config: toPipelineConfig(config),
    });
  } catch (error) {
    if (!visibleResponse) await releaseSlackEventClaim(eventId).catch(() => {});
    if (lockHeld) await releaseThreadLock(msg.thread_ts || msg.ts).catch(() => {});
    throw error;
  }
}
