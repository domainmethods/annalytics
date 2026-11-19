import type { WebClient } from '@slack/web-api';
import { classifySlackIntake } from '../agents/slackIntakeAgent.js';
import { markThreadParticipation } from './threadParticipationMark.js';

interface MaybeHandleSlackIntakeOptions {
  text: string;
  channel: string;
  threadTs?: string;
  apiKey: string;
  client: WebClient;
  markVisible?: () => Promise<void>;
  releaseLock?: () => Promise<void>;
}

export async function maybeHandleSlackIntake(options: MaybeHandleSlackIntakeOptions): Promise<boolean> {
  const result = await classifySlackIntake(options.text, options.apiKey, {
    channel: options.channel,
    threadTs: options.threadTs,
  });
  if (result.route !== 'immediate_response' || !result.responseText) return false;

  const posted = await options.client.chat.postMessage({
    channel: options.channel,
    ...(options.threadTs ? { thread_ts: options.threadTs } : {}),
    text: result.responseText,
  });

  // The reply is the bot's post in this thread — or, for a top-level reply
  // (`/anna hi`), the root of a new one — so an unmentioned follow-up there
  // must still reach the bot (#53). Best-effort; never throws.
  const participatedTs = options.threadTs ?? posted.ts;
  if (participatedTs) await markThreadParticipation(options.channel, participatedTs);

  // markVisible/releaseLock are best-effort: the reply already posted, so a
  // failed cleanup must not reject and undo the handled=true contract callers
  // rely on (matches the .catch(() => {}) convention in app.ts).
  await options.markVisible?.().catch(() => {});
  await options.releaseLock?.().catch(() => {});
  return true;
}
