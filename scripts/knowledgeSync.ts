import { join } from 'node:path';
import { getDb, initFirestore } from '../src/state/firestore.js';
import { syncMarkdownDocumentsToFileSearch } from '../src/teachings/fileSearchSync.js';
import { buildSummaries } from '../src/teachings/summaryMap.js';
import type { TeachingSummary } from '../src/teachings/types.js';
import {
  buildKnowledgeDocuments,
  loadReferenceCardsFromDir,
  loadTeachingsFromDir,
  validateKnowledgeForSync,
} from './knowledgeSupport.js';

type Logger = Pick<typeof console, 'log' | 'warn' | 'error'>;

export type SummarySyncStatus =
  | 'skipped_no_teachings'
  | 'skipped_no_project'
  | 'persisted'
  | 'failed_optional';

export interface KnowledgeSyncResult {
  uploaded: number;
  verified: number;
  deleted: number;
  errors: string[];
  summarySync: SummarySyncStatus;
}

export interface RunKnowledgeSyncOptions {
  rootDir?: string;
  env?: NodeJS.ProcessEnv;
  logger?: Logger;
  syncDocuments?: typeof syncMarkdownDocumentsToFileSearch;
  persistTeachingSummaries?: (projectId: string, summaries: TeachingSummary[]) => Promise<void>;
}

export async function persistTeachingSummariesToFirestore(
  projectId: string,
  summaries: TeachingSummary[],
): Promise<void> {
  initFirestore(projectId);
  const db = getDb();
  await db.doc('config/teaching_summaries').set({
    summaries,
    lastUpdatedAt: new Date(),
  });
}

export async function runKnowledgeSync(
  options: RunKnowledgeSyncOptions = {},
): Promise<KnowledgeSyncResult> {
  const rootDir = options.rootDir ?? process.cwd();
  const env = options.env ?? process.env;
  const logger = options.logger ?? console;
  const syncDocuments = options.syncDocuments ?? syncMarkdownDocumentsToFileSearch;
  const persistSummaries = options.persistTeachingSummaries ?? persistTeachingSummariesToFirestore;

  const errors = await validateKnowledgeForSync(rootDir);
  if (errors.length > 0) {
    throw new Error(`Knowledge validation failed:\n${errors.map(error => `- ${error}`).join('\n')}`);
  }

  const teachings = await loadTeachingsFromDir(join(rootDir, 'teachings'));
  const referenceCards = await loadReferenceCardsFromDir(join(rootDir, 'references'));
  const documents = buildKnowledgeDocuments(teachings, referenceCards);
  if (documents.length === 0) {
    logger.log('No knowledge files found');
    return { uploaded: 0, deleted: 0, errors: [], summarySync: 'skipped_no_teachings' };
  }

  const storeId = env.FILE_SEARCH_STORE_ID;
  const apiKey = env.GEMINI_API_KEY;
  if (!storeId || !apiKey) {
    throw new Error('Missing FILE_SEARCH_STORE_ID or GEMINI_API_KEY');
  }

  const result = await syncDocuments(documents, storeId, apiKey);
  logger.log(`Uploaded: ${result.uploaded}, Verified: ${result.verified}, Errors: ${result.errors.length}`);
  if (result.errors.length > 0) {
    throw new Error(`Sync errors:\n${result.errors.map(error => `- ${error}`).join('\n')}`);
  }

  if (teachings.length === 0) {
    logger.log('No teachings found; skipping Firestore teaching summary sync');
    return { ...result, summarySync: 'skipped_no_teachings' };
  }

  const projectId = env.GCP_PROJECT_ID;
  if (!projectId) {
    logger.warn('Skipping Firestore teaching summary sync: GCP_PROJECT_ID is not set');
    return { ...result, summarySync: 'skipped_no_project' };
  }

  const summaries = buildSummaries(teachings);
  try {
    await persistSummaries(projectId, summaries);
    logger.log(`Updated teaching summary map: ${summaries.length} entries`);
    return { ...result, summarySync: 'persisted' };
  } catch (err) {
    logger.warn(`Skipping Firestore teaching summary sync: ${(err as Error).message}`);
    return { ...result, summarySync: 'failed_optional' };
  }
}
