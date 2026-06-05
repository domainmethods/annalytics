import { describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadDbtTableNames, validateTeachingIntegrity } from '../../src/teachings/validation.js';
import type { Teaching } from '../../src/teachings/types.js';
import { loadTeachingsFromDir } from '../../scripts/validate-teachings.js';

function teaching(overrides: Partial<Teaching> = {}): Teaching {
  return {
    id: 'revenue-monthly',
    question_patterns: ['monthly revenue'],
    sanctioned_sql: 'SELECT SUM(total_amount) FROM `analytics.fct_orders`',
    reasoning: 'Use completed orders only.',
    models_referenced: ['analytics.fct_orders'],
    tags: ['revenue'],
    author: 'data@example.com',
    updated: '2026-06-01',
    ...overrides,
  };
}

describe('validateTeachingIntegrity', () => {
  it('rejects duplicate teaching IDs', () => {
    const errors = validateTeachingIntegrity([
      teaching(),
      teaching({ question_patterns: ['revenue by month'] }),
    ], { validTableNames: new Set(['analytics.fct_orders']) });

    expect(errors).toContain('Duplicate teaching id: revenue-monthly');
  });

  it('rejects empty question patterns', () => {
    const errors = validateTeachingIntegrity([
      teaching({ question_patterns: [] }),
    ], { validTableNames: new Set(['analytics.fct_orders']) });

    expect(errors).toContain('Teaching revenue-monthly must include at least one question pattern');
  });

  it('rejects model references missing from dbt artifacts', () => {
    const errors = validateTeachingIntegrity([
      teaching({ models_referenced: ['analytics.missing_table'] }),
    ], { validTableNames: new Set(['analytics.fct_orders']) });

    expect(errors).toContain('Teaching revenue-monthly references unknown model/table: analytics.missing_table');
  });

  it('rejects missing or malformed updated dates', () => {
    const errors = validateTeachingIntegrity([
      teaching({ id: 'missing-updated', updated: '' }),
      teaching({ id: 'malformed-updated', updated: '2026/06/01' }),
    ], { validTableNames: new Set(['analytics.fct_orders']) });

    expect(errors).toContain('Teaching missing-updated has invalid or missing updated date: ');
    expect(errors).toContain('Teaching malformed-updated has invalid or missing updated date: 2026/06/01');
  });
});

describe('loadTeachingsFromDir', () => {
  it('treats a missing teachings directory as empty', async () => {
    const root = await mkdtemp(join(tmpdir(), 'annalytics-teachings-'));
    await expect(loadTeachingsFromDir(join(root, 'missing'))).resolves.toEqual([]);
  });
});

describe('loadDbtTableNames', () => {
  it('returns null when dbt artifacts are missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'annalytics-dbt-'));
    await expect(loadDbtTableNames(root)).resolves.toBeNull();
  });
});
