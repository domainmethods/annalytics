import { BigQuery } from '@google-cloud/bigquery';
import type { ValidationResult } from '../types.js';

export type ReferencedTable = { projectId?: string; datasetId?: string; tableId?: string };
export type QueryRelationMetadata = {
  referencedTables?: ReferencedTable[];
  referencedLogicalViews?: ReferencedTable[];
  referencedRoutines?: { projectId?: string; datasetId?: string; routineId?: string }[];
};
export type DryRunValidationResult = ValidationResult & QueryRelationMetadata;

let bigquery: BigQuery;

export function initBigQuery(projectId?: string): void {
  bigquery = new BigQuery({ projectId });
}

export function isBigQueryQueryRejection(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'errors' in error && Array.isArray(error.errors) &&
    error.errors.length > 0 && error.errors.every((detail: unknown) =>
      typeof detail === 'object' && detail !== null && 'reason' in detail &&
      (detail.reason === 'invalidQuery' || detail.reason === 'billingTierLimitExceeded'));
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
    const { referencedTables, referencedLogicalViews, referencedRoutines } = statistics.query;
    return {
      valid: true, layer: 'L3-dryrun', bytesProcessed,
      ...(referencedTables && { referencedTables }),
      ...(referencedLogicalViews && { referencedLogicalViews }),
      ...(referencedRoutines && { referencedRoutines }),
    };
  } catch (error) {
    return {
      valid: false,
      layer: 'L3-dryrun',
      error: `Dry run failed: ${(error as Error).message}`,
      ...(!isBigQueryQueryRejection(error) && { warehouseFailure: true }),
    };
  }
}
