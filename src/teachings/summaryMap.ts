import type { Teaching, TeachingSummary } from './types.js';
import { getDb } from '../state/firestore.js';

export function buildSummaries(teachings: Teaching[]): TeachingSummary[] {
  return teachings.map(t => ({
    term: t.tags[0] || t.id,
    definition: t.reasoning.split('\n')[0].trim(),
    canonical_table: t.models_referenced[0],
  }));
}

let cachedSummaries: TeachingSummary[] = [];
let cachedLastUpdatedAt: Date | null = null;

export async function getTeachingSummaries(): Promise<TeachingSummary[]> {
  const db = getDb();
  const doc = await db.doc('config/teaching_summaries').get();
  if (!doc.exists) return cachedSummaries;

  const data = doc.data()!;
  const remoteUpdatedAt: Date = data.lastUpdatedAt?.toDate?.() ?? new Date(0);

  if (!cachedLastUpdatedAt || remoteUpdatedAt > cachedLastUpdatedAt) {
    cachedSummaries = data.summaries as TeachingSummary[];
    cachedLastUpdatedAt = remoteUpdatedAt;
  }
  return cachedSummaries;
}

export function startSummaryRefresh(intervalMs = 5 * 60 * 1000): NodeJS.Timeout {
  // Eagerly load summaries at startup
  getTeachingSummaries().catch(err => {
    console.warn('Initial teaching summary load failed:', (err as Error).message);
  });

  return setInterval(() => {
    getTeachingSummaries().catch(err => {
      console.warn('Teaching summary refresh failed:', (err as Error).message);
    });
  }, intervalMs);
}

export function _resetCache(): void {
  cachedSummaries = [];
  cachedLastUpdatedAt = null;
}
