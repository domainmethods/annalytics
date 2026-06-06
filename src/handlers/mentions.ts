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
import { getImmediateHelpResponse } from './messages.js';
import { preflightChecks } from './preflightChecks.js';

export function registerMentions(app: App, getConfig: () => AppConfig, getTables: () => TableContext[]) {
  app.event('app_mention', async ({ event, body, client }) => {
    const eventId = extractSlackEventId(body);
    let visibleResponse = false;
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
      const passed = await preflightChecks(event.channel, threadTs, client);
      if (!passed) return;
      lockHeld = true;

      const immediateHelp = getImmediateHelpResponse(question);
      if (immediateHelp) {
        await client.chat.postMessage({
          channel: event.channel,
          thread_ts: threadTs,
          text: immediateHelp,
        });
        visibleResponse = true;
        await markSlackEventVisible(eventId).catch(() => {});
        await releaseThreadLock(threadTs).catch(() => {});
        lockHeld = false;
        return;
      }

      const statusMsg = await client.chat.postMessage({
        channel: event.channel,
        thread_ts: threadTs,
        text: 'Understanding your question...',
      });
      const statusMsgTs = statusMsg.ts!;
      visibleResponse = true;
      await markSlackEventVisible(eventId).catch(() => {});
      lockHeld = false;

      await runPipeline({
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
      if (lockHeld) await releaseThreadLock(threadTs).catch(() => {});
      throw error;
    }
  });
}
