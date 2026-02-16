import { getDb } from './firestore.js';

const COLLECTION = 'dbt_run_history';
const TTL_DAYS = 90;

export interface DbtRunHistoryEntry {
  model: string;
  status: 'success' | 'error' | 'skipped';
  executionTime: number;
  runId: string;
  runStartedAt: Date;
  errorMessage?: string;
}

type FirestoreTimestamp = { toDate: () => Date };

function toDate(value: Date | FirestoreTimestamp | undefined): Date | undefined {
  if (value === undefined) return undefined;
  return value instanceof Date ? value : value.toDate();
}

function toEntry(data: Record<string, unknown>): DbtRunHistoryEntry {
  const entry: DbtRunHistoryEntry = {
    model: data.model as string,
    status: data.status as DbtRunHistoryEntry['status'],
    executionTime: data.executionTime as number,
    runId: data.runId as string,
    runStartedAt: toDate(data.runStartedAt as Date | FirestoreTimestamp)!,
  };
  if (data.errorMessage) {
    entry.errorMessage = data.errorMessage as string;
  }
  return entry;
}

export async function saveDbtRunResults(entries: DbtRunHistoryEntry[]): Promise<void> {
  const db = getDb();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + TTL_DAYS * 24 * 60 * 60 * 1000);
  const CHUNK_SIZE = 500;

  for (let i = 0; i < entries.length; i += CHUNK_SIZE) {
    const chunk = entries.slice(i, i + CHUNK_SIZE);
    const batch = db.batch();
    for (const entry of chunk) {
      const docId = `${entry.runId}_${entry.model}`;
      const docRef = db.collection(COLLECTION).doc(docId);
      batch.set(docRef, {
        ...entry,
        expiresAt,
      });
    }
    await batch.commit();
  }
}

export async function getRunHistoryForModel(
  model: string,
  limit = 5,
): Promise<DbtRunHistoryEntry[]> {
  const db = getDb();
  const snapshot = await db.collection(COLLECTION)
    .where('model', '==', model)
    .orderBy('runStartedAt', 'desc')
    .limit(limit)
    .get();

  if (snapshot.empty) return [];

  return snapshot.docs.map(doc => toEntry(doc.data()));
}

export async function getLatestRun(): Promise<DbtRunHistoryEntry[]> {
  const db = getDb();

  // First: find the most recent entry to get its runId
  const latestSnapshot = await db.collection(COLLECTION)
    .orderBy('runStartedAt', 'desc')
    .limit(1)
    .get();

  if (latestSnapshot.empty) return [];

  const latestDoc = latestSnapshot.docs[0];
  const latestRunId = latestDoc.data().runId as string;

  // Second: fetch all entries with that runId
  const runSnapshot = await db.collection(COLLECTION)
    .where('runId', '==', latestRunId)
    .get();

  if (runSnapshot.empty) return [];

  return runSnapshot.docs.map(doc => toEntry(doc.data()));
}

export async function getRecentFailures(days = 7): Promise<DbtRunHistoryEntry[]> {
  const db = getDb();
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const snapshot = await db.collection(COLLECTION)
    .where('status', '==', 'error')
    .where('runStartedAt', '>', cutoff)
    .get();

  if (snapshot.empty) return [];

  return snapshot.docs.map(doc => toEntry(doc.data()));
}
