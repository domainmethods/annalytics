import type { ReferenceCard } from './types.js';

export function referenceCardToMarkdown(card: ReferenceCard): string {
  const lines: string[] = [
    `# ReferenceCard: ${card.id}`,
    `Title: ${card.title}`,
    `Domain: ${card.domain}`,
    `Owner: ${card.owner}`,
    `Updated: ${card.updated}`,
    `Freshness SLA: ${card.freshness_sla}`,
    `Canonical table: ${card.canonical_table}`,
    `Canonical metric: ${card.canonical_metric}`,
    `Grain: ${card.grain}`,
    '',
    '## Aliases',
    ...toBullets(card.aliases),
    '',
    '## Routing Triggers',
    ...toBullets(card.routing_triggers),
    '',
    '## Required Filters',
    ...toBullets(card.required_filters),
    '',
    '## Exclusions',
    ...toBullets(card.exclusions),
    '',
    '## Avoid Tables',
    ...toBullets(card.avoid_tables),
    '',
    '## Related Teachings',
    ...toBullets(card.related_teachings),
  ];

  return lines.join('\n');
}

function toBullets(values: string[]): string[] {
  if (values.length === 0) return ['- none'];
  return values.map(value => `- ${value}`);
}
