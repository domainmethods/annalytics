import { expect, it, vi } from 'vitest';
import { parseDbtArtifacts } from '../../src/dbt/parser.js';
import { fetchSampleRows } from '../../src/dbt/sampleRows.js';

it('advertises and samples the physical cross-project alias, excluding ephemeral dependencies', async () => {
  const tables = parseDbtArtifacts({ nodes: {
    'model.demo.internal': { resource_type: 'model', name: 'internal', schema: 'analytics', config: { materialized: 'ephemeral' } },
    'model.demo.orders': { resource_type: 'model', name: 'orders', database: 'synthetic-project', schema: 'analytics', alias: 'orders_clean', depends_on: { nodes: ['model.demo.internal'] } },
  } }, { nodes: {} });
  expect(tables).toHaveLength(1);
  expect(tables[0].name).toBe('synthetic-project.analytics.orders_clean');
  expect(tables[0].sampleDDL).toContain('`synthetic-project.analytics.orders_clean`');
  expect(tables[0].dependsOn).toEqual(['model.demo.internal']);
  const query = vi.fn().mockResolvedValue([[]]);
  const result = await fetchSampleRows({ query } as any, tables[0]);
  expect(query.mock.calls[0][0].query).toContain('`synthetic-project.analytics.orders_clean`');
  expect(result.tableName).toBe(tables[0].name);
});

it('uses relation_name when physical components are absent', () => {
  const [table] = parseDbtArtifacts({ nodes: { x: { resource_type: 'model', name: 'logical', relation_name: '`synthetic-project.analytics.physical`' } } }, {});
  expect(table.name).toBe('synthetic-project.analytics.physical');
});
