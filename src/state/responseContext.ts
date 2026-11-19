import { parseResponseContextRetentionDays } from './retentionSettings.js';
import { getDb } from './firestore.js';
import type { ResponseContext } from '../types.js';
import { conversationThreadKey, findOwnedDoc } from './threadScope.js';
import { hasThreadParticipation } from './threadParticipation.js';

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

/**
 * Logical expiry shared by every request-time reader (#69): an answer stops
 * being usable at `expiresAt`, even though Firestore's TTL may delete it later.
 * Records saved before `expiresAt` existed expire `RETENTION_DAYS` after
 * `createdAt`; a record with neither readable timestamp stays usable.
 */
function isExpiredResponseContext(data: { expiresAt?: unknown; createdAt?: unknown }): boolean {
  let expiresAt: Date | null;
  if (data.expiresAt !== undefined) {
    expiresAt = toDate(data.expiresAt);
  } else {
    const createdAt = toDate(data.createdAt);
    expiresAt = createdAt && new Date(createdAt.getTime() + RETENTION_DAYS * 86_400_000);
  }
  return expiresAt !== null && expiresAt.getTime() <= Date.now();
}

const isLiveResponseContext = (data: { expiresAt?: unknown; createdAt?: unknown }): boolean =>
  !isExpiredResponseContext(data);

export async function saveResponseContext(ctx: ResponseContext): Promise<void> {
  // An unowned Slack record would land at the shared legacy key (#30).
  if (ctx.surface !== 'whatsapp' && !ctx.channel) {
    throw new Error('Slack response context must record its channel');
  }
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
  // Cheap single-doc check first: covers replies that saved no answer (#53).
  if (await hasThreadParticipation(channel, threadTs)) return true;
  const doc = await findOwnedDoc(
    getDb()
      .collection('response_context')
      .where('threadTs', '==', threadTs)
      .select('channel', 'expiresAt', 'createdAt'), // ownership + expiry check only
    'channel',
    channel,
    isLiveResponseContext,
  );
  return doc !== null;
}

/**
 * The stored Slack answer for a button click: `compoundKey` is the button's
 * `${threadTs}_${statusMsgTs}` value and `channel` the channel it was clicked in.
 * Answers saved before conversation scoping live at the bare compound key and
 * carry no owner; they stay reachable so buttons on older answers keep working.
 */
async function findSlackResponseContextDoc(channel: string, compoundKey: string) {
  const collection = getDb().collection('response_context');
  const scoped = await collection.doc(conversationThreadKey(channel, compoundKey)).get();
  if (scoped.exists) return scoped;
  const legacy = await collection.doc(compoundKey).get();
  return legacy.exists && legacy.data()?.channel === undefined ? legacy : null;
}

export async function recordFeedback(
  channel: string,
  threadTs: string,
  messageTs: string,
  feedbackType: 'positive' | 'negative',
): Promise<void> {
  const compoundKey = `${threadTs}_${messageTs}`;
  try {
    const doc = await findSlackResponseContextDoc(channel, compoundKey);
    if (!doc) {
      console.warn(`No response context to record feedback for ${compoundKey}`);
      return;
    }
    await doc.ref.update({
      negativeFeedback: feedbackType === 'negative',
    });
  } catch {
    // Doc may not exist if feedback is on an old/unknown message — log and skip
    console.warn(`Failed to record feedback for ${compoundKey}`);
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

/**
 * WhatsApp ids are already conversation-unique (threadTs is the conversation
 * id). Slack ids are prefixed with the channel: two channels can share both the
 * thread and the answer timestamp.
 */
export function responseContextDocumentId(ctx: ResponseContext): string {
  if (ctx.surface === 'whatsapp') {
    return `${ctx.threadTs}_${encodeURIComponent(ctx.statusMsgTs)}`;
  }
  const compoundKey = `${ctx.threadTs}_${ctx.statusMsgTs}`;
  return ctx.channel ? conversationThreadKey(ctx.channel, compoundKey) : compoundKey;
}

function liveResponseContext(data: unknown): ResponseContext | null {
  const ctx = data as (ResponseContext & { expiresAt?: unknown }) | undefined;
  if (!ctx || isExpiredResponseContext(ctx)) return null;
  return ctx;
}

/** WhatsApp answer context by its stored document id. */
export async function getResponseContext(
  documentId: string,
): Promise<ResponseContext | null> {
  const doc = await getDb()
    .collection('response_context')
    .doc(documentId)
    .get();

  if (!doc.exists) return null;
  return liveResponseContext(doc.data());
}

/** Slack answer context for a button clicked in `channel` (see {@link findSlackResponseContextDoc}). */
export async function getSlackResponseContext(
  channel: string,
  compoundKey: string,
): Promise<ResponseContext | null> {
  const doc = await findSlackResponseContextDoc(channel, compoundKey);
  return doc ? liveResponseContext(doc.data()) : null;
}

export async function getLatestResponseContext(
  channel: string,
  threadTs: string,
): Promise<ResponseContext | null> {
  const doc = await findOwnedDoc(
    getDb()
      .collection('response_context')
      .where('threadTs', '==', threadTs)
      .orderBy('createdAt', 'desc'),
    'channel',
    channel,
    isLiveResponseContext,
  );
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
  const doc = await findOwnedDoc(
    getDb().collection('response_context')
      .where('threadTs', '==', threadTs)
      .where('negativeFeedback', '==', true)
      .orderBy('createdAt', 'desc'),
    'channel',
    channel,
    isLiveResponseContext,
  );
  if (!doc) return null;

  const data = doc.data();
  return {
    sql: data.generatedSql,
    explanation: data.explanation || data.reasoningChain || '',
    tablesUsed: data.tablesUsed || [],
  };
}
