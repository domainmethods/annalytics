import { describe, it, expect, vi, beforeEach } from 'vitest';
import { dryRunValidation, initBigQuery } from '../../src/validation/dryRun.js';

// Mock @google-cloud/bigquery
const mockCreateQueryJob = vi.fn();
vi.mock('@google-cloud/bigquery', () => ({
  BigQuery: class {
    createQueryJob = mockCreateQueryJob;
  },
}));

describe('dryRunValidation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    initBigQuery('test-project');
  });

  it('returns valid with bytesProcessed on successful dry run', async () => {
    mockCreateQueryJob.mockResolvedValue([
      { metadata: { statistics: { query: { statementType: 'SELECT' }, totalBytesProcessed: '5000000000' } } },
    ]);

    const result = await dryRunValidation('SELECT * FROM users');
    expect(result).toEqual({ valid: true, layer: 'L3-dryrun', bytesProcessed: 5_000_000_000 });
  });

  it.each([
    { label: 'a script', query: { statementType: 'SCRIPT' } },
    { label: 'an unknown statement type', query: { statementType: 'UNKNOWN' } },
    { label: 'a missing statement type', query: {} },
    { label: 'missing query statistics', query: undefined },
  ])('returns an L3 failure for $label in dry run metadata', async ({ query }) => {
    mockCreateQueryJob.mockResolvedValue([
      { metadata: { statistics: { query, totalBytesProcessed: '0' } } },
    ]);

    expect(await dryRunValidation('SELECT 1')).toEqual({
      valid: false,
      layer: 'L3-dryrun',
      error: 'Only SELECT statements confirmed by BigQuery are allowed.',
    });
  });

  it.each([
    { label: 'missing', totalBytesProcessed: undefined },
    { label: 'non-numeric', totalBytesProcessed: 'n/a' },
  ])('fails closed as a warehouse failure when the byte count is $label', async ({ totalBytesProcessed }) => {
    mockCreateQueryJob.mockResolvedValue([
      { metadata: { statistics: { query: { statementType: 'SELECT' }, totalBytesProcessed } } },
    ]);

    expect(await dryRunValidation('SELECT 1')).toEqual({
      valid: false,
      layer: 'L3-dryrun',
      error: 'Dry run did not report how many bytes the query would scan.',
      warehouseFailure: true,
    });
  });

  it('returns a safe L3 error when job metadata is absent', async () => {
    mockCreateQueryJob.mockResolvedValue([{}]);

    expect(await dryRunValidation('SELECT 1')).toEqual({
      valid: false,
      layer: 'L3-dryrun',
      error: 'Only SELECT statements confirmed by BigQuery are allowed.',
    });
  });

  it('returns invalid with error message on dry run failure', async () => {
    mockCreateQueryJob.mockRejectedValue(new Error('Table not found: dataset.missing_table'));

    const result = await dryRunValidation('SELECT * FROM dataset.missing_table');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('missing_table');
  });

  it.each([['invalidQuery', undefined], ['accessDenied', true], ['backendError', true]])(
    'marks warehouse failures from BigQuery reason %s without marking rejected query SQL',
    async (reason, warehouseFailure) => {
      mockCreateQueryJob.mockRejectedValue(Object.assign(new Error('BigQuery rejected the request'), {
        errors: [{ reason }],
      }));
      const result = await dryRunValidation('SELECT 1');
      expect(result.valid).toBe(false);
      expect(result.warehouseFailure).toBe(warehouseFailure);
    },
  );

  it('passes dryRun: true to BigQuery', async () => {
    mockCreateQueryJob.mockResolvedValue([
      { metadata: { statistics: { query: { statementType: 'SELECT' }, totalBytesProcessed: '0' } } },
    ]);

    await dryRunValidation('SELECT 1');
    expect(mockCreateQueryJob).toHaveBeenCalledWith(
      expect.objectContaining({ dryRun: true, useLegacySql: false }),
    );
  });
});
