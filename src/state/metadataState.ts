import { getDb } from './firestore.js';
import type { MetadataState } from '../dbt/types.js';

export async function saveMetadataState(state: MetadataState): Promise<void> {
  await getDb().doc('config/metadata_state').set(state);
}

export async function getMetadataState(): Promise<MetadataState | null> {
  const doc = await getDb().doc('config/metadata_state').get();
  return doc.exists ? (doc.data() as MetadataState) : null;
}

export function checkMetadataStaleness(state: MetadataState | null): 'fresh' | 'warning' | 'alert' {
  if (!state) return 'alert';
  const hoursOld = (Date.now() - state.lastRefreshAt.getTime()) / (1000 * 60 * 60);
  if (hoursOld < 24) return 'fresh';
  if (hoursOld < 48) return 'warning';
  return 'alert';
}
