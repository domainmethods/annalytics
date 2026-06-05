import { join } from 'node:path';
import { buildKnowledgeSummaries } from '../src/teachings/summaryMap.js';
import type { KnowledgeSummary } from '../src/teachings/types.js';
import { loadReferenceCardsFromDir, loadTeachingsFromDir } from './knowledgeSupport.js';

export async function loadLocalKnowledgeSummaries(rootDir: string): Promise<KnowledgeSummary[]> {
  const teachings = await loadTeachingsFromDir(join(rootDir, 'teachings'));
  const referenceCards = await loadReferenceCardsFromDir(join(rootDir, 'references'));
  return buildKnowledgeSummaries(teachings, referenceCards);
}

export async function loadLocalTeachingSummaries(rootDir: string): Promise<KnowledgeSummary[]> {
  return loadLocalKnowledgeSummaries(rootDir);
}
