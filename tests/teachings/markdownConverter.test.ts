import { describe, it, expect } from 'vitest';
import { teachingToMarkdown } from '../../src/teachings/markdownConverter.js';
import type { Teaching } from '../../src/teachings/types.js';

const sqlTeaching: Teaching = {
  id: 'revenue-monthly',
  question_patterns: ['monthly revenue', 'revenue by month', 'MRR'],
  sanctioned_sql: `SELECT
  DATE_TRUNC(order_date, MONTH) AS month,
  SUM(total_amount) AS revenue
FROM \`analytics.fct_orders\`
WHERE order_status = 'completed'
GROUP BY 1
ORDER BY 1 DESC`,
  reasoning: 'Revenue always uses fct_orders with order_status = \'completed\'.\nNever include cancelled or refunded orders.',
  models_referenced: ['analytics.fct_orders'],
  tags: ['revenue', 'finance'],
  author: 'jane@company.com',
  updated: '2026-02-10',
};

const reasoningOnlyTeaching: Teaching = {
  id: 'churn-definition',
  question_patterns: ['churn', 'churned customers'],
  sanctioned_sql: null,
  reasoning: 'A customer is considered "churned" if they have had no completed orders in the last 90 days.',
  models_referenced: ['analytics.dim_customers', 'analytics.fct_orders'],
  tags: ['churn', 'customers'],
  author: 'jane@company.com',
  updated: '2026-02-10',
};

describe('teachingToMarkdown', () => {
  it('converts teaching with sanctioned SQL to markdown with all sections', () => {
    const md = teachingToMarkdown(sqlTeaching);

    expect(md).toContain('# Teaching: revenue-monthly');
    expect(md).toContain('## Question Patterns');
    expect(md).toContain('## Sanctioned SQL');
    expect(md).toContain('## Reasoning');
    expect(md).toContain('SUM(total_amount)');
  });

  it('converts reasoning-only teaching (no SQL section)', () => {
    const md = teachingToMarkdown(reasoningOnlyTeaching);

    expect(md).toContain('# Teaching: churn-definition');
    expect(md).toContain('## Reasoning');
    expect(md).not.toContain('## Sanctioned SQL');
  });

  it('includes tags and models in header line', () => {
    const md = teachingToMarkdown(sqlTeaching);

    expect(md).toContain('Tags: revenue, finance');
    expect(md).toContain('Models: analytics.fct_orders');
  });

  it('includes all question patterns', () => {
    const md = teachingToMarkdown(sqlTeaching);

    expect(md).toContain('- monthly revenue');
    expect(md).toContain('- revenue by month');
    expect(md).toContain('- MRR');
  });

  it('output is under 1600 chars for a typical teaching', () => {
    const md = teachingToMarkdown(sqlTeaching);

    expect(md.length).toBeLessThan(1600);
  });
});
