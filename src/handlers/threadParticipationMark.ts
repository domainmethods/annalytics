import { recordThreadParticipation } from '../state/threadParticipation.js';
import { rootLogger } from '../logging.js';

/**
 * Best-effort: a bot reply in a channel thread means later unmentioned replies
 * there are for the bot (#53). A failed write only costs that convenience.
 */
export function markThreadParticipation(channel: string, threadTs: string): Promise<void> {
  return recordThreadParticipation(channel, threadTs).catch((err: Error) => {
    rootLogger.warn({ err: err.message }, 'thread_participation.record_failed');
  });
}
