import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parseTeachingFile } from '../../src/teachings/parser.js';

const fixture = readFileSync(
  join(__dirname, '../fixtures/teachings/revenue-metrics.yml'),
  'utf-8',
);

describe('parseTeachingFile', () => {
  it('parses multiple teachings from a single YAML file', () => {
    const teachings = parseTeachingFile(fixture);
    expect(teachings).toHaveLength(2);
  });

  it('parses sanctioned SQL teaching with all fields', () => {
    const teachings = parseTeachingFile(fixture);
    const revenue = teachings.find(t => t.id === 'revenue-monthly')!;

    expect(revenue.id).toBe('revenue-monthly');
    expect(revenue.sanctioned_sql).toContain('SUM(total_amount)');
    expect(revenue.reasoning).toContain('order_status');
    expect(revenue.author).toBe('jane@company.com');
    expect(revenue.updated).toBe('2026-02-10');
  });

  it('parses reasoning-only teaching (null sanctioned_sql)', () => {
    const teachings = parseTeachingFile(fixture);
    const churn = teachings.find(t => t.id === 'churn-definition')!;

    expect(churn.sanctioned_sql).toBeNull();
    expect(churn.reasoning).toContain('churned');
  });

  it('preserves question_patterns as string array', () => {
    const teachings = parseTeachingFile(fixture);
    const revenue = teachings.find(t => t.id === 'revenue-monthly')!;

    expect(revenue.question_patterns).toEqual([
      'monthly revenue',
      'revenue by month',
      'MRR',
    ]);
  });

  it('preserves models_referenced as string array', () => {
    const teachings = parseTeachingFile(fixture);
    const churn = teachings.find(t => t.id === 'churn-definition')!;

    expect(churn.models_referenced).toEqual([
      'analytics.dim_customers',
      'analytics.fct_orders',
    ]);
  });

  it('rejects teaching with missing required field (id)', () => {
    const yaml = `teachings:
  - reasoning: "some reasoning"
    models_referenced:
      - analytics.fct_orders`;

    expect(() => parseTeachingFile(yaml)).toThrow(/id/);
  });

  it('rejects teaching with missing reasoning', () => {
    const yaml = `teachings:
  - id: test
    models_referenced:
      - analytics.fct_orders`;

    expect(() => parseTeachingFile(yaml)).toThrow(/reasoning/);
  });

  it('rejects teaching with missing models_referenced', () => {
    const yaml = `teachings:
  - id: test
    reasoning: "some reasoning"`;

    expect(() => parseTeachingFile(yaml)).toThrow(/models_referenced/);
  });
});
