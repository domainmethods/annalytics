import { getDb } from './firestore.js';
import { findOwnedDoc } from './threadScope.js';

export const CLARIFICATION_TTL_MS = 60 * 60 * 1000; // 1 hour

export interface ClarificationState {
  clarificationId: string;
  threadTs: string;
  channel: string;
  originalQuestion: string;
  /**
   * The user's own wording when it differs from `originalQuestion` (a refinement
   * or resume rewrote the question), so the clarification reply can hand it back
   * to the supervisor (#44). Absent when the two are the same and on legacy docs.
   */
  supervisorQuestion?: string;
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
  channel: string,
  threadTs: string,
): Promise<ClarificationState | null> {
  const db = getDb();
  const doc = await findOwnedDoc(
    db.collection(COLLECTION)
      .where('threadTs', '==', threadTs)
      .where('state', '==', 'awaiting_reply'),
    'channel',
    channel,
  );
  if (!doc) return null;

  const data = doc.data() as ClarificationState & {
    expiresAt: Date | { toDate: () => Date };
  };

  const expiresAt = data.expiresAt instanceof Date
    ? data.expiresAt
    : (data.expiresAt as { toDate: () => Date }).toDate();

  if (expiresAt < new Date()) {
    await doc.ref.delete();
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

export interface AmbiguityLabel {
  ambiguityType: 'user_intent' | 'org_knowledge';
  ambiguityDomain: string;
  ambiguityQuestion: string;
}

/**
 * Attach the ambiguity label to a clarification after it was posted. The label is
 * computed off the reply path, so the user may already have answered (state gone) or
 * a later clarification may have replaced this one under the same id. Writes only
 * while the doc is still the same pending clarification; returns whether it wrote.
 */
export async function recordAmbiguityLabel(
  clarificationId: string,
  clarifyingMessageTs: string,
  label: AmbiguityLabel,
): Promise<boolean> {
  const db = getDb();
  const ref = db.collection(COLLECTION).doc(clarificationId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const data = snap.exists ? snap.data() as Partial<ClarificationState> : undefined;
    if (data?.state !== 'awaiting_reply' || data.clarifyingMessageTs !== clarifyingMessageTs) return false;
    tx.update(ref, { ...label });
    return true;
  });
}
