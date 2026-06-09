import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildKnowledgeDocuments,
  loadReferenceCardsFromDir,
  loadTeachingsFromDir,
  validateKnowledgeForSync,
} from '../../scripts/knowledgeSupport.js';
import type { ReferenceCard } from '../../src/references/types.js';
import type { Teaching } from '../../src/teachings/types.js';

function teaching(overrides: Partial<Teaching> = {}): Teaching {
  return {
    id: 'revenue-monthly',
    question_patterns: ['monthly revenue'],
    sanctioned_sql: null,
    reasoning: 'Use completed orders.',
    models_referenced: ['analytics.fct_orders'],
    tags: ['revenue'],
    author: 'finance',
    updated: '2026-06-04',
    ...overrides,
  };
}

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
    avoid_tables: [],
    aliases: ['revenue'],
    routing_triggers: ['total revenue'],
    owner: 'finance-analytics',
    freshness_sla: 'daily',
    related_teachings: ['revenue-monthly'],
    updated: '2026-06-04',
    ...overrides,
  };
}

describe('loadTeachingsFromDir', () => {
  it('treats a missing teachings directory as empty', async () => {
    await expect(loadTeachingsFromDir('/tmp/annalytics-missing-teachings')).resolves.toEqual([]);
  });
});

describe('loadReferenceCardsFromDir', () => {
  it('treats a missing references directory as empty', async () => {
    await expect(loadReferenceCardsFromDir('/tmp/annalytics-missing-references')).resolves.toEqual([]);
  });

  it('loads YAML reference cards from a directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'annalytics-references-'));
    await writeFile(join(root, 'revenue.yml'), `
reference_cards:
  - id: revenue-canonical-definition
    title: Canonical Revenue Definition
    domain: revenue
    grain: order
    canonical_table: analytics.fct_orders
    canonical_metric: total_amount
    aliases: [revenue]
    routing_triggers: [total revenue]
    owner: finance-analytics
    freshness_sla: daily
    updated: "2026-06-04"
`);

    const cards = await loadReferenceCardsFromDir(root);
    expect(cards).toHaveLength(1);
    expect(cards[0].id).toBe('revenue-canonical-definition');
  });
});

describe('buildKnowledgeDocuments', () => {
  it('builds teaching and reference-card documents with namespaced display names', () => {
    const documents = buildKnowledgeDocuments([teaching()], [card()]);

    expect(documents.map(doc => doc.displayName)).toEqual([
      'teaching:revenue-monthly',
      'reference_card:revenue-canonical-definition',
    ]);
    expect(documents[0].markdown).toContain('# Teaching: revenue-monthly');
    expect(documents[1].markdown).toContain('# ReferenceCard: revenue-canonical-definition');
  });
});

