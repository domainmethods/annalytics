import { readdir, readFile } from 'fs/promises';
import { join } from 'path';
import { parseTeachingFile } from '../src/teachings/parser.js';
import { syncTeachingsToFileSearch } from '../src/teachings/fileSearchSync.js';
import { buildSummaries } from '../src/teachings/summaryMap.js';
import { initFirestore, getDb } from '../src/state/firestore.js';

async function main() {
  const teachingsDir = join(process.cwd(), 'teachings');
  const files = await readdir(teachingsDir);
  const yamlFiles = files.filter(f => f.endsWith('.yml') || f.endsWith('.yaml'));

  if (yamlFiles.length === 0) {
    console.log('No teaching YAML files found');
    return;
  }

  // Parse all teaching files
  const allTeachings = [];
  for (const file of yamlFiles) {
    const content = await readFile(join(teachingsDir, file), 'utf-8');
    const teachings = parseTeachingFile(content);
    allTeachings.push(...teachings);
  }

  console.log(`Parsed ${allTeachings.length} teachings from ${yamlFiles.length} files`);

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

main().catch(err => {
  console.error('Teaching sync failed:', err);
  process.exit(1);
});
