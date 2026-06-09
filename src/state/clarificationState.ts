import { getDb } from './firestore.js';

export const CLARIFICATION_TTL_MS = 60 * 60 * 1000; // 1 hour

export interface ClarificationState {
  clarificationId: string;
  threadTs: string;
  channel: string;
  originalQuestion: string;
  ambiguities: string[];
  ambiguityType?: 'user_intent' | 'org_knowledge';
  ambiguityDomain?: string;
  ambiguityQuestion?: string;
  clarifyingMessageTs: string;
  state: 'awaiting_reply';
  createdAt: Date;
  expiresAt: Date;
}

const COLLECTION = 'clarification_state';

export async function saveClarificationState(
  state: Omit<ClarificationState, 'createdAt' | 'expiresAt' | 'state'>,
): Promise<void> {
  const db = getDb();
  const now = new Date();
  await db.collection(COLLECTION).doc(state.clarificationId).set({
    ...state,
    state: 'awaiting_reply',
    createdAt: now,
    expiresAt: new Date(now.getTime() + CLARIFICATION_TTL_MS),
  });
}

export async function getClarificationState(
  threadTs: string,
): Promise<ClarificationState | null> {
  const db = getDb();
  const snapshot = await db.collection(COLLECTION)
    .where('threadTs', '==', threadTs)
    .where('state', '==', 'awaiting_reply')
    .limit(1)
    .get();

  if (snapshot.empty) return null;

  const data = snapshot.docs[0].data() as ClarificationState & {
    expiresAt: Date | { toDate: () => Date };
  };

  const expiresAt = data.expiresAt instanceof Date
    ? data.expiresAt
    : (data.expiresAt as { toDate: () => Date }).toDate();

  if (expiresAt < new Date()) {
    await snapshot.docs[0].ref.delete();
    return null;
  }

  return data as ClarificationState;
}

export async function deleteClarificationState(
  clarificationId: string,
): Promise<void> {
  const db = getDb();
  await db.collection(COLLECTION).doc(clarificationId).delete();
}

export async function hasPendingClarification(
  threadTs: string,
): Promise<boolean> {
  const state = await getClarificationState(threadTs);
  return state !== null;
}
