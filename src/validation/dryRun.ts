import { BigQuery } from '@google-cloud/bigquery';
import type { ValidationResult } from '../types.js';

let bigquery: BigQuery;

export function initBigQuery(projectId?: string): void {
  bigquery = new BigQuery({ projectId });
}

export async function dryRunValidation(sql: string): Promise<ValidationResult> {
  if (!bigquery) throw new Error('BigQuery client not initialized — call initBigQuery() first');

  try {
    const [job] = await bigquery.createQueryJob({
      query: sql,
      dryRun: true,
      useLegacySql: false,
    });

    // Statistics live under job.metadata, not directly on the Job instance
    const bytesProcessed = parseInt(job.metadata.statistics.totalBytesProcessed, 10);
    return { valid: true, layer: 'L3-dryrun', bytesProcessed };
  } catch (error) {
    return {
      valid: false,
      layer: 'L3-dryrun',
      error: `Dry run failed: ${(error as Error).message}`,
    };
  }
}
