import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type { ReferenceCard } from '../../src/references/types.js';
import { parseReferenceCardFile } from '../../src/references/parser.js';
import { validateReferenceCardIntegrity } from '../../src/references/validation.js';

function card(overrides: Partial<ReferenceCard> = {}): ReferenceCard {
  return {
    id: 'revenue-canonical-definition',
    title: 'Canonical Revenue Definition',
    domain: 'revenue',
    grain: 'order',
    canonical_table: 'analytics.fct_orders',
    canonical_metric: 'total_amount',
    required_filters: ["order_status = 'completed'"],
    exclusions: ['cancelled orders'],
    avoid_tables: ['analytics.fct_revenue'],
    aliases: ['revenue'],
    routing_triggers: ['total revenue'],
    owner: 'finance-analytics',
    freshness_sla: 'refreshed daily after dbt build',
    related_teachings: ['revenue-monthly'],
    updated: '2026-06-04',
    ...overrides,
  };
}

describe('validateReferenceCardIntegrity', () => {
  it('rejects duplicate IDs', () => {
    const errors = validateReferenceCardIntegrity([
      card(),
      card({ title: 'Duplicate' }),
    ]);

    expect(errors).toContain('Duplicate reference card id: revenue-canonical-definition');
  });

  it('rejects empty aliases and routing triggers', () => {
    const errors = validateReferenceCardIntegrity([
      card({ aliases: ['revenue', ''], routing_triggers: ['  '] }),
    ]);

    expect(errors).toContain('Reference card revenue-canonical-definition includes an empty alias');
    expect(errors).toContain('Reference card revenue-canonical-definition includes an empty routing trigger');
  });

  it('rejects missing aliases and routing triggers', () => {
    const errors = validateReferenceCardIntegrity([
      card({ aliases: [], routing_triggers: [] }),
    ]);

    expect(errors).toContain('Reference card revenue-canonical-definition must include at least one alias');
    expect(errors).toContain('Reference card revenue-canonical-definition must include at least one routing trigger');
  });

  it('rejects missing or malformed updated dates', () => {
    const errors = validateReferenceCardIntegrity([
      card({ id: 'missing-date', updated: '' }),
      card({ id: 'bad-date', updated: '2026/06/04' }),
      card({ id: 'impossible-date', updated: '2026-02-31' }),
    ]);

    expect(errors).toContain('Reference card missing-date has invalid or missing updated date: ');
    expect(errors).toContain('Reference card bad-date has invalid or missing updated date: 2026/06/04');
    expect(errors).toContain('Reference card impossible-date has invalid or missing updated date: 2026-02-31');
  });

  it('rejects unsupported domains when allowedDomains is provided', () => {
    const errors = validateReferenceCardIntegrity([
      card({ domain: 'product' }),
    ], { allowedDomains: new Set(['revenue']) });

    expect(errors).toContain('Reference card revenue-canonical-definition has unsupported domain: product');
  });

  it('validates canonical and avoid tables only when validTableNames is provided', () => {
    expect(validateReferenceCardIntegrity([
      card({ canonical_table: 'missing.table', avoid_tables: ['also.missing'] }),
    ])).toEqual([]);

    const errors = validateReferenceCardIntegrity([
      card({ canonical_table: 'missing.table', avoid_tables: ['also.missing'] }),
    ], { validTableNames: new Set(['analytics.fct_orders']) });

    expect(errors).toContain('Reference card revenue-canonical-definition references unknown canonical table: missing.table');
    expect(errors).toContain('Reference card revenue-canonical-definition references unknown avoid table: also.missing');
  });

  it('validates related teachings only when validTeachingIds is provided', () => {
    expect(validateReferenceCardIntegrity([
      card({ related_teachings: ['unknown-teaching'] }),
    ])).toEqual([]);

    const errors = validateReferenceCardIntegrity([
      card({ related_teachings: ['unknown-teaching'] }),
    ], { validTeachingIds: new Set(['revenue-monthly']) });

    expect(errors).toContain('Reference card revenue-canonical-definition references unknown related teaching: unknown-teaching');
  });

  it('accepts the starter revenue sample cards', () => {
    const yaml = readFileSync('references/revenue.yml', 'utf-8');
    const cards = parseReferenceCardFile(yaml);

    expect(cards.map(({ id }) => id)).toEqual([
      'revenue-canonical-definition',
      'revenue-monthly-grain',
      'revenue-customer-lifetime-value',
      'revenue-refunds-exclusions',
      'revenue-ambiguous-intake',
    ]);

    const errors = validateReferenceCardIntegrity(cards, {
      allowedDomains: new Set(['revenue']),
      validTableNames: new Set(['analytics.fct_orders', 'analytics.fct_revenue']),
      validTeachingIds: new Set(['revenue-monthly']),
    });

    expect(errors).toEqual([]);
  });
});
