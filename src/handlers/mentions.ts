import type { App } from '@slack/bolt';
import type { TableContext } from '../dbt/types.js';
import type { AppConfig } from '../config.js';
import { handleSlackRequest } from './messageHandler.js';

/**
 * Wire the `app_mention` event to the flow the `message` event uses. A mention
 * is answered wherever it is, and the question is the text without the mention.
 *
 * A reply that @mentions the bot in a channel thread also arrives as a `message`
 * event. This listener owns it; the `message` listener leaves it alone.
 */
export function registerMentions(app: App, getConfig: () => AppConfig, getTables: () => TableContext[]) {
  app.event('app_mention', async ({ event, body, client }) => {
    await handleSlackRequest({
      request: {
        channel: event.channel,
        user: event.user || 'unknown',
        text: event.text.replace(/<@[A-Z0-9]+>/g, '').trim(),
        ts: event.ts,
        thread_ts: event.thread_ts,
      },
      mentioned: true,
      body,
      client,
      config: getConfig(),
      getTables,
    });
  });
}
