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

const OPTS = { maxRows: 100, timeoutMs: 30000, maxBytes: 10_000_000_000 };
const rowsOf = (n: number, from = 0) => Array.from({ length: n }, (_, i) => ({ id: from + i }));

/**
 * The SDK resolves `job.getQueryResults({ maxResults })` as one API page:
 * `[rows, nextQuery, response]`, where `response.totalRows` is the result's
 * total and `nextQuery` (with a `pageToken`) is set only when rows remain.
 */
function page(rows: unknown[], totalRows: string | undefined, pageToken?: string, extra: Record<string, unknown> = {}) {
  const response: Record<string, unknown> = { jobComplete: true, ...extra };
  if (totalRows !== undefined) response.totalRows = totalRows;
  const nextQuery = pageToken ? { maxResults: 100, pageToken } : null;
  return [rows, nextQuery, response];
}

describe('executeQuery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    initBigQueryClient('test-project');
    mockCreateQueryJob.mockResolvedValue([{
      getQueryResults: mockGetQueryResults,
      getMetadata: mockGetMetadata,
    }]);
    // Job statistics deliberately carry no row count: the runner must read the
    // count from the results response, not from here.
    mockGetMetadata.mockResolvedValue([{ statistics: { query: {}, totalBytesProcessed: '1000' } }]);
  });

  it('returns rows and metadata on success', async () => {
    const rows = [{ id: '1', name: 'Alice' }, { id: '2', name: 'Bob' }];
    mockGetQueryResults.mockResolvedValueOnce(page(rows, '2'));

    const result = await executeQuery('SELECT id, name FROM users', OPTS);

    expect(result.rows).toEqual(rows);
    expect(result.columnNames).toEqual(['id', 'name']);
    expect(result.totalRows).toBe(2);
    expect(result.bytesProcessed).toBe(1000);
    expect(result.truncated).toBe(false);
    expect(mockGetQueryResults).toHaveBeenCalledTimes(1);
    expect(mockGetQueryResults.mock.calls[0][0].maxResults).toBe(100);
  });

  it('a complete result of exactly the cap is not truncated (#38)', async () => {
    mockGetQueryResults.mockResolvedValueOnce(page(rowsOf(100), '100'));

    const result = await executeQuery('SELECT id FROM t', OPTS);

    expect(result.rows).toHaveLength(100);
    expect(result.totalRows).toBe(100);
    expect(result.truncated).toBe(false);
  });

  it('reports the full total when the result exceeds the cap (#38)', async () => {
    mockGetQueryResults.mockResolvedValueOnce(page(rowsOf(100), '150', 'tok-2'));

    const result = await executeQuery('SELECT id FROM t', OPTS);

    expect(result.rows).toHaveLength(100);
    expect(result.totalRows).toBe(150);
    expect(result.truncated).toBe(true);
    expect(mockGetQueryResults).toHaveBeenCalledTimes(1); // cap filled; no extra page
  });

  it('follows a continuation after a short page until the cap is filled (#38)', async () => {
    mockGetQueryResults
      .mockResolvedValueOnce(page(rowsOf(40), '150', 'tok-2'))
      .mockResolvedValueOnce(page(rowsOf(60, 40), '150', 'tok-3'));

    const result = await executeQuery('SELECT id FROM t', OPTS);

    expect(result.rows).toHaveLength(100);
    expect(result.rows[99]).toEqual({ id: 99 });
    expect(result.totalRows).toBe(150);
    expect(result.truncated).toBe(true);
    const second = mockGetQueryResults.mock.calls[1][0];
    expect(second.pageToken).toBe('tok-2');
    expect(second.maxResults).toBe(60);
    expect(second.wrapIntegers).toBeDefined();
  });

  it('follows a continuation to the end of a short-paged complete result (#38)', async () => {
    mockGetQueryResults
      .mockResolvedValueOnce(page(rowsOf(40), '70', 'tok-2'))
      .mockResolvedValueOnce(page(rowsOf(30, 40), '70'));

    const result = await executeQuery('SELECT id FROM t', OPTS);

    expect(result.rows).toHaveLength(70);
    expect(result.totalRows).toBe(70);
    expect(result.truncated).toBe(false);
  });

  it('waits for a job that is still running before reading rows', async () => {
    mockGetQueryResults
      .mockResolvedValueOnce([[], { maxResults: 100 }, { jobComplete: false }])
      .mockResolvedValueOnce(page([{ n: 5 }], '1'));

    const result = await executeQuery('SELECT COUNT(*) AS n FROM t', OPTS);

    expect(result.rows).toEqual([{ n: 5 }]);
    expect(result.totalRows).toBe(1);
    expect(result.truncated).toBe(false);
  });

  it('gives up on a still-running job after the query timeout with a timeout error', async () => {
    mockGetQueryResults.mockResolvedValue([[], { maxResults: 1 }, { jobComplete: false }]);
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValueOnce(0).mockReturnValue(31_000);

    await expect(executeQuery('SELECT 1', OPTS)).rejects.toThrow(/timeout/);
    expect(mockGetQueryResults).toHaveBeenCalledTimes(1);
    now.mockRestore();
  });

  it('counts returned rows for an uncapped one-row aggregate without a reported total', async () => {
    // Regression: a 1-row COUNT(...) must not be mistaken for an empty result
    // when no total is reported, or chooseFormat renders it as "no results".
    const rows = [{ unique_visitors: 1000 }];
    mockGetQueryResults.mockResolvedValueOnce(page(rows, undefined));

    const result = await executeQuery('SELECT COUNT(DISTINCT client_key) AS unique_visitors FROM t', OPTS);

    expect(result.rows).toEqual(rows);
    expect(result.totalRows).toBe(1);
    expect(result.columnNames).toEqual(['unique_visitors']);
    expect(result.truncated).toBe(false);
  });

  it('without a reported total, a remaining page token marks the result truncated', async () => {
    mockGetQueryResults.mockResolvedValueOnce(page(rowsOf(100), undefined, 'tok-2'));

    const result = await executeQuery('SELECT id FROM t', OPTS);

    expect(result.totalRows).toBe(100);
    expect(result.truncated).toBe(true);
  });

  it('returns empty result gracefully', async () => {
    mockGetQueryResults.mockResolvedValueOnce(page([], '0'));

    const result = await executeQuery('SELECT * FROM users WHERE 1=0', OPTS);

    expect(result.rows).toEqual([]);
    expect(result.totalRows).toBe(0);
    expect(result.columnNames).toEqual([]);
    expect(result.truncated).toBe(false);
  });

  it('takes empty-result column names from the response schema', async () => {
    mockGetQueryResults.mockResolvedValueOnce(page([], '0', undefined, {
      schema: { fields: [{ name: 'order_id' }, { name: 'total' }] },
    }));

    const result = await executeQuery('SELECT order_id, total FROM t WHERE FALSE', OPTS);

    expect(result.columnNames).toEqual(['order_id', 'total']);
  });

  it('falls back to job statistics schema for empty-result column names', async () => {
    mockGetQueryResults.mockResolvedValueOnce(page([], '0'));
    mockGetMetadata.mockResolvedValueOnce([{ statistics: {
      totalBytesProcessed: '1000', query: { schema: { fields: [{ name: 'day' }] } },
    } }]);

    const result = await executeQuery('SELECT day FROM t WHERE FALSE', OPTS);

    expect(result.columnNames).toEqual(['day']);
  });

  it('returns no empty-result column names when a schema field is unnamed', async () => {
    mockGetQueryResults.mockResolvedValueOnce(page([], '0', undefined, {
      schema: { fields: [{ name: 'a' }, {}] },
    }));

    const result = await executeQuery('SELECT 1 WHERE FALSE', OPTS);

    expect(result.columnNames).toEqual([]);
  });

  it('fills columnTypes from the results schema', async () => {
    mockGetQueryResults.mockResolvedValueOnce(page([{ ch: 'a', n: 1 }], '1', undefined, {
      schema: { fields: [{ name: 'ch', type: 'STRING' }, { name: 'n', type: 'INT64' }] },
    }));

    const result = await executeQuery('SELECT ch, n FROM t', OPTS);

    expect(result.columnTypes).toEqual(['STRING', 'INT64']);
  });

  it('marks REPEATED fields with []', async () => {
    mockGetQueryResults.mockResolvedValueOnce(page([{ tags: ['x'] }], '1', undefined, {
      schema: { fields: [{ name: 'tags', type: 'STRING', mode: 'REPEATED' }] },
    }));

    const result = await executeQuery('SELECT tags FROM t', OPTS);

    expect(result.columnTypes).toEqual(['STRING[]']);
  });

  it('omits columnTypes when schema names do not match columnNames in order', async () => {
    mockGetQueryResults.mockResolvedValueOnce(page([{ a: 1, b: 2 }], '1', undefined, {
      schema: { fields: [{ name: 'b', type: 'INT64' }, { name: 'a', type: 'INT64' }] },
    }));

    const result = await executeQuery('SELECT a, b FROM t', OPTS);

    expect(result.columnTypes).toBeUndefined();
    expect('columnTypes' in result).toBe(false);
  });
});
