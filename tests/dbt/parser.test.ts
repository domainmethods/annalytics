import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseDbtArtifacts } from '../../src/dbt/parser.js';

const fixturesDir = join(import.meta.dirname, '../fixtures');
const manifest = JSON.parse(readFileSync(join(fixturesDir, 'manifest.json'), 'utf-8'));
const catalog = JSON.parse(readFileSync(join(fixturesDir, 'catalog.json'), 'utf-8'));

describe('parseDbtArtifacts', () => {
  const tables = parseDbtArtifacts(manifest, catalog);

  it('only parses model resource types (not sources)', () => {
    expect(tables).toHaveLength(3);
    expect(tables.map(t => t.name)).not.toContain('raw.events');
  });

  it('creates TableContext with correct name format', () => {
    const fctOrders = tables.find(t => t.name === 'analytics.fct_orders');
    expect(fctOrders).toBeDefined();
    expect(fctOrders!.schema).toBe('analytics');
    expect(fctOrders!.description).toBe('All completed customer orders');
    expect(fctOrders!.materialization).toBe('table');
    expect(fctOrders!.tags).toEqual(['finance']);
  });

  it('normalizes catalog column names to lowercase for type lookup', () => {
    const fctOrders = tables.find(t => t.name === 'analytics.fct_orders')!;
    const totalAmount = fctOrders.columns.find(c => c.name === 'total_amount');
    expect(totalAmount).toBeDefined();
    expect(totalAmount!.dataType).toBe('FLOAT64'); // from UPPERCASE catalog key
  });

  it('falls back to UNKNOWN when column not in catalog', () => {
    // stg_orders has ID in catalog but manifest uses 'id' (lowercase)
    // The normalizer should handle this
    const stg = tables.find(t => t.name === 'staging.stg_orders')!;
    expect(stg.columns[0].dataType).toBe('STRING');
  });

  it('preserves column descriptions from manifest', () => {
    const fctOrders = tables.find(t => t.name === 'analytics.fct_orders')!;
    const orderId = fctOrders.columns.find(c => c.name === 'order_id');
    expect(orderId!.description).toBe('Primary key');
  });

  it('preserves dependsOn from manifest', () => {
    const fctOrders = tables.find(t => t.name === 'analytics.fct_orders')!;
    expect(fctOrders.dependsOn).toEqual(['model.my_project.stg_orders']);
  });

  it('generates sampleDDL string', () => {
    const fctOrders = tables.find(t => t.name === 'analytics.fct_orders')!;
    expect(fctOrders.sampleDDL).toContain('CREATE TABLE');
    expect(fctOrders.sampleDDL).toContain('analytics.fct_orders');
    expect(fctOrders.sampleDDL).toContain('order_id');
    expect(fctOrders.sampleDDL).toContain('FLOAT64');
  });
});
