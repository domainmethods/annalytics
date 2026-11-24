import { randomUUID } from 'node:crypto';
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
  hasPendingClarification,
  isOwnedByMentionListener,
  type ClarificationReply,
} from './messages.js';
import { maybeHandleSlackIntake } from './slackIntake.js';
import { checkEscalationResponse, resumeFromEscalation } from './escalationResponse.js';
import { checkOverdueEscalations } from './escalationLifecycle.js';
import { checkRateLimit } from '../state/rateLimiter.js';
import { acquireThreadLock, releaseThreadLock } from '../state/threadLock.js';
import { botHasRepliedInThread } from '../state/responseContext.js';
import {
  claimSlackEvent,
  extractSlackEventId,
  markSlackEventVisible,
  releaseSlackEventClaim,
} from '../state/slackEventDedupe.js';
import { preflightChecks, THREAD_BUSY_TEXT } from './preflightChecks.js';
import { markThreadParticipation } from './threadParticipationMark.js';
import { runPipeline, toPipelineConfig } from '../pipeline.js';
import { classifyFollowUp, type FollowUpIntent } from '../agents/followUpClassifier.js';
import { routeFollowUp } from './followUpRouter.js';
import { finishRefinementTarget, lookupRefinementTarget, REFINE_LOOKUP_FAILED_TEXT } from './refinePrompt.js';
import { buildThreadContext } from '../slack/threadContext.js';
import { buildAnsweredClarificationBlocks } from '../slack/clarificationBlocks.js';
import { createTraceId, rootLogger } from '../logging.js';
import { friendlyErrorMessage } from '../errors.js';
import { notifyEscalationTimeout } from '../slack/escalationTimeout.js';

/** The first thing a user sees in reply; the pipeline rewrites it as it works. */
const STATUS_PLACEHOLDER_TEXT = 'Got it. Let me get things ready...';

/**
 * Takes the thread lock for a clarification answer. It is taken before the
 * answer is, so an answer is never consumed by a run that can't have the
 * thread. `busy`: another run holds the thread. `unavailable`: the lock could
 * not be tried at all, and the resume then runs without one, because a user who
 * answered must still get their answer.
 */
async function lockThreadForResume(
  channel: string,
  threadTs: string,
  ownerToken: string,
): Promise<'held' | 'busy' | 'unavailable'> {
  try {
    return (await acquireThreadLock(channel, threadTs, ownerToken)) ? 'held' : 'busy';
  } catch (err) {
    rootLogger.warn({ error: (err as Error).message }, 'clarification.resume.lock_failed');
    return 'unavailable';
  }
}

/**
 * Picks the message a resumed clarification reports on. Normally that is a new
 * status message below the user's reply, and the clarifying questions stay in
 * the thread, redrawn without their Cancel button. When the new message can't
 * be posted, or the saved state has no questions to redraw (so the button would
 * be left live), the pipeline reuses the clarifying message itself, which
 * replaces the questions and the button with its status.
 */
async function startClarificationResume(reply: ClarificationReply, client: WebClient): Promise<string> {
  const questions = reply.clarifyingQuestions;
  if (!questions?.length) return reply.clarifyingMessageTs;

  let statusMsgTs: string | undefined;
  try {
    const statusMsg = await client.chat.postMessage({
      channel: reply.channel,
      thread_ts: reply.threadTs,
      text: STATUS_PLACEHOLDER_TEXT,
    });
    statusMsgTs = statusMsg.ts;
  } catch (err) {
    rootLogger.warn({ error: (err as Error).message }, 'clarification.resume.status_post_failed');
  }
  if (!statusMsgTs) return reply.clarifyingMessageTs;

  await client.chat
    .update({
      channel: reply.channel,
      ts: reply.clarifyingMessageTs,
      text: questions.join('\n'),
      blocks: buildAnsweredClarificationBlocks(questions),
    })
    .catch((err) =>
      rootLogger.warn({ error: (err as Error).message }, 'clarification.resume.question_redraw_failed'),
    );
  return statusMsgTs;
}

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
  app.event('message', async ({ event, body, client, context }) => {
    await handleMessageEvent({
      event: event as MessageEvent,
      body,
      client,
      config: getConfig(),
      getTables,
      botUserId: context.botUserId,
    });
  });
}

export interface HandleMessageEventParams {
  event: MessageEvent;
  body: unknown;
  client: WebClient;
  config: AppConfig;
  getTables: () => TableContext[];
  /** The bot's own user id, from Bolt. Unknown: no reply is left to the `app_mention` listener. */
  botUserId?: string;
}

