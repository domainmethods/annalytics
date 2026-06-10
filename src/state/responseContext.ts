import { getDb } from './firestore.js';
import type { ResponseContext } from '../types.js';

/** Retention window for response_context docs. The Firestore TTL policy on
 *  `expiresAt` deletes expired docs. Feedback aggregation windows
 *  (getResponseContextsSince) must not exceed this retention. */
const RETENTION_DAYS = (() => {
  const v = Number(process.env.RESPONSE_CONTEXT_RETENTION_DAYS);
  return Number.isFinite(v) && v > 0 ? v : 90;
})();

export async function saveResponseContext(ctx: ResponseContext): Promise<void> {
  const now = new Date();
  await getDb()
    .collection('response_context')
    .doc(`${ctx.threadTs}_${ctx.statusMsgTs}`)
    .set({
      ...ctx,
      createdAt: now,
      expiresAt: new Date(now.getTime() + RETENTION_DAYS * 86_400_000),
    });
}

export async function botHasRepliedInThread(threadTs: string): Promise<boolean> {
  const snapshot = await getDb()
    .collection('response_context')
    .where('threadTs', '==', threadTs)
    .limit(1)
    .select() // existence check only — fetches no fields
    .get();
  return !snapshot.empty;
}

export async function recordFeedback(
  threadTs: string,
  messageTs: string,
  feedbackType: 'positive' | 'negative',
): Promise<void> {
  const db = getDb();
  const docRef = db.collection('response_context').doc(`${threadTs}_${messageTs}`);

  try {
    await docRef.update({
      negativeFeedback: feedbackType === 'negative',
    });
  } catch {
    // Doc may not exist if feedback is on an old/unknown message — log and skip
    console.warn(`Failed to record feedback for ${threadTs}_${messageTs}`);
  }
}

export async function getResponseContext(
  compoundKey: string,
): Promise<ResponseContext | null> {
  const doc = await getDb()
    .collection('response_context')
    .doc(compoundKey)
    .get();

  if (!doc.exists) return null;
  return doc.data() as ResponseContext;
}

export async function getLatestResponseContext(
  threadTs: string,
): Promise<ResponseContext | null> {
  const snapshot = await getDb()
    .collection('response_context')
    .where('threadTs', '==', threadTs)
    .orderBy('createdAt', 'desc')
    .limit(1)
    .get();

  if (snapshot.empty) return null;
  return snapshot.docs[0].data() as ResponseContext;
}

/** All response contexts created within the trailing window (for the feedback
 *  sensor). Unordered, bounded by `limit` — intended for low-frequency
 *  CLI/offline use, not a request hot path. Warns when the limit is hit so
 *  consumers can surface the truncation (no silent caps). */
export async function getResponseContextsSince(
  windowDays: number,
  limit = 5000,
): Promise<ResponseContext[]> {
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
  const snapshot = await getDb()
    .collection('response_context')
    .where('createdAt', '>=', since)
    .limit(limit)
    .get();
  if (snapshot.size === limit) {
    console.warn(`response_context window scan hit limit ${limit}; results truncated`);
  }
  return snapshot.docs.map((d) => d.data() as ResponseContext);
}

export async function getLatestNegativeFeedback(
  threadTs: string,
): Promise<{ sql: string; explanation: string; tablesUsed: string[] } | null> {
  const db = getDb();
  const snapshot = await db.collection('response_context')
    .where('threadTs', '==', threadTs)
    .where('negativeFeedback', '==', true)
    .orderBy('createdAt', 'desc')
    .limit(1)
    .get();

  if (snapshot.empty) return null;

  const data = snapshot.docs[0].data();
  return {
    sql: data.generatedSql,
    explanation: data.explanation || data.reasoningChain || '',
    tablesUsed: data.tablesUsed || [],
  };
}
