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
      { metadata: { statistics: { totalBytesProcessed: '5000000000' } } },
    ]);

    const result = await dryRunValidation('SELECT * FROM users');
    expect(result.valid).toBe(true);
    expect(result.bytesProcessed).toBe(5_000_000_000);
  });

  it('returns invalid with error message on dry run failure', async () => {
    mockCreateQueryJob.mockRejectedValue(new Error('Table not found: dataset.missing_table'));

    const result = await dryRunValidation('SELECT * FROM dataset.missing_table');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('missing_table');
  });

  it('passes dryRun: true to BigQuery', async () => {
    mockCreateQueryJob.mockResolvedValue([
      { metadata: { statistics: { totalBytesProcessed: '0' } } },
    ]);

    await dryRunValidation('SELECT 1');
    expect(mockCreateQueryJob).toHaveBeenCalledWith(
      expect.objectContaining({ dryRun: true, useLegacySql: false }),
    );
  });
});
