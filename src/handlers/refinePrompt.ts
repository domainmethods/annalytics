import type { WebClient } from '@slack/web-api';
import { consumeRefinementTarget, getRefinementTarget, saveRefinementTarget } from '../state/refinementTarget.js';
import { rootLogger } from '../logging.js';

export const REFINE_PROMPT_TEXT =
  "What should I change about my assumptions? Reply with your corrections and I'll re-run the query.";

/** Shown instead of the prompt when the picked answer can't be remembered. */
export const REFINE_SAVE_FAILED_TEXT =
  "Sorry — I couldn't set up that correction. Click the button again to retry.";

/** Shown when a reply might answer a refine prompt but the target can't be read. */
export const REFINE_LOOKUP_FAILED_TEXT =
  "Sorry — I couldn't load the answer you picked to refine. Please send your correction again.";

/**
 * Ask for a correction to one answer and remember which answer it was (#51),
 * so the user's next reply in the thread refines the answer they clicked, not
 * the newest one. Shared by the "Change assumptions" button and the
 * "Not what I asked" feedback reason.
 *
 * Returns false, without posting the prompt, when the target can't be saved:
 * a prompt with no target would send the reply to the newest answer, which is
 * the bug this exists to fix. The caller tells the user to retry.
 */
export async function promptRefinement(params: {
  channel: string;
  threadTs: string;
  statusMsgTs: string;
  userId: string;
  client: WebClient;
}): Promise<boolean> {
  const { channel, threadTs, statusMsgTs, userId, client } = params;
  try {
    await saveRefinementTarget({ channel, threadTs, userId, responseKey: `${threadTs}_${statusMsgTs}` });
  } catch (err) {
    rootLogger.warn({ err: (err as Error).message }, 'refine.target_save_failed');
    return false;
  }
  await client.chat.postMessage({ channel, thread_ts: threadTs, text: REFINE_PROMPT_TEXT });
  return true;
}

export type RefinementLookup =
  | { status: 'none' }
  | { status: 'found'; key: string }
  | { status: 'failed' };

/**
 * Look up this user's pending refine target for a thread reply (#51). A read
 * failure is reported as `failed`, not `none`: falling back to normal routing
 * would refine the newest answer instead of the one the user picked. The
 * lookup doesn't consume the target — call `finishRefinementTarget` once the
 * reply's status message has posted, so any earlier failure leaves it for
 * the retry.
 */
export async function lookupRefinementTarget(
  channel: string,
  threadTs: string,
  userId: string,
): Promise<RefinementLookup> {
  try {
    const key = await getRefinementTarget(channel, threadTs, userId);
    return key ? { status: 'found', key } : { status: 'none' };
  } catch (err) {
    rootLogger.warn({ err: (err as Error).message }, 'refine.target_lookup_failed');
    return { status: 'failed' };
  }
}

/**
 * Consume the target once the refinement is underway. Best-effort: if the
 * delete fails the target stays until its 30-minute TTL, so at worst a later
 * reply refines the same picked answer again — never a different one.
 */
export async function finishRefinementTarget(
  channel: string,
  threadTs: string,
  userId: string,
  responseKey: string,
): Promise<void> {
  try {
    await consumeRefinementTarget(channel, threadTs, userId, responseKey);
  } catch (err) {
    rootLogger.warn({ err: (err as Error).message }, 'refine.target_consume_failed');
  }
}
