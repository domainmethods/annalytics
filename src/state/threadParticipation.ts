import { getDb } from './firestore.js';
import { parseResponseContextRetentionDays } from './retentionSettings.js';
import { conversationThreadKey } from './threadScope.js';

/**
 * Marks a channel thread as one the bot has replied in. Answers already mark
 * participation through `response_context`, but replies that save no answer
 * (an intake greeting or help reply, an error) left the thread unmarked, so a
 * follow-up without an @mention was ignored (#53). Kept as long as answers.
 */
const COLLECTION = 'thread_participation';
const RETENTION_MS = parseResponseContextRetentionDays() * 24 * 60 * 60 * 1000;

export async function recordThreadParticipation(channel: string, threadTs: string): Promise<void> {
  const now = new Date();
  await getDb().collection(COLLECTION).doc(conversationThreadKey(channel, threadTs)).set({
    channel,
    threadTs,
    updatedAt: now,
    expiresAt: new Date(now.getTime() + RETENTION_MS),
  });
}

export async function hasThreadParticipation(channel: string, threadTs: string): Promise<boolean> {
  const doc = await getDb().collection(COLLECTION).doc(conversationThreadKey(channel, threadTs)).get();
  if (!doc.exists) return false;
  const expiresAt = doc.data()?.expiresAt as Date | { toDate: () => Date } | undefined;
  const expiry = expiresAt instanceof Date ? expiresAt : expiresAt?.toDate?.();
  return !expiry || expiry.getTime() > Date.now();
}
