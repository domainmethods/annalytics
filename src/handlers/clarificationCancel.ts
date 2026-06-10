import type { WebClient } from '@slack/web-api';
import { deleteClarificationState } from '../state/clarificationState.js';
import { rootLogger } from '../logging.js';

export interface ClarificationCancelParams {
  clarificationId: string;
  channel: string;
  /** ts of the message whose button was clicked — the one we rewrite. */
  messageTs: string;
  client: WebClient;
}

/**
 * Cancels a pending clarification. Firestore delete is idempotent (deleting a
 * missing doc succeeds), so a double-click, an expiry race, or a click on the
 * other surface's stale button all land on the same cancelled copy.
 */
export async function handleClarificationCancel(
  params: ClarificationCancelParams,
): Promise<void> {
  const { clarificationId, channel, messageTs, client } = params;

  let text = 'No problem — cancelled. Ask me something new whenever.';
  try {
    await deleteClarificationState(clarificationId);
  } catch (err) {
    rootLogger.error(
      { error: (err as Error).message, clarificationId },
      'clarification.cancel.delete_failed',
    );
    text = "Hmm, I couldn't cancel that just now — try again in a moment.";
  }

  await client.chat
    .update({ channel, ts: messageTs, text, blocks: [] })
    .catch((err) =>
      rootLogger.warn(
        { error: (err as Error).message, clarificationId },
        'clarification.cancel.update_failed',
      ),
    );
}
