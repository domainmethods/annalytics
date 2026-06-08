import { getDb } from './firestore.js';

const COLLECTION = 'feedback_notes';

export type FeedbackNoteStatus = 'pending' | 'reviewed';

export interface FeedbackNote {
  note: string;
  userId: string;
  threadTs: string;
  channel: string;
  clarifiedQuestion?: string;
  traceId?: string;
}

/**
 * A feedback note as read back from Firestore: the persisted {@link FeedbackNote}
 * plus the storage-layer fields (doc `id`, review `status`, `createdAt`) that the
 * admin review surface needs to display and drain the queue.
 */
export interface StoredFeedbackNote extends FeedbackNote {
  id: string;
  status: FeedbackNoteStatus;
  createdAt: Date;
}

type FirestoreTimestamp = { toDate: () => Date };

function toDate(value: Date | FirestoreTimestamp | undefined): Date | undefined {
  if (value === undefined) return undefined;
  return value instanceof Date ? value : value.toDate();
}

function toStoredFeedbackNote(id: string, data: Record<string, unknown>): StoredFeedbackNote {
  // Spread keeps only the keys Firestore actually returned — absent optional
  // fields (clarifiedQuestion, traceId) stay absent rather than becoming
  // `undefined`, matching teachingCandidates.ts's read shape.
  return {
    ...data,
    id,
    createdAt: toDate(data.createdAt as Date | FirestoreTimestamp)!,
  } as StoredFeedbackNote;
}

export async function saveFeedbackNote(note: FeedbackNote): Promise<void> {
  // Doc id: traceId when available (stable, joinable to the answer), else the
  // thread+user pair. createdAt stamped client-side as a Date to match
  // responseContext.ts's convention. status seeds the review queue so the note
  // is discoverable by getPendingFeedbackNotes.
  const docId = note.traceId ?? `${note.threadTs}_${note.userId}`;
  await getDb()
    .collection(COLLECTION)
    .doc(docId)
    .set({ ...note, status: 'pending', createdAt: new Date() });
}

/**
 * Unreviewed feedback notes, newest first — the read path that closes the
 * write-only capture bug. Mirrors teachingCandidates.getPendingCandidates: a
 * status filter + recency order. (Notes written before the status field existed
 * lack `status` and are intentionally not surfaced; only the queue going forward
 * is drained.)
 */
export async function getPendingFeedbackNotes(): Promise<StoredFeedbackNote[]> {
  const snapshot = await getDb()
    .collection(COLLECTION)
    .where('status', '==', 'pending')
    .orderBy('createdAt', 'desc')
    .get();

  if (snapshot.empty) return [];

  return snapshot.docs.map((doc) => toStoredFeedbackNote(doc.id, doc.data()));
}

export async function markFeedbackNoteReviewed(id: string): Promise<void> {
  await getDb().collection(COLLECTION).doc(id).update({ status: 'reviewed' });
}
