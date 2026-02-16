import { Firestore, FieldValue } from '@google-cloud/firestore';

let db: Firestore;

export function initFirestore(projectId?: string): void {
  db = new Firestore({ projectId });
}

export function getDb(): Firestore {
  if (!db) throw new Error('Firestore not initialized — call initFirestore() first');
  return db;
}

export { FieldValue };
