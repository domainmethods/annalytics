import type { ReferenceCard } from '../references/types.js';
import type { Teaching, TeachingSummary, KnowledgeSummary } from './types.js';
import { getDb } from '../state/firestore.js';

export function buildSummaries(teachings: Teaching[]): TeachingSummary[] {
  return teachings.map(t => ({
    term: t.tags[0] || t.id,
    definition: t.reasoning.split('\n')[0].trim(),
    canonical_table: t.models_referenced[0],
  }));
}

export function buildKnowledgeSummaries(
  teachings: Teaching[],
  referenceCards: ReferenceCard[] = [],
): KnowledgeSummary[] {
  return [
    ...buildSummaries(teachings).map((summary, index) => ({
      ...summary,
      kind: 'teaching' as const,
      id: teachings[index].id,
      aliases: teachings[index].question_patterns,
    })),
    ...referenceCards.map(card => ({
      kind: 'reference_card' as const,
      id: card.id,
      term: card.title,
      definition: buildReferenceSummaryDefinition(card),
      canonical_table: card.canonical_table,
      canonical_metric: card.canonical_metric,
      aliases: card.aliases,
      routing_triggers: card.routing_triggers,
    })),
  ];
}

let cachedSummaries: KnowledgeSummary[] = [];
let cachedLastUpdatedAt: Date | null = null;

export async function getKnowledgeSummaries(): Promise<KnowledgeSummary[]> {
  const db = getDb();
  const knowledgeDoc = await db.doc('config/knowledge_summaries').get();
  const doc = knowledgeDoc.exists
    ? knowledgeDoc
    : await db.doc('config/teaching_summaries').get();
  if (!doc.exists) return cachedSummaries;

  const data = doc.data()!;
  const remoteUpdatedAt: Date = data.lastUpdatedAt?.toDate?.() ?? new Date(0);

  if (!cachedLastUpdatedAt || remoteUpdatedAt > cachedLastUpdatedAt) {
    cachedSummaries = data.summaries as KnowledgeSummary[];
    cachedLastUpdatedAt = remoteUpdatedAt;
  }
  return cachedSummaries;
}

export async function getTeachingSummaries(): Promise<KnowledgeSummary[]> {
  return getKnowledgeSummaries();
}

export function startSummaryRefresh(intervalMs = 5 * 60 * 1000): NodeJS.Timeout {
  // Eagerly load summaries at startup
  getKnowledgeSummaries().catch(err => {
    console.warn('Initial knowledge summary load failed:', (err as Error).message);
  });

  return setInterval(() => {
    getKnowledgeSummaries().catch(err => {
      console.warn('Knowledge summary refresh failed:', (err as Error).message);
    });
  }, intervalMs);
}

export function _resetCache(): void {
  cachedSummaries = [];
  cachedLastUpdatedAt = null;
}

function buildReferenceSummaryDefinition(card: ReferenceCard): string {
  const filters = card.required_filters.length > 0
    ? ` Required guidance: ${card.required_filters.join('; ')}.`
    : '';
  return `${card.title}. Canonical metric ${card.canonical_metric} at ${card.grain} grain.${filters}`;
}
