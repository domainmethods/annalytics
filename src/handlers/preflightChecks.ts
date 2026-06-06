import type { WebClient } from '@slack/web-api';
import { acquireThreadLock, releaseThreadLock } from '../state/threadLock.js';
import { hasPendingClarification } from '../state/clarificationState.js';
import { getEscalationByThread } from '../state/escalationState.js';
import { rootLogger } from '../logging.js';

/**
 * Shared preflight guard: runs lock + clarification + escalation checks in order.
 * Returns true if the pipeline should proceed, false if blocked.
 * On false, the caller should NOT release the lock (already handled).
 */
export async function preflightChecks(
  channel: string,
  threadTs: string,
  client: WebClient,
): Promise<boolean> {
  // Guard 1: Thread lock
  const locked = await acquireThreadLock(threadTs);
  if (!locked) {
    await client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text: "I'm still working on your previous question...",
    });
    return false;
  }

  // Guard 2: Pending clarification
  //
  // We reach here only when the incoming message was NOT recognized as the
  // clarification reply (checkClarificationReply ran first and returned null) —
  // e.g. a fresh top-level DM that arrives while an earlier clarifying question
  // is still open. Returning false silently here left the user with no feedback
  // at all (indistinguishable from the bot being down). Surface the block the
  // same way Guards 1 and 3 do: a structured log plus a user-visible nudge.
  const pendingClarification = await hasPendingClarification(threadTs);
  if (pendingClarification) {
    rootLogger.warn({ threadTs }, 'preflight.pending_clarification_block');
    await client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text: "I'm still waiting on your answer to my earlier question — reply to that message and I'll pick it up from there.",
    });
    await releaseThreadLock(threadTs);
    return false;
  }

  // Guard 3: Pending escalation
  const pendingEscalation = await getEscalationByThread(threadTs);
  if (pendingEscalation) {
    await client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text: "I'm still waiting for the data team on your previous question.",
    });
    await releaseThreadLock(threadTs);
    return false;
  }

  return true;
}
