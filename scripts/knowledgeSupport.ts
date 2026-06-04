import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { referenceCardToMarkdown } from '../src/references/markdownConverter.js';
import { parseReferenceCardFile } from '../src/references/parser.js';
import type { ReferenceCard } from '../src/references/types.js';
import { validateReferenceCards } from '../src/references/validation.js';
import { teachingToMarkdown } from '../src/teachings/markdownConverter.js';
import type { FileSearchDocument } from '../src/teachings/fileSearchSync.js';
import { parseTeachingFile } from '../src/teachings/parser.js';
import type { Teaching } from '../src/teachings/types.js';
import { loadDbtTableNames, validateTeachingIntegrity } from '../src/teachings/validation.js';
import { dryRunValidation, initBigQuery } from '../src/validation/dryRun.js';

export async function loadTeachingsFromDir(teachingsDir: string): Promise<Teaching[]> {
  const files = await listYamlFilesOrEmpty(teachingsDir);
  const teachings: Teaching[] = [];

  for (const file of files) {
    const content = await readFile(join(teachingsDir, file), 'utf-8');
    teachings.push(...parseTeachingFile(content));
  }

  return teachings;
}

export async function loadReferenceCardsFromDir(referencesDir: string): Promise<ReferenceCard[]> {
  const files = await listYamlFilesOrEmpty(referencesDir);
  const cards: ReferenceCard[] = [];

  for (const file of files) {
    const content = await readFile(join(referencesDir, file), 'utf-8');
    cards.push(...parseReferenceCardFile(content));
  }

  return cards;
}

export function buildKnowledgeDocuments(
  teachings: Teaching[],
  referenceCards: ReferenceCard[],
): FileSearchDocument[] {
  return [
    ...teachings.map(teaching => ({
      id: teaching.id,
      displayName: `teaching:${teaching.id}`,
      markdown: teachingToMarkdown(teaching),
    })),
    ...referenceCards.map(card => ({
      id: card.id,
      displayName: `reference_card:${card.id}`,
      markdown: referenceCardToMarkdown(card),
    })),
  ];
}

export async function validateKnowledgeForSync(rootDir = process.cwd()): Promise<string[]> {
  const teachings = await loadTeachingsFromDir(join(rootDir, 'teachings'));
  const referenceCards = await loadReferenceCardsFromDir(join(rootDir, 'references'));
  if (teachings.length === 0 && referenceCards.length === 0) return [];

  let validTableNames: Set<string> | null;
  try {
    validTableNames = await loadDbtTableNames(rootDir);
  } catch (err) {
    return [`Unable to load dbt artifacts for knowledge validation: ${(err as Error).message}`];
  }

  const teachingErrors = validateTeachingIntegrity(teachings, {
    validTableNames: validTableNames ?? undefined,
  });
  const referenceErrors = validateReferenceCards(referenceCards, {
    validTableNames: validTableNames ?? undefined,
    validTeachingIds: teachings.length > 0 ? new Set(teachings.map(t => t.id)) : undefined,
    allowedDomains: new Set(['revenue']),
  });
  const errors = [...teachingErrors, ...referenceErrors];

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

async function listYamlFilesOrEmpty(dir: string): Promise<string[]> {
  try {
    const files = await readdir(dir);
    return files.filter(file => file.endsWith('.yml') || file.endsWith('.yaml'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}
