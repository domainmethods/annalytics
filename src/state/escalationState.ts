import { LOCK_TTL_MS } from './threadLock.js';
import { getDb } from './firestore.js';
import { findOwnedDoc } from './threadScope.js';
import type { EscalationState } from '../types.js';

const COLLECTION = 'escalation_state';
const RETAIN_DAYS = 90;

export type EscalationLookup =
  | { status: 'pending'; state: EscalationState }
  | { status: 'expired_now'; state: EscalationState }
  | null;

export async function saveEscalationState(
  state: Omit<EscalationState, 'createdAt' | 'expiresAt' | 'pipelineState' | 'lastReminderAt'>,
  timeoutHours: number,
): Promise<void> {
  const db = getDb();
  const now = new Date();
  await db.collection(COLLECTION).doc(state.escalationId).set({
    ...state,
    pipelineState: 'awaiting_human',
    createdAt: now,
    expiresAt: new Date(now.getTime() + timeoutHours * 60 * 60 * 1000),
    // `expiresAt` here is the escalation timeout, not a retention deadline — the
    // TTL policy (see `infra/firestore.ttls.json`) targets `retainUntil` so
    // resolved/timed-out audit history survives.
    retainUntil: new Date(now.getTime() + RETAIN_DAYS * 86_400_000),
  });
}

type FirestoreTimestamp = { toDate: () => Date };

function toDate(value: Date | FirestoreTimestamp | undefined): Date | undefined {
  if (value === undefined) return undefined;
  return value instanceof Date ? value : value.toDate();
}

function toEscalationState(data: Record<string, unknown>): EscalationState {
  return {
    ...data,
    createdAt: toDate(data.createdAt as Date | FirestoreTimestamp)!,
    expiresAt: toDate(data.expiresAt as Date | FirestoreTimestamp)!,
    lastReminderAt: toDate(data.lastReminderAt as Date | FirestoreTimestamp | undefined),
  } as EscalationState;
}

/**
 * Pending escalation whose `field` equals `value`, scoped to the conversation
 * named by `ownerField` (`originalChannel` for original-thread lookups,
 * `escalationChannel` for escalation-card lookups). Timestamps are unique only
 * within a conversation, and in DM mode escalation cards span many DMs.
 */
async function queryPendingEscalation(
  field: string,
  value: string,
  ownerField: 'originalChannel' | 'escalationChannel',
  channel: string | readonly string[],
): Promise<EscalationLookup> {
  const doc = await findOwnedDoc(
    getDb().collection(COLLECTION)
      .where(field, '==', value)
      .where('pipelineState', '==', 'awaiting_human'),
    ownerField,
    channel,
  );
  if (!doc) return null;

  const state = toEscalationState(doc.data());

  if (state.expiresAt < new Date()) {
    if (!await timeoutEscalation(state.escalationId)) return null;
    return { status: 'expired_now', state };
  }

  return { status: 'pending', state };
}

/**
 * A claimed resolution is re-running the pipeline for this thread. Keep the
 * original thread guarded while it does, but only for the thread-lock TTL so a
 * resolution interrupted mid-delivery does not wedge the thread forever.
 */
export const RESOLVING_GUARD_MS = LOCK_TTL_MS;

export async function getEscalationByThread(
  channel: string,
  threadTs: string,
): Promise<EscalationLookup> {
  const awaiting = await queryPendingEscalation('originalThreadTs', threadTs, 'originalChannel', channel);
  if (awaiting) return awaiting;

  const doc = await findOwnedDoc(
    getDb().collection(COLLECTION)
      .where('originalThreadTs', '==', threadTs)
      .where('pipelineState', '==', 'resolving'),
    'originalChannel',
    channel,
  );
  if (!doc) return null;

  const data = doc.data();
  const claimedAt = toDate(data.claimedAt as Date | FirestoreTimestamp | undefined);
  if (!claimedAt || Date.now() - claimedAt.getTime() > RESOLVING_GUARD_MS) return null;
  return { status: 'pending', state: toEscalationState(data) };
}

/**
 * The conversation an escalation-thread event happened in. The user id is
 * included only for DMs (D… channel ids), where it names the same conversation.
 * Group DMs and channels match on the channel id alone.
 */
export function escalationConversation(
  channel: string,
  user: string | undefined,
): { channel: string; user?: string } {
  return channel.startsWith('D') && user ? { channel, user } : { channel };
}

/**
 * Pending escalation whose card is `escalationTs` in the conversation where the
 * event happened. DM-mode cards are posted to the analyst's user id, so that is
 * what `escalationChannel` holds; pass the event's user id alongside its D…
 * channel id (a bot has one DM per user, so either names the conversation).
 */
export async function getEscalationByEscalationThread(
  conversation: { channel: string; user?: string },
  escalationTs: string,
): Promise<EscalationLookup> {
  const owners = conversation.user ? [conversation.channel, conversation.user] : [conversation.channel];
  return queryPendingEscalation('escalationTs', escalationTs, 'escalationChannel', owners);
}

/**
 * Direct lookup by escalationId (the doc key) for provenance chains — e.g.
 * teaching promotion recovering the originating thread. Deliberately ignores
 * pipelineState and expiry: promoted candidates come from RESOLVED escalations.
 */
export async function getEscalationById(
  escalationId: string,
): Promise<EscalationState | null> {
  const doc = await getDb().collection(COLLECTION).doc(escalationId).get();
  if (!doc.exists) return null;
  return toEscalationState(doc.data() as Record<string, unknown>);
}

/**
 * At-most-once delivery: never replay a claim after an interrupted Slack/BQ call.
 * Operators recover by asking a fresh question; replay could duplicate a query.
 */
export async function claimEscalation(escalationId: string): Promise<boolean> {
  const db = getDb();
  const ref = db.collection(COLLECTION).doc(escalationId);
  return db.runTransaction(async transaction => {
    const doc = await transaction.get(ref);
    if (!doc.exists || doc.data()?.pipelineState !== 'awaiting_human') return false;
    transaction.update(ref, { pipelineState: 'resolving', claimedAt: new Date() });
    return true;
  });
}

export async function resolveEscalation(
  escalationId: string,
): Promise<void> {
  const db = getDb();
  await db.collection(COLLECTION).doc(escalationId).update({
    pipelineState: 'resolved',
  });
}

export async function updateReminderTime(
  escalationId: string,
): Promise<void> {
  const db = getDb();
  await db.collection(COLLECTION).doc(escalationId).update({
    lastReminderAt: new Date(),
  });
}

export async function getAllPendingEscalations(): Promise<EscalationState[]> {
  const db = getDb();
  const snapshot = await db.collection(COLLECTION)
    .where('pipelineState', '==', 'awaiting_human')
    .limit(50)
    .get();

  return snapshot.docs.map(doc => toEscalationState(doc.data()));
}

export async function timeoutEscalation(
  escalationId: string,
): Promise<boolean> {
  const db = getDb();
  const ref = db.collection(COLLECTION).doc(escalationId);
  return db.runTransaction(async transaction => {
    const doc = await transaction.get(ref);
    if (!doc.exists || doc.data()?.pipelineState !== 'awaiting_human') return false;
    transaction.update(ref, { pipelineState: 'timed_out' });
    return true;
  });
}

export async function hasPendingEscalation(
  channel: string,
  threadTs: string,
): Promise<boolean> {
  const lookup = await getEscalationByThread(channel, threadTs);
  return lookup?.status === 'pending';
}
