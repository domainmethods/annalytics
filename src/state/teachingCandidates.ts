import { getDb } from './firestore.js';

const COLLECTION = 'teaching_candidates';

export interface TeachingCandidate {
  candidateId: string;
  escalationId: string;
  status: 'pending' | 'approved' | 'rejected';
  questionPatterns: string[];
  reasoning: string;
  sanctionedSql: string | null;
  modelsReferenced: string[];
  tags: string[];
  originalQuestion: string;
  humanResponse: string;
  generatedAt: Date;
}

type FirestoreTimestamp = { toDate: () => Date };

function toDate(value: Date | FirestoreTimestamp | undefined): Date | undefined {
  if (value === undefined) return undefined;
  return value instanceof Date ? value : value.toDate();
}

function toTeachingCandidate(data: Record<string, unknown>): TeachingCandidate {
  return {
    ...data,
    generatedAt: toDate(data.generatedAt as Date | FirestoreTimestamp)!,
  } as TeachingCandidate;
}

export async function saveTeachingCandidate(candidate: TeachingCandidate): Promise<void> {
  const db = getDb();
  await db.collection(COLLECTION).doc(candidate.candidateId).set({
    ...candidate,
  });
}

export async function getPendingCandidates(): Promise<TeachingCandidate[]> {
  const db = getDb();
  const snapshot = await db.collection(COLLECTION)
    .where('status', '==', 'pending')
    .orderBy('generatedAt', 'desc')
    .get();

  if (snapshot.empty) return [];

  return snapshot.docs.map(doc => toTeachingCandidate(doc.data()));
}

export async function updateCandidateStatus(
  candidateId: string,
  status: 'approved' | 'rejected',
): Promise<void> {
  const db = getDb();
  await db.collection(COLLECTION).doc(candidateId).update({ status });
}
