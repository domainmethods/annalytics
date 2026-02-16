import type { App } from '@slack/bolt';
import type { TableContext } from '../dbt/types.js';
import type { AppConfig } from '../config.js';
import { runPipeline } from '../pipeline.js';
import { acquireThreadLock, releaseThreadLock } from '../state/threadLock.js';
import { checkRateLimit } from '../state/rateLimiter.js';

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

    // Preflight: acquire thread lock
    const locked = await acquireThreadLock(threadTs);
    if (!locked) {
      await client.chat.postMessage({
        channel: event.channel,
        thread_ts: threadTs,
        text: "I'm still working on your previous question...",
      });
      return;
    }

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
        config: {
          geminiApiKey: config.gemini.apiKey,
          geminiModel: config.gemini.model,
          fileSearchStoreId: config.gemini.fileSearchStoreId,
          maxBytesProcessed: config.limits.costGateMaxBytes,
          queryTimeoutMs: config.limits.queryTimeoutMs,
          maxResultRows: config.limits.maxResultRows,
        },
      });
    } catch {
      // runPipeline has its own error handling; this catches pre-pipeline failures
      await releaseThreadLock(threadTs).catch(() => {});
    }
  });
}
