import type { WebClient } from '@slack/web-api';
import { acquireThreadLock, releaseThreadLock } from '../state/threadLock.js';
import { hasPendingClarification } from '../state/clarificationState.js';
import { getEscalationByThread } from '../state/escalationState.js';

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
  const pendingClarification = await hasPendingClarification(threadTs);
  if (pendingClarification) {
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
