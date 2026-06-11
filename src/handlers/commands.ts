import type { App } from '@slack/bolt';
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

// chat.postMessage into a conversation the bot is not a member of fails with one
// of these platform errors. respond() (the command's response_url) still works
// there, so the question path falls back to it instead of failing silently.
function isChannelAccessError(error: unknown): boolean {
  const code = (error as { data?: { error?: string } })?.data?.error;
  return code === 'channel_not_found' || code === 'not_in_channel';
}

const NOT_IN_CHANNEL_TEXT =
  "I can't answer here yet because I'm not a member of this channel. Invite me with `/invite @Anna Lytics`, then ask again.";

export function registerCommands(app: App, getConfig: () => AppConfig, getTables: () => TableContext[]) {
  app.command('/anna', async ({ command, ack, respond, client }) => {
    await ack();

    const trimmed = command.text.trim().toLowerCase();
    if (!trimmed || trimmed === 'help') {
      // respond() goes through the payload's response_url: ephemeral by default
      // and — unlike chat.postEphemeral — works in conversations the bot is not
      // a member of, which is exactly where a new user will try `/anna help`.
      await respond({
        text: 'How to use Anna Lytics',
        blocks: buildHelpBlocks(),
      });
      return;
    }

    const config = getConfig();
    const traceId = createTraceId();
    let statusMsgTs: string | undefined;

    try {
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
      statusMsgTs = statusMsg.ts!;

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
      // The lock is only ever taken after the placeholder exists; its ts is the
      // thread identity.
      if (statusMsgTs) {
        await releaseThreadLock(statusMsgTs).catch(() => {});
      }

      if (isChannelAccessError(error)) {
        await respond({ text: NOT_IN_CHANNEL_TEXT });
        return;
      }

      if (statusMsgTs) {
        await client.chat.update({
          channel: command.channel_id,
          ts: statusMsgTs,
          text: friendlyErrorMessage(error as Error, traceId),
        });
        return;
      }

      // No placeholder exists yet (the failure happened before it posted), so
      // respond() is the only surface that can still reach the user.
      await respond({ text: friendlyErrorMessage(error as Error, traceId) });
    }
  });
}