export async function handleMessageEvent({
  event,
  body,
  client,
  config,
  getTables,
  botUserId,
}: HandleMessageEventParams): Promise<void> {
  // Skip bot messages, message_changed, etc.
  if ('bot_id' in event || 'subtype' in event) return;

  const msg = event as GenericMessageEvent;
  if (!canMessageEventReachPipeline(msg)) return;
  // The `app_mention` listener gets this message too, and owns it.
  if (isOwnedByMentionListener(msg, botUserId)) return;

  await handleSlackRequest({ request: msg, mentioned: false, body, client, config, getTables });
}

/** What the shared flow reads from a Slack event, whichever listener received it. */
export interface SlackRequest {
  channel: string;
  user: string;
  text?: string;
  ts: string;
  thread_ts?: string;
  channel_type?: string;
}

export interface HandleSlackRequestParams {
  request: SlackRequest;
  /**
   * True for an `app_mention` event. The bot was addressed, so it answers
   * wherever the message is, and `text` arrives with the mention removed.
   */
  mentioned: boolean;
  body: unknown;
  client: WebClient;
  config: AppConfig;
  getTables: () => TableContext[];
}

/**
 * One flow for a message and for an @mention: clarification answers, escalation
 * replies, rate limit, preflight, refine targets, intake, follow-up routing and
 * the pipeline.
 */
