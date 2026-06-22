import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TableContext } from '../../src/dbt/types.js';

const {
  mockQuery,
  mockGetBigQueryClient,
  mockGetCachedSchema,
  mockCacheSchema,
} = vi.hoisted(() => {
  const mockQuery = vi.fn();
  const mockGetBigQueryClient = vi.fn(() => ({ query: mockQuery }));
  const mockGetCachedSchema = vi.fn();
  const mockCacheSchema = vi.fn();
  return { mockQuery, mockGetBigQueryClient, mockGetCachedSchema, mockCacheSchema };
});

vi.mock('../../src/execution/runner.js', () => ({
  getBigQueryClient: mockGetBigQueryClient,
}));

vi.mock('../../src/state/informationSchemaCache.js', () => ({
  getCachedSchema: mockGetCachedSchema,
  cacheSchema: mockCacheSchema,
}));

import { getSchemaFallback } from '../../src/dbt/informationSchemaFallback.js';

describe('getSchemaFallback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetBigQueryClient.mockReturnValue({ query: mockQuery });
    mockGetCachedSchema.mockResolvedValue(null);
    mockCacheSchema.mockResolvedValue(undefined);
  });

  it('returns cached TableContext on cache hit', async () => {
    const cached: TableContext = {
      name: 'raw_dataset.raw_events',
      schema: 'raw_dataset',
      description: '',
      materialization: 'unknown',
      columns: [
        { name: 'event_id', dataType: 'STRING', description: '', meta: {} },
      ],
      sampleDDL: 'CREATE TABLE `raw_dataset.raw_events` (\n  event_id STRING\n);',
      dependsOn: [],
      tags: ['no-dbt-metadata'],
    };
    mockGetCachedSchema.mockResolvedValue(cached);

    const result = await getSchemaFallback('my-project', 'raw_dataset', 'raw_events');

    expect(result).toEqual(cached);
    expect(mockGetCachedSchema).toHaveBeenCalledWith('my-project.raw_dataset.raw_events');
    // BigQuery should not be queried on cache hit
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockCacheSchema).not.toHaveBeenCalled();
  });

  it('queries BigQuery on cache miss, builds TableContext, and caches result', async () => {
    mockGetCachedSchema.mockResolvedValue(null);
    mockQuery.mockResolvedValue([
      [
        { column_name: 'event_id', data_type: 'STRING', description: 'Unique event identifier' },
        { column_name: 'created_at', data_type: 'TIMESTAMP', description: null },
        { column_name: 'amount', data_type: 'FLOAT64', description: '' },
      ],
    ]);

    const result = await getSchemaFallback('my-project', 'raw_dataset', 'raw_events');

    expect(result).not.toBeNull();
    expect(result!.name).toBe('raw_dataset.raw_events');
    expect(result!.schema).toBe('raw_dataset');
    expect(result!.description).toBe('');
    expect(result!.materialization).toBe('unknown');
    expect(result!.dependsOn).toEqual([]);
    expect(result!.tags).toEqual(['no-dbt-metadata']);
    expect(result!.columns).toEqual([
      { name: 'event_id', dataType: 'STRING', description: 'Unique event identifier', meta: {} },
      { name: 'created_at', dataType: 'TIMESTAMP', description: '', meta: {} },
      { name: 'amount', dataType: 'FLOAT64', description: '', meta: {} },
    ]);
    expect(result!.sampleDDL).toContain('CREATE TABLE `raw_dataset.raw_events`');
    expect(result!.sampleDDL).toContain('event_id STRING -- Unique event identifier');
    expect(result!.sampleDDL).toContain('created_at TIMESTAMP');
    expect(result!.sampleDDL).toContain('amount FLOAT64');

    // Verify parameterized query
    expect(mockQuery).toHaveBeenCalledWith({
      query: expect.stringContaining('INFORMATION_SCHEMA.COLUMN_FIELD_PATHS'),
      params: { tableName: 'raw_events' },
    });

    // Verify caching
    expect(mockCacheSchema).toHaveBeenCalledWith('my-project.raw_dataset.raw_events', result);
  });

  it('returns null on BigQuery error', async () => {
    mockGetCachedSchema.mockResolvedValue(null);
    mockQuery.mockRejectedValue(new Error('Table not found'));

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await getSchemaFallback('my-project', 'raw_dataset', 'raw_events');

    expect(result).toBeNull();
    expect(consoleSpy).toHaveBeenCalled();
    expect(mockCacheSchema).not.toHaveBeenCalled();

    consoleSpy.mockRestore();
  });

  it('builds correct TableContext shape from I_S columns', async () => {
    mockGetCachedSchema.mockResolvedValue(null);
    mockQuery.mockResolvedValue([
      [
        { column_name: 'user_id', data_type: 'INT64', description: 'User primary key' },
        { column_name: 'email', data_type: 'STRING', description: 'User email address' },
        { column_name: 'metadata', data_type: 'RECORD', description: 'Nested metadata' },
      ],
    ]);

    const result = await getSchemaFallback('my-project', 'analytics', 'dim_users');

    expect(result).not.toBeNull();

    // Verify column mapping
    expect(result!.columns).toHaveLength(3);
    expect(result!.columns[0]).toEqual({
      name: 'user_id',
      dataType: 'INT64',
      description: 'User primary key',
      meta: {},
    });
    expect(result!.columns[1]).toEqual({
      name: 'email',
      dataType: 'STRING',
      description: 'User email address',
      meta: {},
    });
    expect(result!.columns[2]).toEqual({
      name: 'metadata',
      dataType: 'RECORD',
      description: 'Nested metadata',
      meta: {},
    });

    // Verify tags
    expect(result!.tags).toEqual(['no-dbt-metadata']);

    // Verify materialization
    expect(result!.materialization).toBe('unknown');

    // Verify DDL format matches parser.ts pattern
    const expectedDDL = [
      'CREATE TABLE `analytics.dim_users` (',
      '  user_id INT64 -- User primary key,',
      '  email STRING -- User email address,',
      '  metadata RECORD -- Nested metadata',
      ');',
    ].join('\n');
    expect(result!.sampleDDL).toBe(expectedDDL);
  });

  it('returns null for invalid tableId (injection prevention)', async () => {
    const result = await getSchemaFallback('my-project', 'raw_dataset', 'table; DROP TABLE users');

    expect(result).toBeNull();
    expect(mockGetCachedSchema).not.toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
  });
});
