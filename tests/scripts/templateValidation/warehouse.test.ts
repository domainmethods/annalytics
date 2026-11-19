import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { parseDbtArtifacts } from '../../../src/dbt/parser.js';
import { loadLocalKnowledgeSummaries } from '../../../scripts/benchmarkInputs.js';
import { buildArtifacts, checkSchemaDrift, TV_ROOT, TV_TABLES, viewDdl } from '../../../scripts/template-validation/warehouse.js';

describe('warehouse schema drift', () => {
  const modelsYaml = JSON.stringify({
    models: TV_TABLES.map((name) => ({ name, columns: [{ name: 'id' }, { name: 'created_at' }] })),
  });
  const liveColumns = TV_TABLES.flatMap((table) => [
    { table, column: 'id', dataType: 'INT64' },
    { table, column: 'created_at', dataType: 'TIMESTAMP' },
  ]);

  it('reports no drift when all documented columns match the live views', () => {
    expect(checkSchemaDrift(modelsYaml, liveColumns)).toEqual([]);
  });

  it('lists each documented column absent from live metadata', () => {
    const columns = liveColumns.filter(({ table, column }) =>
      column !== 'created_at' || (table !== 'orders' && table !== 'order_items'),
    );
    expect(checkSchemaDrift(modelsYaml, columns)).toEqual([
      'Missing live column: orders.created_at',
      'Missing live column: order_items.created_at',
    ]);
  });

  it('lists each live column missing from YAML', () => {
    const columns = [...liveColumns, { table: 'order_items', column: 'sale_price', dataType: 'FLOAT64' }];
    expect(checkSchemaDrift(modelsYaml, columns)).toEqual(['Undocumented live column: order_items.sale_price']);
  });

  it('names an expected view with no live rows and lists its missing columns', () => {
    const columns = liveColumns.filter(({ table }) => table !== 'events');
    expect(checkSchemaDrift(modelsYaml, columns)).toEqual(expect.arrayContaining([
      'Missing live view: events',
      'Missing live column: events.id',
      'Missing live column: events.created_at',
    ]));
  });
});

describe('template validation warehouse', () => {
  it('round-trips generated artifacts through parseDbtArtifacts', () => {
    const tableNames = ['orders', 'order_items', 'users', 'products', 'inventory_items', 'events', 'distribution_centers'];
    const modelsYaml = [
      'version: 2',
      'models:',
      ...tableNames.flatMap((table) => [
        `  - name: ${table}`,
        '    schema: tv_thelook',
        `    description: Description of ${table}`,
        '    columns:',
        '      - name: id',
        '        description: Row identifier',
      ]),
    ].join('\n');
    const columns = tableNames.map((table) => ({ table, column: 'id', dataType: 'INT64' }));
    columns.push({ table: 'orders', column: 'created_at', dataType: 'TIMESTAMP' });
    const { manifest, catalog } = buildArtifacts(modelsYaml, columns);
    const onWarnings = vi.fn();

    const tables = parseDbtArtifacts(manifest, catalog, { onWarnings });

    expect(onWarnings).not.toHaveBeenCalled();
    expect(tables.map((table) => table.name)).toEqual(tableNames.map((table) => `tv_thelook.${table}`));
    for (const [index, table] of tables.entries()) {
      expect(table.description).toBe(`Description of ${tableNames[index]}`);
      expect(table.columns).toContainEqual(expect.objectContaining({
        name: 'id', description: 'Row identifier', dataType: 'INT64',
      }));
      expect(table.materialization).toBe('view');
    }
    expect(tables[0].columns).toContainEqual(expect.objectContaining({ name: 'created_at', dataType: 'TIMESTAMP' }));
  });

  it('targets the public dataset from a view in the operator project', () => {
    expect(viewDdl('p', 'orders')).toBe(
      'CREATE OR REPLACE VIEW `p.tv_thelook.orders` AS SELECT * FROM `bigquery-public-data.thelook_ecommerce.orders`',
    );
  });

  it('loads the synthetic knowledge layer', async () => {
    expect((await loadLocalKnowledgeSummaries(`${TV_ROOT}/knowledge`)).length).toBeGreaterThanOrEqual(5);
  });

  it('ships typed, documented artifacts that match the warehouse model YAML', () => {
    const dbtDir = `${TV_ROOT}/dbt`;
    const manifest = JSON.parse(readFileSync(`${dbtDir}/manifest.json`, 'utf8'));
    const catalog = JSON.parse(readFileSync(`${dbtDir}/catalog.json`, 'utf8')) as {
      nodes: Record<string, { columns: Record<string, { name: string; type: string }> }>;
    };
    const tables = parseDbtArtifacts(manifest, catalog);
    const columns = tables.flatMap((table) => {
      const name = table.name.split('.')[1];
      return Object.values(catalog.nodes[`model.template_validation.${name}`].columns)
        .map((column) => ({ table: name, column: column.name, dataType: column.type }));
    });

    expect(buildArtifacts(readFileSync(`${dbtDir}/models.yml`, 'utf8'), columns)).toEqual({ manifest, catalog });
    expect(tables).toHaveLength(7);
    for (const table of tables) {
      expect(table.description).not.toBe('');
      expect(table.columns.length).toBeGreaterThan(0);
      for (const column of table.columns) {
        expect(column.description, `${table.name}.${column.name}`).not.toBe('');
        expect(column.dataType).not.toBe('UNKNOWN');
      }
    }
  });
});
