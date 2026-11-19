import { BigQuery } from '@google-cloud/bigquery';
import type { ValidationResult } from '../types.js';
import { pickRelationMetadata, type QueryRelationMetadata } from './relationMetadata.js';

export type { QueryRelationMetadata, ReferencedTable } from './relationMetadata.js';
export type DryRunValidationResult = ValidationResult & QueryRelationMetadata;

let bigquery: BigQuery;

export function initBigQuery(projectId?: string): void {
  bigquery = new BigQuery({ projectId });
}

/**
 * True only for errors that reject the query itself. Everything else (including
 * `notFound` and `accessDenied`) is treated as a warehouse failure. That is safe
 * only for a caller whose relation allowlist rejects unknown tables before
 * the dry run; without such a pre-filter, a hallucinated table
 * would be misread as infrastructure instead of a model error.
 */
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
    return { valid: true, layer: 'L3-dryrun', bytesProcessed, ...pickRelationMetadata(statistics.query) };
  } catch (error) {
    return {
      valid: false,
      layer: 'L3-dryrun',
      error: `Dry run failed: ${(error as Error).message}`,
      ...(!isBigQueryQueryRejection(error) && { warehouseFailure: true }),
    };
  }
}
