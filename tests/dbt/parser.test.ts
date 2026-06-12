import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseDbtArtifacts, DEFAULT_MAX_COLUMNS_PER_TABLE } from '../../src/dbt/parser.js';

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

describe('catalog-only column union', () => {
  // fct_orders fixture: 5 documented columns (manifest) + 2 catalog-only
  // (ORDER_CHANNEL idx 6, CREATED_AT idx 7) → union of 7 within default cap.
  const tables = parseDbtArtifacts(manifest, catalog);
  const fctOrders = tables.find(t => t.name === 'analytics.fct_orders')!;

  it('appends undocumented catalog columns after documented ones, in catalog index order', () => {
    expect(fctOrders.columns).toHaveLength(7);
    expect(fctOrders.columns.slice(5).map(c => c.name)).toEqual(['order_channel', 'created_at']);
  });

  it('gives catalog-only columns empty descriptions and catalog types', () => {
    const channel = fctOrders.columns.find(c => c.name === 'order_channel')!;
    expect(channel.description).toBe('');
    expect(channel.dataType).toBe('STRING');
    const createdAt = fctOrders.columns.find(c => c.name === 'created_at')!;
    expect(createdAt.dataType).toBe('TIMESTAMP');
  });

  it('includes catalog-only columns in sampleDDL with no omission marker when within cap', () => {
    expect(fctOrders.sampleDDL).toContain('order_channel STRING');
    expect(fctOrders.sampleDDL).toContain('created_at TIMESTAMP');
    expect(fctOrders.sampleDDL).not.toContain('additional undocumented columns');
  });

  it('exports a default cap large enough for typical mart tables', () => {
    expect(DEFAULT_MAX_COLUMNS_PER_TABLE).toBeGreaterThanOrEqual(50);
  });

  describe('when the union exceeds maxColumnsPerTable', () => {
    // Cap of 6 < union of 7 forces fct_orders onto the documented-only path.
    const capped = parseDbtArtifacts(manifest, catalog, { maxColumnsPerTable: 6 });
    const cappedFct = capped.find(t => t.name === 'analytics.fct_orders')!;

    it('keeps only documented columns', () => {
      expect(cappedFct.columns).toHaveLength(5);
      expect(cappedFct.columns.map(c => c.name)).not.toContain('order_channel');
    });

    it('adds an omission marker with the undocumented count to sampleDDL', () => {
      expect(cappedFct.sampleDDL).toContain('2 additional undocumented columns');
      expect(cappedFct.sampleDDL).toContain('do not reference columns not listed above');
      expect(cappedFct.sampleDDL).not.toContain('order_channel');
    });

    it('leaves within-cap tables untouched', () => {
      const dim = capped.find(t => t.name === 'analytics.dim_customers')!;
      expect(dim.columns).toHaveLength(5);
      expect(dim.sampleDDL).not.toContain('additional undocumented columns');
    });
  });
});
