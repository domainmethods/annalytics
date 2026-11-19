import { matchesRelation } from '../dbt/relationMatching.js';
import { readFile } from 'node:fs/promises';
import { resolveDbtArtifactPath } from '../dbt/artifactPaths.js';
import type { Teaching } from './types.js';
import { parseDbtArtifacts } from '../dbt/parser.js';

export interface TeachingIntegrityOptions {
  validTableNames?: Set<string>;
}

export function validateTeachingIntegrity(
  teachings: Teaching[],
  options: TeachingIntegrityOptions = {},
): string[] {
  const errors: string[] = [];
  const seenIds = new Set<string>();

  for (const teaching of teachings) {
    if (seenIds.has(teaching.id)) {
      errors.push(`Duplicate teaching id: ${teaching.id}`);
    }
    seenIds.add(teaching.id);

    if (teaching.question_patterns.length === 0) {
      errors.push(`Teaching ${teaching.id} must include at least one question pattern`);
    }

    for (const pattern of teaching.question_patterns) {
      if (pattern.trim().length === 0) {
        errors.push(`Teaching ${teaching.id} includes an empty question pattern`);
      }
    }

    if (teaching.models_referenced.length === 0) {
      errors.push(`Teaching ${teaching.id} must reference at least one model/table`);
    }

    if (options.validTableNames) {
      for (const model of teaching.models_referenced) {
        if (!matchesRelation(model, options.validTableNames)) {
          errors.push(`Teaching ${teaching.id} references unknown model/table: ${model}`);
        }
      }
    }

    if (!teaching.updated || !/^\d{4}-\d{2}-\d{2}$/.test(teaching.updated)) {
      errors.push(`Teaching ${teaching.id} has invalid or missing updated date: ${teaching.updated}`);
    }
  }

  return errors;
}

export async function loadDbtTableNames(rootDir: string): Promise<Set<string> | null> {
  try {
    const manifestRaw = await readFile(resolveDbtArtifactPath(process.env.DBT_MANIFEST_PATH || './dbt/manifest.json', rootDir), 'utf-8');
    const catalogRaw = await readFile(resolveDbtArtifactPath(process.env.DBT_CATALOG_PATH || './dbt/catalog.json', rootDir), 'utf-8');
    const manifest = JSON.parse(manifestRaw) as Parameters<typeof parseDbtArtifacts>[0];
    const catalog = JSON.parse(catalogRaw) as Parameters<typeof parseDbtArtifacts>[1];
    return new Set(parseDbtArtifacts(manifest, catalog).map(t => t.name));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}
