import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fetchSampleRows } from '../../src/dbt/sampleRows.js';
import type { TableContext } from '../../src/dbt/types.js';

const mockQuery = vi.fn();
const mockBigQuery = { query: mockQuery } as any;

const table: TableContext = {
  name: 'analytics.fct_orders',
  schema: 'analytics',
  description: 'Orders fact table',
  materialization: 'table',
  columns: [],
  sampleDDL: 'CREATE TABLE ...',
  dependsOn: [],
  tags: [],
};

describe('fetchSampleRows', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fetches 5 rows for a non-partitioned table', async () => {
    const rows = [{ id: 1, amount: 100 }, { id: 2, amount: 200 }];
    mockQuery.mockResolvedValue([rows]);

    const result = await fetchSampleRows(mockBigQuery, table);

    expect(result.tableName).toBe('analytics.fct_orders');
    expect(result.rows).toEqual(rows);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        query: expect.stringContaining('LIMIT 5'),
      }),
    );
    expect(mockQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        query: expect.not.stringContaining('WHERE'),
      }),
    );
  });

  it('fetches with partition filter when partition column is known', async () => {
    mockQuery.mockResolvedValue([[{ id: 1 }]]);

    await fetchSampleRows(mockBigQuery, table, 'order_date');

    expect(mockQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        query: expect.stringContaining('WHERE order_date >= DATE_SUB(CURRENT_DATE(), INTERVAL 7 DAY)'),
      }),
    );
  });

  it('falls back to plain LIMIT 5 when no partition column', async () => {
    mockQuery.mockResolvedValue([[{ id: 1 }]]);

    await fetchSampleRows(mockBigQuery, table);

    const call = mockQuery.mock.calls[0][0];
    expect(call.query).not.toContain('WHERE');
    expect(call.query).toContain('LIMIT 5');
  });

  it('truncates cell values to 500 characters', async () => {
    const longValue = 'x'.repeat(600);
    mockQuery.mockResolvedValue([[{ id: 1, bio: longValue }]]);

    const result = await fetchSampleRows(mockBigQuery, table);

    const bio = result.rows[0].bio as string;
    expect(bio.length).toBeLessThanOrEqual(503); // 500 + '...'
    expect(bio).toContain('...');
  });

  it('returns empty rows array on query error', async () => {
    mockQuery.mockRejectedValue(new Error('Access denied'));

    const result = await fetchSampleRows(mockBigQuery, table);

    expect(result.rows).toEqual([]);
    expect(result.error).toContain('Access denied');
  });
});
