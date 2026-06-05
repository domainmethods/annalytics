import { join } from 'path';
import { syncTeachingsToFileSearch } from '../src/teachings/fileSearchSync.js';
import { buildSummaries } from '../src/teachings/summaryMap.js';
import { initFirestore, getDb } from '../src/state/firestore.js';
import { loadTeachingsFromDir, validateTeachingsForSync } from './validate-teachings.js';

async function main() {
  const rootDir = process.cwd();
  const teachingsDir = join(rootDir, 'teachings');
  const allTeachings = await loadTeachingsFromDir(teachingsDir);
  if (allTeachings.length === 0) {
    console.log('No teaching YAML files found');
    return;
  }

  console.log(`Parsed ${allTeachings.length} teachings`);
  const validationErrors = await validateTeachingsForSync(rootDir);
  if (validationErrors.length > 0) {
    console.error('Teaching validation failed:');
    for (const error of validationErrors) console.error(`- ${error}`);
    process.exit(1);
  }

  // Sync to File Search
  const storeId = process.env.FILE_SEARCH_STORE_ID;
  const apiKey = process.env.GEMINI_API_KEY;
  if (!storeId || !apiKey) {
    throw new Error('Missing FILE_SEARCH_STORE_ID or GEMINI_API_KEY');
  }

  const result = await syncTeachingsToFileSearch(allTeachings, storeId, apiKey);
  console.log(`Uploaded: ${result.uploaded}, Errors: ${result.errors.length}`);

  if (result.errors.length > 0) {
    console.error('Sync errors:', result.errors);
    process.exit(1);
  }

  // Update Firestore teaching summary map
  const projectId = process.env.GCP_PROJECT_ID;
  if (!projectId) {
    throw new Error('Missing GCP_PROJECT_ID');
  }
  initFirestore(projectId);
  const db = getDb();
  const summaries = buildSummaries(allTeachings);
  await db.doc('config/teaching_summaries').set({
    summaries,
    lastUpdatedAt: new Date(),
  });
  console.log(`Updated teaching summary map: ${summaries.length} entries`);
}

main().then(() => {
  process.exit(0); // Force exit to close Firestore handles
}).catch(err => {
  console.error('Teaching sync failed:', err);
  process.exit(1);
});
