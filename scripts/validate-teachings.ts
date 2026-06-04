import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseTeachingFile } from '../src/teachings/parser.js';
import { loadDbtTableNames, validateTeachingIntegrity } from '../src/teachings/validation.js';
import { initBigQuery, dryRunValidation } from '../src/validation/dryRun.js';
import type { Teaching } from '../src/teachings/types.js';

export async function loadTeachingsFromDir(teachingsDir: string): Promise<Teaching[]> {
  let files: string[];
  try {
    files = await readdir(teachingsDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const yamlFiles = files.filter(f => f.endsWith('.yml') || f.endsWith('.yaml'));
  const teachings: Teaching[] = [];

  for (const file of yamlFiles) {
    const content = await readFile(join(teachingsDir, file), 'utf-8');
    teachings.push(...parseTeachingFile(content));
  }

  return teachings;
}

export async function validateTeachingsForSync(rootDir = process.cwd()): Promise<string[]> {
  const teachingsDir = join(rootDir, 'teachings');
  const teachings = await loadTeachingsFromDir(teachingsDir);
  if (teachings.length === 0) return [];

  let validTableNames: Set<string> | null;
  try {
    validTableNames = await loadDbtTableNames(rootDir);
  } catch (err) {
    return [`Unable to load dbt artifacts for teaching validation: ${(err as Error).message}`];
  }

  const errors = validateTeachingIntegrity(teachings, {
    validTableNames: validTableNames ?? undefined,
  });

  const projectId = process.env.GCP_PROJECT_ID;
  if (projectId) {
    initBigQuery(projectId);
    for (const teaching of teachings) {
      if (!teaching.sanctioned_sql) continue;
      const result = await dryRunValidation(teaching.sanctioned_sql);
      if (!result.valid) {
        errors.push(`Teaching ${teaching.id} sanctioned_sql failed dry run: ${result.error}`);
      }
    }
  }

  return errors;
}

async function main() {
  const errors = await validateTeachingsForSync();
  if (errors.length > 0) {
    console.error('Teaching validation failed:');
    for (const error of errors) {
      console.error(`- ${error}`);
    }
    process.exit(1);
  }
  console.log('Teaching validation passed');
}

if (process.argv[1]?.endsWith('validate-teachings.ts') || process.argv[1]?.endsWith('validate-teachings.js')) {
  main().catch(err => {
    console.error('Teaching validation failed:', err);
    process.exit(1);
  });
}
