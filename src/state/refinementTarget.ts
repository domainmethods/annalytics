import { conversationThreadKey } from './threadScope.js';
import { getDb } from './firestore.js';

const COLLECTION = 'refinement_targets';

/** How long a refine prompt waits for the user's correction. */
export const REFINEMENT_TARGET_TTL_MS = 30 * 60_000;

type FirestoreTimestamp = { toDate: () => Date };

/**
 * The answer a user asked to refine (#51). A thread can hold several answers,
 * and the refine buttons name one of them, so the prompt records which answer
 * (its `threadTs_statusMsgTs` response-context key) the user picked. Their
 * next reply in that thread then refines that answer instead of the newest.
 */
export interface RefinementTarget {
  channel: string;
  threadTs: string;
  userId: string;
  responseKey: string;
}

function targetDocId(channel: string, threadTs: string, userId: string): string {
  return `${conversationThreadKey(channel, threadTs)}_${userId}`;
}

/** Record (or replace) the answer this user is about to refine in this thread. */
export async function saveRefinementTarget(target: RefinementTarget): Promise<void> {
  const now = Date.now();
  await getDb()
    .collection(COLLECTION)
    .doc(targetDocId(target.channel, target.threadTs, target.userId))
    .set({
      ...target,
      createdAt: new Date(now),
      expiresAt: new Date(now + REFINEMENT_TARGET_TTL_MS),
    });
}

/**
 * Read this user's pending refine target for the thread, returning the
 * response-context key of the answer they picked, or null when none is
 * pending or it has expired. Reading does not consume it: the handler calls
 * `consumeRefinementTarget` only once its status message has posted, so a
 * failed post leaves the target for the retry (#51).
 */
export async function getRefinementTarget(
  channel: string,
  threadTs: string,
  userId: string,
): Promise<string | null> {
  const doc = await getDb().collection(COLLECTION).doc(targetDocId(channel, threadTs, userId)).get();
  if (!doc.exists) return null;
  const data = doc.data() as { responseKey?: string; expiresAt?: Date | FirestoreTimestamp };
  const expiresAt = data.expiresAt instanceof Date ? data.expiresAt : data.expiresAt?.toDate();
  if (!data.responseKey || !expiresAt || expiresAt.getTime() <= Date.now()) return null;
  return data.responseKey;
}

/**
 * Delete the target once its refinement has started, but only if it still
 * names `responseKey`, so a newer pick of a different answer survives. One
 * prompt drives one refinement.
 */
export async function consumeRefinementTarget(
  channel: string,
  threadTs: string,
  userId: string,
  responseKey: string,
): Promise<void> {
  const db = getDb();
  const ref = db.collection(COLLECTION).doc(targetDocId(channel, threadTs, userId));
  await db.runTransaction(async transaction => {
    const doc = await transaction.get(ref);
    if (!doc.exists) return;
    if ((doc.data() as { responseKey?: string }).responseKey !== responseKey) return;
    transaction.delete(ref);
  });
}
