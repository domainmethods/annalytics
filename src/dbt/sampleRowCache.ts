import { getDb } from '../state/firestore.js';
import type { SampleRowResult } from './sampleRows.js';

const STALENESS_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const COLLECTION = 'sample_rows';

export async function saveSampleRows(result: SampleRowResult): Promise<void> {
  const db = getDb();
  await db.collection(COLLECTION).doc(result.tableName).set({
    rows: result.rows,
    fetchedAt: new Date(),
  });
}

export async function getSampleRows(
  tableName: string,
): Promise<{ rows: Record<string, unknown>[]; stale: boolean } | null> {
  const db = getDb();
  const doc = await db.collection(COLLECTION).doc(tableName).get();
  if (!doc.exists) return null;

  const data = doc.data()!;
  const fetchedAt: Date = data.fetchedAt?.toDate?.() ?? new Date(0);
  const stale = Date.now() - fetchedAt.getTime() > STALENESS_THRESHOLD_MS;

  return { rows: data.rows as Record<string, unknown>[], stale };
}

export function formatSampleRowsForPrompt(
  tableName: string,
  rows: Record<string, unknown>[],
  stale: boolean,
): string {
  if (rows.length === 0) return '';

  const columns = Object.keys(rows[0]);
  const header = columns.join(' | ');
  const separator = columns.map(() => '---').join(' | ');
  const dataRows = rows.map(
    row => columns.map(col => String(row[col] ?? 'NULL')).join(' | '),
  );

  const staleWarning = stale
    ? '\n(Sample data may be outdated — last refreshed >7 days ago)'
    : '';

  return [
    `SAMPLE DATA for ${tableName}:${staleWarning}`,
    header,
    separator,
    ...dataRows,
  ].join('\n');
}
