import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initFirestore } from '../src/state/firestore.js';
import { getResponseContextsSince } from '../src/state/responseContext.js';
import { getDomainPainRanking, getConfidenceCalibration } from '../src/feedback/aggregation.js';
import { toFeedbackRecords, formatReport } from '../src/feedback/report.js';
import type { DomainMapEntry } from '../src/feedback/domainAttribution.js';
import { loadReferenceCardsFromDir } from './knowledgeSupport.js';

async function main() {
  const projectId = process.env.GCP_PROJECT_ID;
  if (!projectId) { console.error('GCP_PROJECT_ID is required'); process.exit(1); }
  const windowDays = Number(process.env.WINDOW_DAYS ?? 30);

  initFirestore(projectId);

  // ReferenceCard.canonical_table / .domain are snake_case (src/references/types.ts).
  // loadReferenceCardsFromDir lives in scripts/knowledgeSupport.ts and reads references/*.yml.
  const cards = await loadReferenceCardsFromDir(join(process.cwd(), 'references'));
  const domainMap: DomainMapEntry[] = cards
    .filter((c) => c.canonical_table && c.domain)
    .map((c) => ({ table: c.canonical_table, domain: c.domain }));

  const docs = await getResponseContextsSince(windowDays);
  const records = toFeedbackRecords(docs, domainMap);

  console.log(formatReport(
    getDomainPainRanking(records),
    getConfidenceCalibration(records),
    windowDays,
  ));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
