import { describe, expect, it } from 'vitest';
import { parseReferenceCardFile } from '../../src/references/parser.js';

describe('parseReferenceCardFile', () => {
  it('parses reference cards and coerces missing arrays to empty arrays', () => {
    const yaml = `reference_cards:
  - id: revenue-canonical-definition
    title: Canonical Revenue Definition
    domain: revenue
    grain: order
    canonical_table: analytics.fct_orders
    canonical_metric: total_amount
    owner: finance-analytics
    freshness_sla: refreshed daily after dbt build
    updated: "2026-06-04"
`;

    const cards = parseReferenceCardFile(yaml);

    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      id: 'revenue-canonical-definition',
      title: 'Canonical Revenue Definition',
      domain: 'revenue',
      grain: 'order',
      canonical_table: 'analytics.fct_orders',
      canonical_metric: 'total_amount',
      owner: 'finance-analytics',
      freshness_sla: 'refreshed daily after dbt build',
      updated: '2026-06-04',
      required_filters: [],
      exclusions: [],
      avoid_tables: [],
      aliases: [],
      routing_triggers: [],
      related_teachings: [],
    });
  });

  it('rejects missing required scalar fields', () => {
    const yaml = `reference_cards:
  - id: revenue-canonical-definition
    title: Canonical Revenue Definition
    domain: revenue
    grain: order
    canonical_metric: total_amount
    owner: finance-analytics
    freshness_sla: refreshed daily after dbt build
    updated: "2026-06-04"
`;

    expect(() => parseReferenceCardFile(yaml)).toThrow(/canonical_table/);
  });

  it('rejects files without a top-level reference_cards array', () => {
    expect(() => parseReferenceCardFile('cards: []')).toThrow(/reference_cards/);
  });
});
