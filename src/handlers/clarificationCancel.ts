import type { WebClient } from '@slack/web-api';
import type { KnownBlock } from '@slack/types';
import { deleteClarificationState } from '../state/clarificationState.js';
import {
  buildCancelFailedBlocks,
  CANCEL_FAILED_TEXT,
} from '../slack/clarificationBlocks.js';
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
  let blocks: Record<string, unknown>[] = [];
  try {
    await deleteClarificationState(clarificationId);
  } catch (err) {
    rootLogger.error(
      { error: (err as Error).message, clarificationId },
      'clarification.cancel.delete_failed',
    );
    // Keep a retry affordance: stripping all blocks here would tell the user
    // to "try again" while removing the only button that can.
    text = CANCEL_FAILED_TEXT;
    blocks = buildCancelFailedBlocks(clarificationId);
  }

  await client.chat
    .update({ channel, ts: messageTs, text, blocks: blocks as unknown as KnownBlock[] })
    .catch((err) =>
      rootLogger.warn(
        { error: (err as Error).message, clarificationId },
        'clarification.cancel.update_failed',
      ),
    );
}
