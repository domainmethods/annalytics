import { getDb } from './firestore.js';

export interface FeedbackNote {
  note: string;
  userId: string;
  threadTs: string;
  channel: string;
  clarifiedQuestion?: string;
  traceId?: string;
}

export async function saveFeedbackNote(note: FeedbackNote): Promise<void> {
  // Doc id: traceId when available (stable, joinable to the answer), else the
  // thread+user pair. createdAt stamped client-side as a Date to match
  // responseContext.ts's convention.
  const docId = note.traceId ?? `${note.threadTs}_${note.userId}`;
  await getDb()
    .collection('feedback_notes')
    .doc(docId)
    .set({ ...note, createdAt: new Date() });
}
