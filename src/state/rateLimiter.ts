import { getDb } from './firestore.js';

const WINDOW_MS = 60 * 60 * 1000; // 1 hour

export interface RateLimitResult {
  allowed: boolean;
  retryAfterMinutes?: number;
}

export async function checkRateLimit(
  userId: string,
  maxPerHour: number,
): Promise<RateLimitResult> {
  const db = getDb();
  const ref = db.collection('rate_limits').doc(userId);
  return db.runTransaction(async (transaction) => {
    const doc = await transaction.get(ref);

    if (!doc.exists) {
      transaction.set(ref, { queryCount: 1, windowStart: new Date() });
      return { allowed: true };
    }

    const data = doc.data() as { queryCount: number; windowStart: { toDate: () => Date } };
    const windowStart = data.windowStart.toDate();
    const elapsed = Date.now() - windowStart.getTime();

    // Window expired — reset
    if (elapsed > WINDOW_MS) {
      transaction.set(ref, { queryCount: 1, windowStart: new Date() });
      return { allowed: true };
    }

    // Within window — check count
    if (data.queryCount >= maxPerHour) {
      const remaining = WINDOW_MS - elapsed;
      return { allowed: false, retryAfterMinutes: Math.ceil(remaining / 60_000) };
    }

    // Increment
    transaction.update(ref, { queryCount: data.queryCount + 1 });
    return { allowed: true };
  });
}
