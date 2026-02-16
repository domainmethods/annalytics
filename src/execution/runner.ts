import { BigQuery } from '@google-cloud/bigquery';
import type { QueryResult } from '../types.js';

let bigquery: BigQuery;

export function initBigQueryClient(projectId?: string): void {
  bigquery = new BigQuery({ projectId });
}

export function getBigQueryClient(): BigQuery {
  if (!bigquery) throw new Error('BigQuery client not initialized — call initBigQueryClient() first');
  return bigquery;
}

export interface ExecutionOptions {
  maxRows: number;
  timeoutMs: number;
  maxBytes: number;
}

export async function executeQuery(
  sql: string,
  options: ExecutionOptions,
): Promise<QueryResult> {
  if (!bigquery) throw new Error('BigQuery client not initialized — call initBigQueryClient() first');

  const [job] = await bigquery.createQueryJob({
    query: sql,
    useLegacySql: false,
    maximumBytesBilled: String(options.maxBytes),
    jobTimeoutMs: String(options.timeoutMs),
    maxResults: options.maxRows,
  } as any);

  const [rows] = await job.getQueryResults({ maxResults: options.maxRows });
  const [metadata] = await job.getMetadata();
  const stats = metadata.statistics;
  const totalRows = parseInt(stats.query?.totalRows || '0', 10);
  const bytesProcessed = parseInt(stats.totalBytesProcessed || '0', 10);

  const columnNames = rows.length > 0 ? Object.keys(rows[0]) : [];

  return {
    rows,
    columnNames,
    totalRows,
    bytesProcessed,
    truncated: totalRows > options.maxRows,
  };
}
