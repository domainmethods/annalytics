import type { App } from '@slack/bolt';
import type { TableContext } from '../dbt/types.js';
import type { AppConfig } from '../config.js';
import { runPipeline, toPipelineConfig } from '../pipeline.js';
import { releaseThreadLock } from '../state/threadLock.js';
import { checkRateLimit } from '../state/rateLimiter.js';
import { friendlyErrorMessage } from '../errors.js';
import { createTraceId } from '../logging.js';
import { preflightChecks } from './preflightChecks.js';

export function registerCommands(app: App, getConfig: () => AppConfig, getTables: () => TableContext[]) {
  app.command('/anna', async ({ command, ack, client }) => {
    await ack();

    const config = getConfig();
    const traceId = createTraceId();

    // Rate limit check
    const rateCheck = await checkRateLimit(command.user_id, config.limits.rateLimitPerHour);
    if (!rateCheck.allowed) {
      await client.chat.postMessage({
        channel: command.channel_id,
        text: `You've hit the query limit (${config.limits.rateLimitPerHour}/hour). Resets in ${rateCheck.retryAfterMinutes} minutes.`,
      });
      return;
    }

    const statusMsg = await client.chat.postMessage({
      channel: command.channel_id,
      text: 'Understanding your question...',
    });

    const threadTs = statusMsg.ts!;
    const statusMsgTs = statusMsg.ts!;

    // Preflight: lock + clarification + escalation guards
    const passed = await preflightChecks(command.channel_id, threadTs, client);
    if (!passed) return;

    try {
      await runPipeline({
        question: command.text,
        channel: command.channel_id,
        threadTs,
        statusMsgTs,
        client,
        tables: getTables(),
        config: toPipelineConfig(config),
      });
    } catch (error) {
      await releaseThreadLock(threadTs).catch(() => {});
      await client.chat.update({
        channel: command.channel_id,
        ts: statusMsgTs,
        text: friendlyErrorMessage(error as Error, traceId),
      });
    }
  });
}
