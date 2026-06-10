import { getDb } from './firestore.js';

const COLLECTION = 'pending_notifications';
const RETENTION_DAYS = 30;

export interface PendingNotification {
  /** notif_<candidateId> — idempotent across re-approval of the same candidate. */
  id: string;
  kind: 'teaching_promoted';
  channel: string;
  threadTs: string;
  /** The feedback reporter to @-mention; absent for escalation-originated teachings. */
  userId?: string;
  teachingId: string;
  status: 'pending' | 'delivered';
  createdAt: Date;
  expiresAt: Date;
}

export type NotificationInput = Omit<PendingNotification, 'status' | 'createdAt' | 'expiresAt'>;

export async function enqueueNotification(input: NotificationInput): Promise<void> {
  const now = new Date();
  await getDb().collection(COLLECTION).doc(input.id).set({
    ...input,
    status: 'pending',
    createdAt: now,
    expiresAt: new Date(now.getTime() + RETENTION_DAYS * 86_400_000),
  });
}

type FirestoreTimestamp = { toDate: () => Date };

function toDate(value: Date | FirestoreTimestamp): Date {
  return value instanceof Date ? value : value.toDate();
}

/** Status-only filter — no orderBy, so no composite index (delivery order is irrelevant). */
export async function getPendingNotifications(): Promise<PendingNotification[]> {
  const snapshot = await getDb()
    .collection(COLLECTION)
    .where('status', '==', 'pending')
    .get();

  if (snapshot.empty) return [];

  return snapshot.docs.map((doc) => {
    const data = doc.data() as Record<string, unknown>;
    return {
      ...data,
      createdAt: toDate(data.createdAt as Date | FirestoreTimestamp),
      expiresAt: toDate(data.expiresAt as Date | FirestoreTimestamp),
    } as PendingNotification;
  });
}

export async function markNotificationDelivered(id: string): Promise<void> {
  await getDb().collection(COLLECTION).doc(id).update({ status: 'delivered' });
}
