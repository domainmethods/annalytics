import { join } from 'node:path';
import { getDb, initFirestore } from '../src/state/firestore.js';
import { syncMarkdownDocumentsToFileSearch } from '../src/teachings/fileSearchSync.js';
import { buildSummaries } from '../src/teachings/summaryMap.js';
import {
  buildKnowledgeDocuments,
  loadReferenceCardsFromDir,
  loadTeachingsFromDir,
  validateKnowledgeForSync,
} from './knowledgeSupport.js';

async function main() {
  const rootDir = process.cwd();
  const errors = await validateKnowledgeForSync(rootDir);
  if (errors.length > 0) {
    console.error('Knowledge validation failed:');
    for (const error of errors) console.error(`- ${error}`);
    process.exit(1);
  }

  const teachings = await loadTeachingsFromDir(join(rootDir, 'teachings'));
  const referenceCards = await loadReferenceCardsFromDir(join(rootDir, 'references'));
  const documents = buildKnowledgeDocuments(teachings, referenceCards);
  if (documents.length === 0) {
    console.log('No knowledge files found');
    return;
  }

  const storeId = process.env.FILE_SEARCH_STORE_ID;
  const apiKey = process.env.GEMINI_API_KEY;
  const projectId = process.env.GCP_PROJECT_ID;
  if (!storeId || !apiKey) {
    throw new Error('Missing FILE_SEARCH_STORE_ID or GEMINI_API_KEY');
  }
  if (!projectId) {
    throw new Error('Missing GCP_PROJECT_ID');
  }
  initFirestore(projectId);
  const db = getDb();
  const summaries = buildSummaries(teachings);

  const result = await syncMarkdownDocumentsToFileSearch(documents, storeId, apiKey);
  console.log(`Uploaded: ${result.uploaded}, Errors: ${result.errors.length}`);
  if (result.errors.length > 0) {
    console.error('Sync errors:', result.errors);
    process.exit(1);
  }

  await db.doc('config/teaching_summaries').set({
    summaries,
    lastUpdatedAt: new Date(),
  });
  console.log(`Updated teaching summary map: ${summaries.length} entries`);
}

main().then(() => {
  process.exit(0);
}).catch(err => {
  console.error('Knowledge sync failed:', err);
  process.exit(1);
});
