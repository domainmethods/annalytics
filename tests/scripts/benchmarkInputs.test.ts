import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadLocalTeachingSummaries } from '../../scripts/benchmarkInputs.js';

describe('loadLocalTeachingSummaries', () => {
  it('returns an empty list when teachings are absent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'annalytics-benchmark-inputs-'));

    await expect(loadLocalTeachingSummaries(root)).resolves.toEqual([]);
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

    await expect(loadLocalTeachingSummaries(root)).resolves.toEqual([
      {
        term: 'revenue',
        definition: 'Use completed orders for revenue.',
        canonical_table: 'analytics.fct_orders',
      },
    ]);
  });
});
