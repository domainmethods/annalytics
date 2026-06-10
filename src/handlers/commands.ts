import type { App } from '@slack/bolt';
import type { KnownBlock } from '@slack/types';
import type { TableContext } from '../dbt/types.js';
import type { AppConfig } from '../config.js';
import { runPipeline, toPipelineConfig } from '../pipeline.js';
import { releaseThreadLock } from '../state/threadLock.js';
import { checkRateLimit } from '../state/rateLimiter.js';
import { friendlyErrorMessage } from '../errors.js';
import { createTraceId } from '../logging.js';
import { buildHelpBlocks } from '../slack/helpBlocks.js';
import { maybeHandleSlackIntake } from './slackIntake.js';
import { preflightChecks } from './preflightChecks.js';

export function registerCommands(app: App, getConfig: () => AppConfig, getTables: () => TableContext[]) {
  app.command('/anna', async ({ command, ack, client }) => {
    await ack();

    const trimmed = command.text.trim().toLowerCase();
    if (!trimmed || trimmed === 'help') {
      await client.chat.postEphemeral({
        channel: command.channel_id,
        user: command.user_id,
        text: 'How to use Anna Lytics',
        blocks: buildHelpBlocks() as unknown as KnownBlock[],
      });
      return;
    }

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

    const handledByIntake = await maybeHandleSlackIntake({
      text: command.text,
      channel: command.channel_id,
      apiKey: config.gemini.apiKey,
      client,
    });
    if (handledByIntake) return;

    const statusMsg = await client.chat.postMessage({
      channel: command.channel_id,
      text: 'Got it. Let me get things ready...',
    });

    const threadTs = statusMsg.ts!;
    const statusMsgTs = statusMsg.ts!;

    try {
      // Preflight: lock + clarification + escalation guards. preflightChecks
      // posts its own threaded note explaining the block; update the placeholder
      // so it isn't left frozen on the placeholder.
      const passed = await preflightChecks(command.channel_id, threadTs, client);
      if (!passed) {
        await client.chat.update({
          channel: command.channel_id,
          ts: statusMsgTs,
          text: "This thread already has a request open, so I can't start a new one yet.",
        });
        return;
      }

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
