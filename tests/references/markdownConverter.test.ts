import { describe, expect, it } from 'vitest';
import type { ReferenceCard } from '../../src/references/types.js';
import { referenceCardToMarkdown } from '../../src/references/markdownConverter.js';

describe('referenceCardToMarkdown', () => {
  it('emits a stable heading and all operational fields', () => {
    const card: ReferenceCard = {
      id: 'revenue-canonical-definition',
      title: 'Canonical Revenue Definition',
      domain: 'revenue',
      grain: 'order',
      canonical_table: 'analytics.fct_orders',
      canonical_metric: 'total_amount',
      required_filters: ["order_status = 'completed'"],
      exclusions: ['cancelled orders', 'refunded orders'],
      avoid_tables: ['analytics.fct_revenue'],
      aliases: ['revenue', 'sales'],
      routing_triggers: ['total revenue', 'revenue last month'],
      owner: 'finance-analytics',
      freshness_sla: 'refreshed daily after dbt build',
      related_teachings: ['revenue-monthly'],
      updated: '2026-06-04',
    };

    const markdown = referenceCardToMarkdown(card);

    expect(markdown).toContain('# ReferenceCard: revenue-canonical-definition');
    expect(markdown).toContain('Title: Canonical Revenue Definition');
    expect(markdown).toContain('Domain: revenue');
    expect(markdown).toContain('Owner: finance-analytics');
    expect(markdown).toContain('Updated: 2026-06-04');
    expect(markdown).toContain('Freshness SLA: refreshed daily after dbt build');
    expect(markdown).toContain('Canonical table: analytics.fct_orders');
    expect(markdown).toContain('Canonical metric: total_amount');
    expect(markdown).toContain('Grain: order');
    expect(markdown).toContain('## Aliases\n- revenue\n- sales');
    expect(markdown).toContain('## Routing Triggers\n- total revenue\n- revenue last month');
    expect(markdown).toContain("## Required Filters\n- order_status = 'completed'");
    expect(markdown).toContain('## Exclusions\n- cancelled orders\n- refunded orders');
    expect(markdown).toContain('## Avoid Tables\n- analytics.fct_revenue');
    expect(markdown).toContain('## Related Teachings\n- revenue-monthly');
  });
});
