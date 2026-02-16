import type { App } from '@slack/bolt';
import type { TableContext } from '../dbt/types.js';
import type { AppConfig } from '../config.js';
import { runPipeline, toPipelineConfig } from '../pipeline.js';
import { releaseThreadLock } from '../state/threadLock.js';
import { checkRateLimit } from '../state/rateLimiter.js';
import { preflightChecks } from './preflightChecks.js';

export function registerMentions(app: App, getConfig: () => AppConfig, getTables: () => TableContext[]) {
  app.event('app_mention', async ({ event, client }) => {
    const config = getConfig();
    const threadTs = event.thread_ts || event.ts;

    // Rate limit check
    const rateCheck = await checkRateLimit(event.user || 'unknown', config.limits.rateLimitPerHour);
    if (!rateCheck.allowed) {
      await client.chat.postMessage({
        channel: event.channel,
        thread_ts: threadTs,
        text: `You've hit the query limit (${config.limits.rateLimitPerHour}/hour). Resets in ${rateCheck.retryAfterMinutes} minutes.`,
      });
      return;
    }

    // Preflight: lock + clarification + escalation guards
    const passed = await preflightChecks(event.channel, threadTs, client);
    if (!passed) return;

    let statusMsgTs: string | undefined;
    try {
      const statusMsg = await client.chat.postMessage({
        channel: event.channel,
        thread_ts: threadTs,
        text: 'Understanding your question...',
      });
      statusMsgTs = statusMsg.ts!;

      await runPipeline({
        question: event.text.replace(/<@[A-Z0-9]+>/g, '').trim(), // strip @mention
        channel: event.channel,
        threadTs,
        statusMsgTs,
        client,
        tables: getTables(),
        config: toPipelineConfig(config),
      });
    } catch {
      // runPipeline has its own error handling; this catches pre-pipeline failures
      await releaseThreadLock(threadTs).catch(() => {});
    }
  });
}
