import { getDb, FieldValue } from './firestore.js';

const LOCK_TTL_MS = 300_000; // 300s — matches Cloud Run timeout

export async function acquireThreadLock(threadTs: string): Promise<boolean> {
  const ref = getDb().collection('processing_threads').doc(threadTs);
  try {
    await ref.create({
      startedAt: FieldValue.serverTimestamp(),
      expiresAt: new Date(Date.now() + LOCK_TTL_MS),
    });
    return true;
  } catch (e: any) {
    if (e.code === 6) {
      // ALREADY_EXISTS — check if expired
      const doc = await ref.get();
      if (doc.exists && doc.data()!.expiresAt.toDate() < new Date()) {
        await ref.delete();
        return acquireThreadLock(threadTs); // retry after cleanup
      }
      return false; // lock genuinely held
    }
    throw e;
  }
}

export async function releaseThreadLock(threadTs: string): Promise<void> {
  await getDb().collection('processing_threads').doc(threadTs).delete();
}
