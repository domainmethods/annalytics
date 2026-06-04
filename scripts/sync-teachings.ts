import { readdir, readFile } from 'fs/promises';
import { join } from 'path';
import { parseTeachingFile } from '../src/teachings/parser.js';
import { syncTeachingsToFileSearch } from '../src/teachings/fileSearchSync.js';
import { buildSummaries } from '../src/teachings/summaryMap.js';
import { initFirestore, getDb } from '../src/state/firestore.js';
import { loadDbtTableNames, validateTeachingIntegrity } from '../src/teachings/validation.js';
import { initBigQuery, dryRunValidation } from '../src/validation/dryRun.js';

async function main() {
  const teachingsDir = join(process.cwd(), 'teachings');
  let files: string[];
  try {
    files = await readdir(teachingsDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      console.log('No teachings directory found');
      return;
    }
    throw err;
  }
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

  const validTableNames = await loadDbtTableNames(process.cwd());
  const validationErrors = validateTeachingIntegrity(allTeachings, {
    validTableNames: validTableNames ?? undefined,
  });

  const projectId = process.env.GCP_PROJECT_ID;
  if (projectId) {
    initBigQuery(projectId);
    for (const teaching of allTeachings) {
      if (!teaching.sanctioned_sql) continue;
      const dryRun = await dryRunValidation(teaching.sanctioned_sql);
      if (!dryRun.valid) {
        validationErrors.push(`Teaching ${teaching.id} sanctioned_sql failed dry run: ${dryRun.error}`);
      }
    }
  }

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
