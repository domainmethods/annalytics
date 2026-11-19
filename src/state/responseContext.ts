import { parseResponseContextRetentionDays } from './retentionSettings.js';
import { getDb } from './firestore.js';
import type { ResponseContext } from '../types.js';
import { ownedByConversation, THREAD_SCOPE_SCAN_LIMIT } from './threadScope.js';

type FirestoreTimestamp = { toDate: () => Date };

const RETENTION_DAYS = parseResponseContextRetentionDays();
/** Serialized byte budget for the whole persisted response context; well under Firestore's 1 MiB document limit. */
export const RESPONSE_CONTEXT_BYTE_BUDGET = 512 * 1024;

function toDate(value: unknown): Date | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (
    typeof value === 'object'
    && value !== null
    && 'toDate' in value
    && typeof (value as { toDate?: unknown }).toDate === 'function'
  ) {
    try {
      const candidate = (value as FirestoreTimestamp).toDate();
      return candidate instanceof Date && Number.isFinite(candidate.getTime()) ? candidate : null;
    } catch {
      return null;
    }
  }
  return null;
}

function isExpiredResponseContext(data: { expiresAt?: unknown }): boolean {
  if (data.expiresAt === undefined) return false;
  const expiresAt = toDate(data.expiresAt);
  return expiresAt !== null && expiresAt.getTime() <= Date.now();
}

export async function saveResponseContext(ctx: ResponseContext): Promise<void> {
  const now = new Date();
  // Leave ample headroom for Firestore field/document overhead beyond JSON bytes.
  const budget = RESPONSE_CONTEXT_BYTE_BUDGET;
  let saved = { ...ctx };
  if (Buffer.byteLength(JSON.stringify(saved), 'utf8') > budget && ctx.retrievedSchema) {
    saved = { ...ctx, schemaDetailsTrimmed: true,
      retrievedSchema: ctx.retrievedSchema.map(t => ({ name: t.name, description: '', columns: [] })),
    };
    let bytes = Buffer.byteLength(JSON.stringify(saved), 'utf8');
    for (let i = 0; i < ctx.retrievedSchema.length; i++) {
      const source = ctx.retrievedSchema[i];
      const target = saved.retrievedSchema![i];
      for (const column of source.columns) {
        const added = Buffer.byteLength(JSON.stringify(column), 'utf8') + 1;
        if (bytes + added > budget) break;
        target.columns.push(column);
        bytes += added;
      }
    }
  }
  if (Buffer.byteLength(JSON.stringify(saved), 'utf8') > budget) {
    throw new Error('Response context exceeds persistence byte budget');
  }
  await getDb()
    .collection('response_context')
    .doc(responseContextDocumentId(ctx))
    .set({
      ...saved,
      createdAt: now,
      expiresAt: new Date(now.getTime() + RETENTION_DAYS * 86_400_000),
    });
}

export async function botHasRepliedInThread(channel: string, threadTs: string): Promise<boolean> {
  const snapshot = await getDb()
    .collection('response_context')
    .where('threadTs', '==', threadTs)
    .limit(THREAD_SCOPE_SCAN_LIMIT)
    .select('channel') // ownership check only
    .get();
  return snapshot.docs.some(d => ownedByConversation(d.data().channel, channel));
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

export async function recordFeedbackByResponseContextKey(
  responseContextKey: string,
  feedbackType: 'positive' | 'negative',
): Promise<void> {
  await getDb()
    .collection('response_context')
    .doc(responseContextKey)
    .update({
      negativeFeedback: feedbackType === 'negative',
    });
}

export function responseContextDocumentId(ctx: ResponseContext): string {
  if (ctx.surface === 'whatsapp') {
    return `${ctx.threadTs}_${encodeURIComponent(ctx.statusMsgTs)}`;
  }
  return `${ctx.threadTs}_${ctx.statusMsgTs}`;
}

export async function getResponseContext(
  compoundKey: string,
): Promise<ResponseContext | null> {
  const doc = await getDb()
    .collection('response_context')
    .doc(compoundKey)
    .get();

  if (!doc.exists) return null;
  const data = doc.data() as (ResponseContext & { expiresAt?: unknown }) | undefined;
  if (!data || isExpiredResponseContext(data)) return null;
  return data;
}

export async function getLatestResponseContext(
  channel: string,
  threadTs: string,
): Promise<ResponseContext | null> {
  const snapshot = await getDb()
    .collection('response_context')
    .where('threadTs', '==', threadTs)
    .orderBy('createdAt', 'desc')
    .limit(THREAD_SCOPE_SCAN_LIMIT)
    .get();

  const doc = snapshot.docs.find(d => ownedByConversation(d.data().channel, channel));
  return doc ? doc.data() as ResponseContext : null;
}

/** All response contexts created within the trailing window (for the feedback
 *  sensor). Newest-first, bounded by `limit` so truncation drops the oldest
 *  docs — intended for low-frequency CLI/offline use, not a request hot path.
 *  Warns when the limit is hit so consumers can surface the truncation (no
 *  silent caps). */
export async function getResponseContextsSince(
  windowDays: number,
  limit = 5000,
): Promise<ResponseContext[]> {
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
  const snapshot = await getDb()
    .collection('response_context')
    .where('createdAt', '>=', since)
    .orderBy('createdAt', 'desc')
    .limit(limit)
    .get();
  if (snapshot.size === limit) {
    console.warn(`response_context window scan hit limit ${limit}; results truncated`);
  }
  return snapshot.docs.map((d) => d.data() as ResponseContext);
}

export async function getLatestNegativeFeedback(
  channel: string,
  threadTs: string,
): Promise<{ sql: string; explanation: string; tablesUsed: string[] } | null> {
  const db = getDb();
  const snapshot = await db.collection('response_context')
    .where('threadTs', '==', threadTs)
    .where('negativeFeedback', '==', true)
    .orderBy('createdAt', 'desc')
    .limit(THREAD_SCOPE_SCAN_LIMIT)
    .get();

  const doc = snapshot.docs.find(d => ownedByConversation(d.data().channel, channel));
  if (!doc) return null;

  const data = doc.data();
  return {
    sql: data.generatedSql,
    explanation: data.explanation || data.reasoningChain || '',
    tablesUsed: data.tablesUsed || [],
  };
}
