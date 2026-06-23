import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseDbtArtifacts, DEFAULT_MAX_COLUMNS_PER_TABLE } from '../../src/dbt/parser.js';

const fixturesDir = join(import.meta.dirname, '../fixtures');
const manifest = JSON.parse(readFileSync(join(fixturesDir, 'manifest.json'), 'utf-8'));
const catalog = JSON.parse(readFileSync(join(fixturesDir, 'catalog.json'), 'utf-8'));

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

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

describe('artifact boundary guards', () => {
  const clearParserError = 'dbt manifest has no nodes key - wrong or malformed manifest.json';
  const manifestWithOneModel = {
    metadata: { dbt_schema_version: 'https://schemas.getdbt.com/dbt/manifest/v11.json' },
    nodes: {
      'model.my_project.partial_model': {
        resource_type: 'model',
        name: 'partial_model',
        schema: 'analytics',
        description: 'Partial model',
        columns: undefined as Record<string, { name: string; description?: string }> | undefined,
        config: { materialized: 'table' },
        depends_on: { nodes: [] },
        tags: [],
      },
    },
  };
  const catalogWithOneColumn = {
    metadata: { dbt_schema_version: 'https://schemas.getdbt.com/dbt/catalog/v1.json' },
    nodes: {
      'model.my_project.partial_model': {
        columns: {
          ID: { type: 'STRING', index: 1 },
        },
      },
    },
  };

  it('throws a clear parser error when manifest nodes are missing', () => {
    expect(() => parseDbtArtifacts({} as Parameters<typeof parseDbtArtifacts>[0], catalog)).toThrow(
      clearParserError,
    );
  });

  it('throws a clear parser error when manifest nodes are null', () => {
    expect(() =>
      parseDbtArtifacts({ nodes: null } as unknown as Parameters<typeof parseDbtArtifacts>[0], catalog),
    ).toThrow(clearParserError);
  });

  it('throws a clear parser error when manifest nodes are an array', () => {
    expect(() =>
      parseDbtArtifacts({ nodes: [] } as unknown as Parameters<typeof parseDbtArtifacts>[0], catalog),
    ).toThrow(clearParserError);
  });

  it('throws a clear parser error when manifest nodes are not an object', () => {
    expect(() =>
      parseDbtArtifacts({ nodes: 'not-a-node-map' } as unknown as Parameters<typeof parseDbtArtifacts>[0], catalog),
    ).toThrow(clearParserError);
  });

  it('degrades gracefully when catalog nodes are missing', () => {
    const manifestWithColumns = cloneJson(manifestWithOneModel);
    manifestWithColumns.nodes['model.my_project.partial_model'].columns = {
      id: { name: 'id', description: 'Primary key' },
    };

    const result = parseDbtArtifacts(
      manifestWithColumns as unknown as Parameters<typeof parseDbtArtifacts>[0],
      {} as unknown as Parameters<typeof parseDbtArtifacts>[1],
    );

    expect(result).toHaveLength(1);
    expect(result[0].columns).toEqual([
      {
        name: 'id',
        description: 'Primary key',
        dataType: 'UNKNOWN',
        meta: {},
      },
    ]);
    expect(result[0].sampleDDL).toContain('id UNKNOWN -- Primary key');
  });

  it('degrades gracefully when catalog nodes are null', () => {
    const manifestWithColumns = cloneJson(manifestWithOneModel);
    manifestWithColumns.nodes['model.my_project.partial_model'].columns = {
      id: { name: 'id', description: 'Primary key' },
    };

    const result = parseDbtArtifacts(
      manifestWithColumns as unknown as Parameters<typeof parseDbtArtifacts>[0],
      { nodes: null } as unknown as Parameters<typeof parseDbtArtifacts>[1],
    );

    expect(result).toHaveLength(1);
    expect(result[0].columns).toEqual([
      {
        name: 'id',
        description: 'Primary key',
        dataType: 'UNKNOWN',
        meta: {},
      },
    ]);
    expect(result[0].sampleDDL).toContain('id UNKNOWN -- Primary key');
  });

  it('emits catalog-only columns when manifest model columns are missing', () => {
    const result = parseDbtArtifacts(
      manifestWithOneModel as unknown as Parameters<typeof parseDbtArtifacts>[0],
      catalogWithOneColumn as unknown as Parameters<typeof parseDbtArtifacts>[1],
    );

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('analytics.partial_model');
    expect(result[0].columns).toEqual([
      {
        name: 'id',
        description: '',
        dataType: 'STRING',
        meta: {},
      },
    ]);
    expect(result[0].sampleDDL).toContain('id STRING');
  });

  it('emits catalog-only columns when manifest model columns are wrong-shaped', () => {
    const manifestWithWrongColumns = cloneJson(manifestWithOneModel);
    manifestWithWrongColumns.nodes['model.my_project.partial_model'].columns = [] as unknown as Record<
      string,
      { name: string; description?: string }
    >;

    const result = parseDbtArtifacts(
      manifestWithWrongColumns as unknown as Parameters<typeof parseDbtArtifacts>[0],
      catalogWithOneColumn as unknown as Parameters<typeof parseDbtArtifacts>[1],
    );

    expect(result).toHaveLength(1);
    expect(result[0].columns).toEqual([
      {
        name: 'id',
        description: '',
        dataType: 'STRING',
        meta: {},
      },
    ]);
  });

  it('coerces empty catalog-only column types to UNKNOWN', () => {
    const catalogWithEmptyType = cloneJson(catalogWithOneColumn);
    catalogWithEmptyType.nodes['model.my_project.partial_model'].columns.ID.type = '';

    const result = parseDbtArtifacts(
      manifestWithOneModel as unknown as Parameters<typeof parseDbtArtifacts>[0],
      catalogWithEmptyType as unknown as Parameters<typeof parseDbtArtifacts>[1],
    );

    expect(result[0].columns).toEqual([
      {
        name: 'id',
        description: '',
        dataType: 'UNKNOWN',
        meta: {},
      },
    ]);
    expect(result[0].sampleDDL).toContain('id UNKNOWN');
  });
});

