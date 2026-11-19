import { randomUUID } from 'node:crypto';
import type { App } from '@slack/bolt';
import type { TableContext } from '../dbt/types.js';
import type { AppConfig } from '../config.js';
import { runPipeline, toPipelineConfig } from '../pipeline.js';
import { releaseThreadLock } from '../state/threadLock.js';
import { checkRateLimit } from '../state/rateLimiter.js';
import {
  claimSlackEvent,
  extractSlackEventId,
  markSlackEventVisible,
  releaseSlackEventClaim,
} from '../state/slackEventDedupe.js';
import { maybeHandleSlackIntake } from './slackIntake.js';
import { preflightChecks } from './preflightChecks.js';
import { markThreadParticipation } from './threadParticipationMark.js';
import { routeFollowUp } from './followUpRouter.js';
import { finishRefinementTarget, lookupRefinementTarget, REFINE_LOOKUP_FAILED_TEXT } from './refinePrompt.js';
import { friendlyErrorMessage } from '../errors.js';
import { createTraceId, rootLogger } from '../logging.js';

export function registerMentions(app: App, getConfig: () => AppConfig, getTables: () => TableContext[]) {
  app.event('app_mention', async ({ event, body, client }) => {
    const eventId = extractSlackEventId(body);
    let visibleResponse = false;
    const ownerToken = randomUUID();
    let lockHeld = false;
    const shouldProcess = await claimSlackEvent(eventId);
    if (!shouldProcess) return;

    const config = getConfig();
    const threadTs = event.thread_ts || event.ts;
    const question = event.text.replace(/<@[A-Z0-9]+>/g, '').trim();

    try {
      // Rate limit check
      const rateCheck = await checkRateLimit(event.user || 'unknown', config.limits.rateLimitPerHour);
      if (!rateCheck.allowed) {
        await client.chat.postMessage({
          channel: event.channel,
          thread_ts: threadTs,
          text: `You've hit the query limit (${config.limits.rateLimitPerHour}/hour). Resets in ${rateCheck.retryAfterMinutes} minutes.`,
        });
        visibleResponse = true;
        await markSlackEventVisible(eventId).catch(() => {});
        return;
      }

      // Preflight: lock + clarification + escalation guards
      const passed = await preflightChecks(event.channel, threadTs, client, ownerToken);
      if (!passed) return;
      lockHeld = true;

      // A mentioned reply to a refine prompt is still that user's correction to
      // the answer they picked (#51) — same lookup as unmentioned replies.
      const replyUser = event.thread_ts ? event.user : undefined;
      const refinementLookup = replyUser
        ? await lookupRefinementTarget(event.channel, threadTs, replyUser)
        : { status: 'none' as const };
      if (refinementLookup.status === 'failed') {
        await client.chat.postMessage({ channel: event.channel, thread_ts: threadTs, text: REFINE_LOOKUP_FAILED_TEXT });
        visibleResponse = true;
        await markSlackEventVisible(eventId).catch(() => {});
        await releaseThreadLock(event.channel, threadTs, ownerToken).catch(() => {});
        lockHeld = false;
        return;
      }
      if (refinementLookup.status === 'found' && replyUser) {
        const refineStatus = await client.chat.postMessage({
          channel: event.channel,
          thread_ts: threadTs,
          text: 'Got it. Let me get things ready...',
        });
        visibleResponse = true;
        await markSlackEventVisible(eventId).catch(() => {});
        await finishRefinementTarget(event.channel, threadTs, replyUser, refinementLookup.key);
        try {
          await routeFollowUp(
            'refinement', question, threadTs, event.channel, refineStatus.ts!,
            client, toPipelineConfig(config), getTables(),
            { refinementTargetKey: refinementLookup.key },
          );
        } catch (error) {
          const traceId = createTraceId();
          rootLogger.warn({ traceId, intent: 'refinement', err: (error as Error).message }, 'followup.route_failed');
          await client.chat.update({
            channel: event.channel,
            ts: refineStatus.ts!,
            text: friendlyErrorMessage(error as Error, traceId),
          }).catch(() => {});
        }
        await releaseThreadLock(event.channel, threadTs, ownerToken).catch(() => {});
        lockHeld = false;
        return;
      }

      const handledByIntake = await maybeHandleSlackIntake({
        text: question,
        channel: event.channel,
        threadTs,
        apiKey: config.gemini.apiKey,
        client,
        markVisible: () => markSlackEventVisible(eventId),
        releaseLock: () => releaseThreadLock(event.channel, threadTs, ownerToken),
      });
      if (handledByIntake) {
        // Intake marked the thread itself when it posted (#53).
        visibleResponse = true;
        lockHeld = false;
        return;
      }

      const statusMsg = await client.chat.postMessage({
        channel: event.channel,
        thread_ts: threadTs,
        text: 'Got it. Let me get things ready...',
      });
      const statusMsgTs = statusMsg.ts!;
      visibleResponse = true;
      await Promise.all([
        markThreadParticipation(event.channel, threadTs),
        markSlackEventVisible(eventId).catch(() => {}),
      ]);
      lockHeld = false;

      await runPipeline({
        ownerToken,
        question,
        channel: event.channel,
        threadTs,
        statusMsgTs,
        client,
        tables: getTables(),
        config: toPipelineConfig(config),
      });
    } catch (error) {
      // runPipeline has its own error handling; this catches pre-pipeline failures
      if (!visibleResponse) await releaseSlackEventClaim(eventId).catch(() => {});
      if (lockHeld) await releaseThreadLock(event.channel, threadTs, ownerToken).catch(() => {});
      throw error;
    }
  });
}
