import { getDb, FieldValue } from './firestore.js';

const WINDOW_MS = 60 * 60 * 1000; // 1 hour

export interface RateLimitResult {
  allowed: boolean;
  retryAfterMinutes?: number;
}

export async function checkRateLimit(
  userId: string,
  maxPerHour: number,
): Promise<RateLimitResult> {
  const ref = getDb().collection('rate_limits').doc(userId);
  const doc = await ref.get();

  if (!doc.exists) {
    await ref.set({ queryCount: 1, windowStart: new Date() });
    return { allowed: true };
  }

  const data = doc.data() as { queryCount: number; windowStart: { toDate: () => Date } };
  const windowStart = data.windowStart.toDate();
  const elapsed = Date.now() - windowStart.getTime();

  // Window expired — reset
  if (elapsed > WINDOW_MS) {
    await ref.set({ queryCount: 1, windowStart: new Date() });
    return { allowed: true };
  }

  // Within window — check count
  if (data.queryCount >= maxPerHour) {
    const remaining = WINDOW_MS - elapsed;
    return { allowed: false, retryAfterMinutes: Math.ceil(remaining / 60_000) };
  }

  // Increment
  await ref.update({ queryCount: FieldValue.increment(1) });
  return { allowed: true };
}
