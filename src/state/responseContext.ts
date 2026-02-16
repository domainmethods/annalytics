import { getDb } from './firestore.js';
import type { ResponseContext } from '../types.js';

export async function saveResponseContext(ctx: ResponseContext): Promise<void> {
  await getDb()
    .collection('response_context')
    .doc(`${ctx.threadTs}_${ctx.statusMsgTs}`)
    .set({ ...ctx, createdAt: new Date() });
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