describe('validateKnowledgeForSync', () => {
  it('validates teachings and references without dbt artifacts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'annalytics-knowledge-'));
    await mkdir(join(root, 'teachings'), { recursive: true });
    await mkdir(join(root, 'references'), { recursive: true });
    await writeFile(join(root, 'teachings', 'revenue.yml'), `
teachings:
  - id: revenue-monthly
    question_patterns: [monthly revenue]
    sanctioned_sql: null
    reasoning: Use completed orders.
    models_referenced: [analytics.fct_orders]
    tags: [revenue]
    author: finance
    updated: "2026-06-04"
`);
    await writeFile(join(root, 'references', 'revenue.yml'), `
reference_cards:
  - id: revenue-canonical-definition
    title: Canonical Revenue Definition
    domain: revenue
    grain: order
    canonical_table: analytics.fct_orders
    canonical_metric: total_amount
    aliases: [revenue]
    routing_triggers: [total revenue]
    owner: finance-analytics
    freshness_sla: daily
    related_teachings: [revenue-monthly]
    updated: "2026-06-04"
`);

    await expect(validateKnowledgeForSync(root)).resolves.toEqual([]);
  });

  it('keeps ReferenceCard table mismatches strict for sync validation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'annalytics-knowledge-'));
    await mkdir(join(root, 'references'), { recursive: true });
    await mkdir(join(root, 'dbt'), { recursive: true });
    await writeFile(join(root, 'references', 'revenue.yml'), `
reference_cards:
  - id: revenue-canonical-definition
    title: Canonical Revenue Definition
    domain: revenue
    grain: order
    canonical_table: analytics.fct_orders
    canonical_metric: total_amount
    aliases: [revenue]
    routing_triggers: [total revenue]
    owner: finance-analytics
    freshness_sla: daily
    updated: "2026-06-04"
`);
    await writeFile(join(root, 'dbt', 'manifest.json'), JSON.stringify({
      nodes: {
        'model.analytics.fct_revenue': {
          resource_type: 'model',
          name: 'fct_revenue',
          schema: 'analytics',
          columns: {
            revenue: { name: 'revenue' },
          },
        },
      },
    }));
    await writeFile(join(root, 'dbt', 'catalog.json'), JSON.stringify({
      nodes: {
        'model.analytics.fct_revenue': {
          columns: {
            REVENUE: { type: 'FLOAT64', index: 0 },
          },
        },
      },
    }));

    await expect(validateKnowledgeForSync(root)).resolves.toContain(
      'Reference card revenue-canonical-definition references unknown canonical table: analytics.fct_orders',
    );
  });

  it('keeps teaching table mismatches strict for sync validation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'annalytics-knowledge-'));
    await mkdir(join(root, 'teachings'), { recursive: true });
    await mkdir(join(root, 'dbt'), { recursive: true });
    await writeFile(join(root, 'teachings', 'revenue.yml'), `
teachings:
  - id: revenue-monthly
    question_patterns: [monthly revenue]
    sanctioned_sql: null
    reasoning: Use completed orders.
    models_referenced: [analytics.fct_orders]
    tags: [revenue]
    author: finance
    updated: "2026-06-04"
`);
    await writeFile(join(root, 'dbt', 'manifest.json'), JSON.stringify({
      nodes: {
        'model.analytics.fct_revenue': {
          resource_type: 'model',
          name: 'fct_revenue',
          schema: 'analytics',
          columns: {
            revenue: { name: 'revenue' },
          },
        },
      },
    }));
    await writeFile(join(root, 'dbt', 'catalog.json'), JSON.stringify({
      nodes: {
        'model.analytics.fct_revenue': {
          columns: {
            REVENUE: { type: 'FLOAT64', index: 0 },
          },
        },
      },
    }));

    await expect(validateKnowledgeForSync(root)).resolves.toContain(
      'Teaching revenue-monthly references unknown model/table: analytics.fct_orders',
    );
  });

  it('does not hard-code the allowed reference-card domain for template implementations', async () => {
    const root = await mkdtemp(join(tmpdir(), 'annalytics-knowledge-'));
    await mkdir(join(root, 'references'), { recursive: true });
    await writeFile(join(root, 'references', 'churn.yml'), `
reference_cards:
  - id: churn-card
    title: Churn Definition
    domain: churn
    grain: account
    canonical_table: analytics.fct_churn
    canonical_metric: churned_accounts
    aliases: [churn]
    routing_triggers: [churn]
    owner: finance-analytics
    freshness_sla: daily
    related_teachings: [missing-teaching]
    updated: "2026-06-04"
`);

    await expect(validateKnowledgeForSync(root)).resolves.toEqual([]);
  });

  it('validates related teachings when teachings are loaded', async () => {
    const root = await mkdtemp(join(tmpdir(), 'annalytics-knowledge-'));
    await mkdir(join(root, 'teachings'), { recursive: true });
    await mkdir(join(root, 'references'), { recursive: true });
    await writeFile(join(root, 'teachings', 'revenue.yml'), `
teachings:
  - id: revenue-monthly
    question_patterns: [monthly revenue]
    sanctioned_sql: null
    reasoning: Use completed orders.
    models_referenced: [analytics.fct_orders]
    tags: [revenue]
    author: finance
    updated: "2026-06-04"
`);
    await writeFile(join(root, 'references', 'revenue.yml'), `
reference_cards:
  - id: revenue-canonical-definition
    title: Canonical Revenue Definition
    domain: revenue
    grain: order
    canonical_table: analytics.fct_orders
    canonical_metric: total_amount
    aliases: [revenue]
    routing_triggers: [total revenue]
    owner: finance-analytics
    freshness_sla: daily
    related_teachings: [missing-teaching]
    updated: "2026-06-04"
`);

    await expect(validateKnowledgeForSync(root)).resolves.toContain(
      'Reference card revenue-canonical-definition references unknown related teaching: missing-teaching',
    );
  });
});
