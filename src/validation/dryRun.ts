import { BigQuery } from '@google-cloud/bigquery';
import type { ValidationResult } from '../types.js';

export type ReferencedTable = { datasetId?: string };
export type DryRunValidationResult = ValidationResult & { referencedTables?: ReferencedTable[] };

let bigquery: BigQuery;

export function initBigQuery(projectId?: string): void {
  bigquery = new BigQuery({ projectId });
}

export async function dryRunValidation(sql: string): Promise<DryRunValidationResult> {
  if (!bigquery) throw new Error('BigQuery client not initialized — call initBigQuery() first');

  try {
    const [job] = await bigquery.createQueryJob({
      query: sql,
      dryRun: true,
      useLegacySql: false,
    });

    const statistics = job?.metadata?.statistics;
    if (statistics?.query?.statementType !== 'SELECT') {
      return {
        valid: false,
        layer: 'L3-dryrun',
        error: 'Only SELECT statements confirmed by BigQuery are allowed.',
      };
    }

    const bytesProcessed = parseInt(statistics.totalBytesProcessed, 10);
    const { referencedTables } = statistics.query;
    return { valid: true, layer: 'L3-dryrun', bytesProcessed, ...(referencedTables && { referencedTables }) };
  } catch (error) {
    return {
      valid: false,
      layer: 'L3-dryrun',
      error: `Dry run failed: ${(error as Error).message}`,
    };
  }
}
