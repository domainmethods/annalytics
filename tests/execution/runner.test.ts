import { describe, it, expect, vi, beforeEach } from 'vitest';
import { executeQuery, initBigQueryClient } from '../../src/execution/runner.js';

const mockGetQueryResults = vi.fn();
const mockGetMetadata = vi.fn();
const mockCreateQueryJob = vi.fn();

vi.mock('@google-cloud/bigquery', () => ({
  BigQuery: class {
    createQueryJob = mockCreateQueryJob;
  },
}));

describe('executeQuery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    initBigQueryClient('test-project');
  });

  it('returns rows and metadata on success', async () => {
    const rows = [
      { id: '1', name: 'Alice' },
      { id: '2', name: 'Bob' },
    ];
    mockCreateQueryJob.mockResolvedValue([{
      getQueryResults: mockGetQueryResults,
      getMetadata: mockGetMetadata,
    }]);
    mockGetQueryResults.mockResolvedValue([rows]);
    mockGetMetadata.mockResolvedValue([{
      statistics: {
        query: { totalRows: '2' },
        totalBytesProcessed: '1000',
      },
    }]);

    const result = await executeQuery('SELECT id, name FROM users', {
      maxRows: 1000,
      timeoutMs: 30000,
      maxBytes: 10_000_000_000,
    });

    expect(result.rows).toEqual(rows);
    expect(result.columnNames).toEqual(['id', 'name']);
    expect(result.totalRows).toBe(2);
    expect(result.truncated).toBe(false);
  });

  it('detects truncated results when totalRows > maxRows', async () => {
    const rows = Array.from({ length: 1000 }, (_, i) => ({ id: String(i) }));
    mockCreateQueryJob.mockResolvedValue([{
      getQueryResults: mockGetQueryResults,
      getMetadata: mockGetMetadata,
    }]);
    mockGetQueryResults.mockResolvedValue([rows]);
    mockGetMetadata.mockResolvedValue([{
      statistics: {
        query: { totalRows: '50000' },
        totalBytesProcessed: '5000000',
      },
    }]);

    const result = await executeQuery('SELECT id FROM big_table', {
      maxRows: 1000,
      timeoutMs: 30000,
      maxBytes: 10_000_000_000,
    });

    expect(result.rows).toHaveLength(1000);
    expect(result.totalRows).toBe(50000);
    expect(result.truncated).toBe(true);
  });

  it('counts returned rows when statistics.query.totalRows is absent (aggregate jobs)', async () => {
    // Regression: BigQuery leaves statistics.query.totalRows undefined for some
    // completed aggregate jobs. A 1-row COUNT(...) must not be mistaken for an
    // empty result — totalRows is derived from the materialized rows, not the
    // missing stat. Otherwise chooseFormat renders a real answer as "no results".
    const rows = [{ unique_visitors: 1000 }];
    mockCreateQueryJob.mockResolvedValue([{
      getQueryResults: mockGetQueryResults,
      getMetadata: mockGetMetadata,
    }]);
    mockGetQueryResults.mockResolvedValue([rows]);
    mockGetMetadata.mockResolvedValue([{
      statistics: {
        query: {}, // totalRows undefined
        totalBytesProcessed: '2048',
      },
    }]);

    const result = await executeQuery('SELECT COUNT(DISTINCT client_key) AS unique_visitors FROM t', {
      maxRows: 1000,
      timeoutMs: 30000,
      maxBytes: 10_000_000_000,
    });

    expect(result.rows).toEqual(rows);
    expect(result.totalRows).toBe(1);
    expect(result.columnNames).toEqual(['unique_visitors']);
    expect(result.truncated).toBe(false);
  });

  it('returns empty result gracefully', async () => {
    mockCreateQueryJob.mockResolvedValue([{
      getQueryResults: mockGetQueryResults,
      getMetadata: mockGetMetadata,
    }]);
    mockGetQueryResults.mockResolvedValue([[]]);
    mockGetMetadata.mockResolvedValue([{
      statistics: {
        query: { totalRows: '0' },
        totalBytesProcessed: '500',
      },
    }]);

    const result = await executeQuery('SELECT * FROM users WHERE 1=0', {
      maxRows: 1000,
      timeoutMs: 30000,
      maxBytes: 10_000_000_000,
    });

    expect(result.rows).toEqual([]);
    expect(result.totalRows).toBe(0);
    expect(result.columnNames).toEqual([]);
    expect(result.truncated).toBe(false);
  });
});
