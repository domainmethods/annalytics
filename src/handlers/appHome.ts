import type { App } from '@slack/bolt';
import { buildHelpBlocks } from '../slack/helpBlocks.js';
import { rootLogger } from '../logging.js';

/**
 * App Home tab = the same static help content as `/anna help`, re-published on
 * every open (stateless). The event fires for the Messages tab too — only the
 * Home tab carries a publishable view.
 */
export function registerAppHome(app: App): void {
  app.event('app_home_opened', async ({ event, client }) => {
    if (event.tab !== 'home') return;
    await client.views
      .publish({
        user_id: event.user,
        view: { type: 'home', blocks: buildHelpBlocks() },
      })
      .catch((err) =>
        rootLogger.warn({ error: (err as Error).message }, 'app_home.publish_failed'),
      );
  });
}
