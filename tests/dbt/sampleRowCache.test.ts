import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BigQueryDate } from '@google-cloud/bigquery';
import {
  saveSampleRows,
  getSampleRows,
  formatSampleRowsForPrompt,
} from '../../src/dbt/sampleRowCache.js';
import type { SampleRowResult } from '../../src/dbt/sampleRows.js';

const mockSet = vi.fn();
const mockGet = vi.fn();
const mockDoc = vi.fn(() => ({ set: mockSet, get: mockGet }));
const mockCollection = vi.fn(() => ({ doc: mockDoc }));

vi.mock('../../src/state/firestore.js', () => ({
  getDb: vi.fn(() => ({
    collection: mockCollection,
  })),
}));

describe('saveSampleRows', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSet.mockResolvedValue(undefined);
  });

  it('writes to Firestore sample_rows collection with correct key', async () => {
    const result: SampleRowResult = {
      tableName: 'analytics.fct_orders',
      rows: [{ id: 1, amount: 100 }],
    };

    await saveSampleRows(result);

    expect(mockCollection).toHaveBeenCalledWith('sample_rows');
    expect(mockDoc).toHaveBeenCalledWith('analytics.fct_orders');
    expect(mockSet).toHaveBeenCalledWith(
      expect.objectContaining({
        rows: [{ id: 1, amount: 100 }],
        fetchedAt: expect.any(Date),
      }),
    );
  });

  it('serializes BigQuery SDK date wrappers before writing rows to Firestore', async () => {
    const result: SampleRowResult = {
      tableName: 'analytics.sessions',
      rows: [{ session_partition_date: new BigQueryDate('2026-06-21') }],
    };

    await saveSampleRows(result);

    expect(mockSet).toHaveBeenCalledWith(
      expect.objectContaining({
        rows: [{ session_partition_date: '2026-06-21' }],
      }),
    );
  });
});

describe('getSampleRows', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('retrieves cached rows for a table', async () => {
    const fetchedAt = new Date(Date.now() - 1000 * 60 * 60); // 1 hour ago (within 7-day threshold)
    mockGet.mockResolvedValue({
      exists: true,
      data: () => ({
        rows: [{ id: 1 }],
        fetchedAt: { toDate: () => fetchedAt },
      }),
    });

    const result = await getSampleRows('analytics.fct_orders');

    expect(result).not.toBeNull();
    expect(result!.rows).toEqual([{ id: 1 }]);
    expect(result!.stale).toBe(false);
  });

  it('returns null for missing table', async () => {
    mockGet.mockResolvedValue({ exists: false });

    const result = await getSampleRows('analytics.missing_table');

    expect(result).toBeNull();
  });

  it('returns stale=true for rows older than 7 days', async () => {
    const oldDate = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    mockGet.mockResolvedValue({
      exists: true,
      data: () => ({
        rows: [{ id: 1 }],
        fetchedAt: { toDate: () => oldDate },
      }),
    });

    const result = await getSampleRows('analytics.fct_orders');

    expect(result!.stale).toBe(true);
  });

  it('returns stale=true when fetchedAt is missing', async () => {
    mockGet.mockResolvedValue({
      exists: true,
      data: () => ({ rows: [{ id: 1 }] }),
    });

    const result = await getSampleRows('analytics.fct_orders');

    expect(result).not.toBeNull();
    expect(result!.stale).toBe(true);
  });
});

describe('formatSampleRowsForPrompt', () => {
  it('produces a readable text block with column headers and values', () => {
    const rows = [
      { id: 1, name: 'Alice', amount: 100 },
      { id: 2, name: 'Bob', amount: 200 },
    ];

    const output = formatSampleRowsForPrompt('analytics.fct_orders', rows, false);

    expect(output).toContain('SAMPLE DATA for analytics.fct_orders');
    expect(output).toContain('id | name | amount');
    expect(output).toContain('1 | Alice | 100');
    expect(output).toContain('2 | Bob | 200');
    expect(output).not.toContain('outdated');
  });

  it('includes stale warning when data is stale', () => {
    const rows = [{ id: 1 }];

    const output = formatSampleRowsForPrompt('analytics.fct_orders', rows, true);

    expect(output).toContain('outdated');
  });

  it('returns empty string for no rows', () => {
    const output = formatSampleRowsForPrompt('analytics.fct_orders', [], false);

    expect(output).toBe('');
  });
});
