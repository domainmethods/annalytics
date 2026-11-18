import { BigQuery } from '@google-cloud/bigquery';
import type { JobCallback, JobOptions } from '@google-cloud/bigquery';
import { afterEach, expect, it, vi } from 'vitest';
import { executeQuery, initBigQueryClient } from '../../src/execution/runner.js';

afterEach(() => vi.restoreAllMocks());

it('sends the timeout at job level and caps rows when retrieving results', async () => {
  const getQueryResults = vi.fn().mockResolvedValue([[]]);
  const getMetadata = vi.fn().mockResolvedValue([{ statistics: { totalBytesProcessed: '0' } }]);
  const createJob = vi.spyOn(BigQuery.prototype, 'createJob').mockImplementation(
    function (this: BigQuery, _options: JobOptions, callback: JobCallback) {
      const job = this.job('test-job');
      vi.spyOn(job, 'getQueryResults').mockImplementation(getQueryResults);
      vi.spyOn(job, 'getMetadata').mockImplementation(getMetadata);
      callback(null, job);
    },
  );

  initBigQueryClient('test-project');
  await executeQuery('SELECT 1', { maxRows: 12, timeoutMs: 30_000, maxBytes: 123_456 });

  expect(createJob.mock.calls[0]?.[0].configuration).toEqual({
    jobTimeoutMs: '30000',
    query: { query: 'SELECT 1', useLegacySql: false, maximumBytesBilled: '123456' },
  });
  expect(getQueryResults).toHaveBeenCalledWith(expect.objectContaining({ maxResults: 12 }));
});
