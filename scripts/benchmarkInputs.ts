import { join } from 'node:path';
import { buildSummaries } from '../src/teachings/summaryMap.js';
import type { TeachingSummary } from '../src/teachings/types.js';
import { loadTeachingsFromDir } from './knowledgeSupport.js';

export async function loadLocalTeachingSummaries(rootDir: string): Promise<TeachingSummary[]> {
  const teachings = await loadTeachingsFromDir(join(rootDir, 'teachings'));
  return buildSummaries(teachings);
}
