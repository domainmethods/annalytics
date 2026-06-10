import { getDb } from './firestore.js';
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

async function queryPendingEscalation(
  field: string,
  value: string,
): Promise<EscalationLookup> {
  const db = getDb();
  const snapshot = await db.collection(COLLECTION)
    .where(field, '==', value)
    .where('pipelineState', '==', 'awaiting_human')
    .limit(1)
    .get();

  if (snapshot.empty) return null;

  const doc = snapshot.docs[0];
  const state = toEscalationState(doc.data());

  if (state.expiresAt < new Date()) {
    await doc.ref.update({ pipelineState: 'timed_out' });
    return { status: 'expired_now', state };
  }

  return { status: 'pending', state };
}

export async function getEscalationByThread(
  threadTs: string,
): Promise<EscalationLookup> {
  return queryPendingEscalation('originalThreadTs', threadTs);
}

export async function getEscalationByEscalationThread(
  escalationTs: string,
): Promise<EscalationLookup> {
  return queryPendingEscalation('escalationTs', escalationTs);
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
): Promise<void> {
  const db = getDb();
  await db.collection(COLLECTION).doc(escalationId).update({
    pipelineState: 'timed_out',
  });
}

export async function hasPendingEscalation(
  threadTs: string,
): Promise<boolean> {
  const lookup = await getEscalationByThread(threadTs);
  return lookup?.status === 'pending';
}
