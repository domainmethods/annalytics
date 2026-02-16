import { getDb } from './firestore.js';
import type { TableContext } from '../dbt/types.js';

const COLLECTION = 'information_schema_cache';

export interface InformationSchemaCacheEntry {
  tableContext: TableContext;
  cachedAt: Date;
  expiresAt: Date;  // cachedAt + 24 hours
}

type FirestoreTimestamp = { toDate: () => Date };

function toDate(value: Date | FirestoreTimestamp): Date {
  return value instanceof Date ? value : value.toDate();
}

export async function getCachedSchema(
  datasetTable: string,
): Promise<TableContext | null> {
  const db = getDb();
  const doc = await db.collection(COLLECTION).doc(datasetTable).get();

  if (!doc.exists) return null;

  const data = doc.data()!;
  const expiresAt = toDate(data.expiresAt as Date | FirestoreTimestamp);

  if (expiresAt < new Date()) return null;

  return data.tableContext as TableContext;
}

export async function cacheSchema(
  datasetTable: string,
  table: TableContext,
): Promise<void> {
  const db = getDb();
  const now = new Date();
  await db.collection(COLLECTION).doc(datasetTable).set({
    tableContext: table,
    cachedAt: now,
    expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
  });
}
