import { getDb, FieldValue } from './firestore.js';

const LOCK_TTL_MS = 300_000; // 300s — matches Cloud Run timeout

export async function acquireThreadLock(threadTs: string, ownerToken: string): Promise<boolean> {
  const db = getDb();
  const ref = db.collection('processing_threads').doc(threadTs);
  return db.runTransaction(async transaction => {
    const doc = await transaction.get(ref);
    if (doc.exists && doc.data()!.expiresAt.toDate() > new Date()) return false;
    transaction.set(ref, {
      ownerToken,
      startedAt: FieldValue.serverTimestamp(),
      expiresAt: new Date(Date.now() + LOCK_TTL_MS),
    });
    return true;
  });
}

/** Deletes the lease only if `ownerToken` still owns it, so a late release never removes a successor's lock. */
export async function releaseThreadLock(threadTs: string, ownerToken: string): Promise<void> {
  const db = getDb();
  const ref = db.collection('processing_threads').doc(threadTs);
  await db.runTransaction(async transaction => {
    const doc = await transaction.get(ref);
    if (doc.exists && doc.data()!.ownerToken === ownerToken) transaction.delete(ref);
  });
}