export async function handleSlackRequest({
  request: msg,
  mentioned,
  body,
  client,
  config,
  getTables,
}: HandleSlackRequestParams): Promise<void> {
  const threadTs = msg.thread_ts || msg.ts;
  const eventId = extractSlackEventId(body);
  let visibleResponse = false;
  const ownerToken = randomUUID();
  let lockHeld = false;
  const shouldProcess = await claimSlackEvent(eventId);
  if (!shouldProcess) return;

  try {
    // Non-blocking lifecycle check: reminders + timeouts for pending escalations
    checkOverdueEscalations(client, config.escalation).catch(err =>
      rootLogger.error({ error: (err as Error).message }, 'escalation.lifecycle.error'),
    );

    // A reply to a pending clarification is the user's answer. Checked FIRST.
    if (await hasPendingClarification(msg)) {
      const lock = await lockThreadForResume(msg.channel, threadTs, ownerToken);
      if (lock === 'busy') {
        // Another run has the thread. The answer stays pending and the user is
        // told to wait, here. Sent on as an ordinary message, it would count
        // against the rate limit, and preflight would ask for the answer again
        // if the other run let go of the thread in between.
        await client.chat.postMessage({ channel: msg.channel, thread_ts: threadTs, text: THREAD_BUSY_TEXT });
        visibleResponse = true;
        await markSlackEventVisible(eventId).catch(() => {});
        return;
      }
      lockHeld = lock === 'held';
      const clarificationReply = await checkClarificationReply(msg);
      if (clarificationReply) {
        visibleResponse = true;
        await markSlackEventVisible(eventId).catch(() => {});
        const statusMsgTs = await startClarificationResume(clarificationReply, client);
        // Resume pipeline with clarified question. Up to this point `lockHeld`
        // has the `catch` below release the lock if anything throws. From here
        // the pipeline owns the lock, when it was taken, and releases it itself.
        const resumeLock = lockHeld ? { ownerToken } : {};
        lockHeld = false;
        await runPipeline({
          ...resumeLock,
          question: clarificationReply.clarifiedQuestion,
          originalQuestion: clarificationReply.originalQuestion,
          channel: clarificationReply.channel,
          threadTs: clarificationReply.threadTs,
          statusMsgTs,
          client,
          tables: getTables(),
          config: toPipelineConfig(config),
        });
        return;
      }
      // Another reply took the clarification between the lookup and the claim.
      // Give the lock back: this one is an ordinary thread message.
      if (lockHeld) {
        await releaseThreadLock(msg.channel, threadTs, ownerToken).catch(() => {});
        lockHeld = false;
      }
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

    // An unmentioned message is answered only where the bot already is, so a
    // thread reply there can be a follow-up to something the bot said. A mention
    // is always answered, but it can be the bot's first message in the thread,
    // and then there is nothing for it to follow up on.
    let classifyFollowUps = Boolean(msg.thread_ts);
    if (mentioned) {
      classifyFollowUps = msg.thread_ts ? await botHasRepliedInThread(msg.channel, msg.thread_ts) : false;
    } else if (!(await shouldRespond(msg))) {
      return;
    }

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
    const passed = await preflightChecks(msg.channel, threadTs, client, ownerToken);
    if (!passed) return;
    lockHeld = true;

    // A reply to a refine prompt is that user's correction to the answer they
    // picked (#51). Take the target before intake so a short correction can't
    // get a canned intake reply and leave the target to hijack a later message.
    const refinementLookup = msg.thread_ts
      ? await lookupRefinementTarget(msg.channel, threadTs, msg.user)
      : { status: 'none' as const };
    if (refinementLookup.status === 'failed') {
      await client.chat.postMessage({ channel: msg.channel, thread_ts: threadTs, text: REFINE_LOOKUP_FAILED_TEXT });
      visibleResponse = true;
      await markSlackEventVisible(eventId).catch(() => {});
      await releaseThreadLock(msg.channel, threadTs, ownerToken).catch(() => {});
      lockHeld = false;
      return;
    }
    const refinementTargetKey = refinementLookup.status === 'found' ? refinementLookup.key : null;

    const handledByIntake = !refinementTargetKey && await maybeHandleSlackIntake({
      text: msg.text || '',
      channel: msg.channel,
      threadTs,
      apiKey: config.gemini.apiKey,
      client,
      markVisible: () => markSlackEventVisible(eventId),
      releaseLock: () => releaseThreadLock(msg.channel, threadTs, ownerToken),
    });
    if (handledByIntake) {
      visibleResponse = true;
      lockHeld = false;
      return;
    }

    const statusMsg = await client.chat.postMessage({
      channel: msg.channel,
      thread_ts: threadTs,
      text: STATUS_PLACEHOLDER_TEXT,
    });
    visibleResponse = true;
    await Promise.all([
      // A mention can open a thread the bot was not in. Mark it, so that later
      // replies there reach the bot without a mention (#53).
      mentioned ? markThreadParticipation(msg.channel, threadTs) : undefined,
      markSlackEventVisible(eventId).catch(() => {}),
    ]);
    // Consume the target only now that the reply is visibly underway (#51).
    if (refinementTargetKey) await finishRefinementTarget(msg.channel, threadTs, msg.user, refinementTargetKey);

    // Follow-up intent routing for thread replies
    if (msg.thread_ts && (refinementTargetKey || classifyFollowUps)) {
      // Only a failed *classification* falls back to the standard pipeline.
      // Once a follow-up route is chosen, its failures must not start an
      // unrelated SQL run (#48).
      let intent: FollowUpIntent = 'new_query';
      // A refine-prompt reply skips classification and refines the picked answer.
      if (refinementTargetKey) {
        intent = 'refinement';
      } else {
        try {
          const threadMessages = await client.conversations.replies({
            channel: msg.channel,
            ts: threadTs,
            oldest: threadTs,
          });
          // The status message above is already in the thread; leave it out so
          // the follow-up is classified against what came before it.
          const threadContext = buildThreadContext(threadMessages.messages || [], 4, {
            summarizeOlder: true,
            stripQueryResults: true,
            maxTokens: 1000,
            excludeTs: statusMsg.ts,
          });
          if (threadContext.length > 0) {
            const followUp = await classifyFollowUp(msg.text || '', threadContext, config.gemini.apiKey);
            intent = followUp.intent;
            // Routing is the one place a reply is classified; log the route taken.
            rootLogger.info(
              { intent, reasoning: followUp.reasoning, channel: msg.channel, threadTs },
              'followup.classified',
            );
          }
        } catch (err) {
          // The thread read or the classification failed: fall through to
          // the standard pipeline.
          rootLogger.warn(
            { err: (err as Error).message, channel: msg.channel, threadTs },
            'followup.classify_failed',
          );
        }
      }
      if (intent !== 'new_query') {
        try {
          await routeFollowUp(
            intent, msg.text || '', threadTs, msg.channel, statusMsg.ts!,
            client, toPipelineConfig(config), getTables(),
            refinementTargetKey ? { refinementTargetKey } : {},
          );
        } catch (error) {
          const traceId = createTraceId();
          rootLogger.warn({ traceId, intent, err: (error as Error).message }, 'followup.route_failed');
          await client.chat.update({
            channel: msg.channel,
            ts: statusMsg.ts!,
            text: friendlyErrorMessage(error as Error, traceId),
          }).catch(() => {});
        }
        await releaseThreadLock(msg.channel, threadTs, ownerToken).catch(() => {});
        lockHeld = false;
        return;
      }
    }

    lockHeld = false;
    await runPipeline({
      ownerToken,
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
    if (lockHeld) await releaseThreadLock(msg.channel, threadTs, ownerToken).catch(() => {});
    throw error;
  }
}
