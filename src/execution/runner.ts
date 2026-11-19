import { BigQuery, type QueryResultsOptions } from '@google-cloud/bigquery';
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
    jobTimeoutMs: options.timeoutMs,
  });

  // Passing `maxResults` turns SDK auto-pagination off, so each call returns a
  // single API page as `[rows, nextQuery, response]`. The response carries the
  // authoritative `totalRows` for the whole result. A page can be short (the API
  // caps page bytes) or empty while the job is still running, so keep following
  // `nextQuery` until the cap is filled or the result ends.
  const rows: Record<string, unknown>[] = [];
  let reportedTotal: number | undefined;
  let hasMore = false;
  const wrapIntegers = {
    integerTypeCastFunction: (value: string) => {
      const integer = Number(value);
      return Number.isSafeInteger(integer) ? integer : value;
    },
  };
  let request: QueryResultsOptions = { maxResults: options.maxRows, wrapIntegers };
  const deadline = Date.now() + options.timeoutMs;
  for (;;) {
    const [page, nextQuery, response] = await job.getQueryResults(request);
    rows.push(...(page as Record<string, unknown>[]));
    const total = parseCount(response?.totalRows);
    if (total !== undefined) reportedTotal = total;
    const stillRunning = response?.jobComplete === false;
    hasMore = !stillRunning && Boolean(nextQuery?.pageToken);
    const remaining = options.maxRows - rows.length;
    if (!nextQuery || (!stillRunning && (!hasMore || remaining <= 0))) break;
    if (Date.now() > deadline) {
      throw new Error(`The query did not complete before ${options.timeoutMs}ms`);
    }
    request = { ...nextQuery, wrapIntegers, maxResults: Math.min(options.maxRows, Math.max(remaining, 1)) };
  }
  if (rows.length > options.maxRows) rows.length = options.maxRows;

  const [metadata] = await job.getMetadata();
  const stats = metadata.statistics;
  const bytesProcessed = parseInt(stats.totalBytesProcessed || '0', 10);

  // The materialized rows are a floor: the SDK has been seen to omit a total for
  // some completed aggregate jobs, and a 1-row COUNT(...) must not look empty.
  const totalRows = Math.max(rows.length, reportedTotal ?? 0);
  const columnNames = rows.length > 0 ? Object.keys(rows[0]) : [];

  return {
    rows,
    columnNames,
    totalRows,
    bytesProcessed,
    // Truncated when the result holds more rows than we returned. Without a
    // reported total, a remaining page token is the signal.
    truncated: reportedTotal !== undefined ? reportedTotal > rows.length : hasMore,
  };
}

function parseCount(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}
