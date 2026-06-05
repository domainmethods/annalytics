import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadLocalKnowledgeSummaries, loadLocalTeachingSummaries } from '../../scripts/benchmarkInputs.js';

describe('loadLocalKnowledgeSummaries', () => {
  it('returns an empty list when knowledge files are absent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'annalytics-benchmark-inputs-'));

    await expect(loadLocalKnowledgeSummaries(root)).resolves.toEqual([]);
  });

  it('builds clarification summaries from local teaching YAML', async () => {
    const root = await mkdtemp(join(tmpdir(), 'annalytics-benchmark-inputs-'));
    await mkdir(join(root, 'teachings'), { recursive: true });
    await writeFile(join(root, 'teachings', 'revenue.yml'), `
teachings:
  - id: revenue-monthly
    question_patterns: [monthly revenue]
    sanctioned_sql: null
    reasoning: Use completed orders for revenue.
    models_referenced: [analytics.fct_orders]
    tags: [revenue]
    author: finance
    updated: "2026-06-04"
`);

    await expect(loadLocalKnowledgeSummaries(root)).resolves.toEqual([
      {
        term: 'revenue',
        definition: 'Use completed orders for revenue.',
        canonical_table: 'analytics.fct_orders',
        kind: 'teaching',
        id: 'revenue-monthly',
        aliases: ['monthly revenue'],
      },
    ]);
  });

  it('builds clarification summaries from local ReferenceCard YAML', async () => {
    const root = await mkdtemp(join(tmpdir(), 'annalytics-benchmark-inputs-'));
    await mkdir(join(root, 'references'), { recursive: true });
    await writeFile(join(root, 'references', 'revenue.yml'), `
reference_cards:
  - id: revenue-canonical-definition
    title: Canonical Revenue Definition
    domain: revenue
    grain: order
    canonical_table: analytics.fct_orders
    canonical_metric: total_amount
    aliases: [revenue, sales]
    routing_triggers: [total revenue]
    owner: finance
    freshness_sla: daily
    updated: "2026-06-04"
`);

    await expect(loadLocalKnowledgeSummaries(root)).resolves.toEqual([
      expect.objectContaining({
        kind: 'reference_card',
        id: 'revenue-canonical-definition',
        term: 'Canonical Revenue Definition',
        canonical_table: 'analytics.fct_orders',
        canonical_metric: 'total_amount',
        aliases: ['revenue', 'sales'],
        routing_triggers: ['total revenue'],
      }),
    ]);
  });
});

describe('loadLocalTeachingSummaries', () => {
  it('keeps the legacy export as an alias for knowledge summaries', async () => {
    const root = await mkdtemp(join(tmpdir(), 'annalytics-benchmark-inputs-'));

    await expect(loadLocalTeachingSummaries(root)).resolves.toEqual([]);
  });
});