describe('dbt artifact schema-version warnings', () => {
  it('does not warn for current known fixture versions', () => {
    const onWarnings = vi.fn();
    const expected = parseDbtArtifacts(manifest, catalog);

    const result = parseDbtArtifacts(manifest, catalog, { onWarnings });

    expect(result).toEqual(expected);
    expect(onWarnings).not.toHaveBeenCalled();
  });

  it('warns for missing schema-version metadata and still parses', () => {
    const manifestWithoutMetadata = cloneJson(manifest);
    const catalogWithoutMetadata = cloneJson(catalog);
    delete manifestWithoutMetadata.metadata;
    delete catalogWithoutMetadata.metadata;
    const onWarnings = vi.fn();
    const expected = parseDbtArtifacts(manifestWithoutMetadata, catalogWithoutMetadata);

    const result = parseDbtArtifacts(manifestWithoutMetadata, catalogWithoutMetadata, { onWarnings });

    expect(result).toEqual(expected);
    expect(onWarnings).toHaveBeenCalledTimes(1);
    expect(onWarnings).toHaveBeenCalledWith([
      {
        artifact: 'manifest',
        schemaVersion: null,
        reason: 'missing',
        supportedRange: 'v10-v12',
      },
      {
        artifact: 'catalog',
        schemaVersion: null,
        reason: 'missing',
        supportedRange: 'v1',
      },
    ]);
  });

  it('warns for unparseable schema-version metadata and still parses', () => {
    const manifestWithBadVersion = cloneJson(manifest);
    manifestWithBadVersion.metadata.dbt_schema_version = 'manifest-vNext';
    const onWarnings = vi.fn();
    const expected = parseDbtArtifacts(manifestWithBadVersion, catalog);

    const result = parseDbtArtifacts(manifestWithBadVersion, catalog, { onWarnings });

    expect(result).toEqual(expected);
    expect(onWarnings).toHaveBeenCalledTimes(1);
    expect(onWarnings).toHaveBeenCalledWith([
      {
        artifact: 'manifest',
        schemaVersion: 'manifest-vNext',
        reason: 'unparseable',
        supportedRange: 'v10-v12',
      },
    ]);
  });

  it('warns for future unsupported manifest schema versions and still parses', () => {
    const manifestWithFutureVersion = cloneJson(manifest);
    manifestWithFutureVersion.metadata.dbt_schema_version = 'https://schemas.getdbt.com/dbt/manifest/v20.json';
    const onWarnings = vi.fn();
    const expected = parseDbtArtifacts(manifestWithFutureVersion, catalog);

    const result = parseDbtArtifacts(manifestWithFutureVersion, catalog, { onWarnings });

    expect(result).toEqual(expected);
    expect(onWarnings).toHaveBeenCalledTimes(1);
    expect(onWarnings).toHaveBeenCalledWith([
      {
        artifact: 'manifest',
        schemaVersion: 'https://schemas.getdbt.com/dbt/manifest/v20.json',
        reason: 'unsupported',
        supportedRange: 'v10-v12',
      },
    ]);
  });

  it('warns for blank schema-version strings as unparseable metadata and still parses', () => {
    const manifestWithBlankVersion = cloneJson(manifest);
    manifestWithBlankVersion.metadata.dbt_schema_version = '';
    const onWarnings = vi.fn();
    const expected = parseDbtArtifacts(manifestWithBlankVersion, catalog);

    const result = parseDbtArtifacts(manifestWithBlankVersion, catalog, { onWarnings });

    expect(result).toEqual(expected);
    expect(onWarnings).toHaveBeenCalledTimes(1);
    expect(onWarnings).toHaveBeenCalledWith([
      {
        artifact: 'manifest',
        schemaVersion: '',
        reason: 'unparseable',
        supportedRange: 'v10-v12',
      },
    ]);
  });

  it('warns for schema-version URLs outside the expected dbt schema host', () => {
    const manifestWithWrongHost = cloneJson(manifest);
    manifestWithWrongHost.metadata.dbt_schema_version = 'https://example.com/dbt/manifest/v11.json';
    const onWarnings = vi.fn();
    const expected = parseDbtArtifacts(manifestWithWrongHost, catalog);

    const result = parseDbtArtifacts(manifestWithWrongHost, catalog, { onWarnings });

    expect(result).toEqual(expected);
    expect(onWarnings).toHaveBeenCalledTimes(1);
    expect(onWarnings).toHaveBeenCalledWith([
      {
        artifact: 'manifest',
        schemaVersion: 'https://example.com/dbt/manifest/v11.json',
        reason: 'unparseable',
        supportedRange: 'v10-v12',
      },
    ]);
  });
});
