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
  const bytesProcessed = parseInt(stats.totalBytesProcessed || '0', 10);

  // The materialized result page (`rows`) is the authoritative count of rows
  // returned. `statistics.query.totalRows` is read only to recover the *full*
  // total when the page is capped by maxResults (for truncation detection) —
  // never as the sole source of truth, because the BigQuery SDK leaves it
  // undefined for some completed aggregate jobs. Trusting it alone made a 1-row
  // `COUNT(...)` result (totalRows undefined) look like an empty result, which
  // chooseFormat rendered as the "no results" panel.
  const reportedTotal = parseInt(stats.query?.totalRows || '0', 10);
  const totalRows = Math.max(rows.length, reportedTotal);

  const columnNames = rows.length > 0 ? Object.keys(rows[0]) : [];

  return {
    rows,
    columnNames,
    totalRows,
    bytesProcessed,
    // Truncated when the real total exceeds the cap. If the stat was missing,
    // fall back to "did we fill the page?" — a full page implies more rows were
    // dropped. (Guarded on reportedTotal===0 so a complete result of exactly
    // maxRows rows isn't mislabelled as truncated.)
    truncated: totalRows > options.maxRows || (reportedTotal === 0 && rows.length >= options.maxRows),
  };
}
