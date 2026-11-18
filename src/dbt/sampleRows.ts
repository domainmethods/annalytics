import type { BigQuery } from '@google-cloud/bigquery';
import type { TableContext } from './types.js';

const SAMPLE_MAX_BYTES = 100 * 1024 * 1024;

export interface SampleRowResult {
  tableName: string;
  rows: Record<string, unknown>[];
  error?: string;
}

export async function fetchSampleRows(
  bigquery: BigQuery,
  table: TableContext,
  partitionColumn?: string,
  maxBytes = SAMPLE_MAX_BYTES,
): Promise<SampleRowResult> {
  const maximumBytesBilled = Math.floor(Math.min(SAMPLE_MAX_BYTES, maxBytes));
  if (!Number.isFinite(maximumBytesBilled) || maximumBytesBilled <= 0) {
    return { tableName: table.name, rows: [], error: 'Sampling byte budget must be positive' };
  }

  const fqn = `\`${table.schema}.${table.name.split('.').pop()}\``;
  let query: string;

  if (partitionColumn) {
    query = `SELECT * FROM ${fqn} WHERE ${partitionColumn} >= DATE_SUB(CURRENT_DATE(), INTERVAL 7 DAY) LIMIT 5`;
  } else {
    query = `SELECT * FROM ${fqn} LIMIT 5`;
  }

  try {
    const [rows] = await bigquery.query({ query, useLegacySql: false, maximumBytesBilled: String(maximumBytesBilled) });
    return {
      tableName: table.name,
      rows: (rows as Record<string, unknown>[]).map(row => truncateRow(row, 500)),
    };
  } catch (error) {
    return {
      tableName: table.name,
      rows: [],
      error: (error as Error).message,
    };
  }
}

export async function fetchAllSampleRows(
  bigquery: BigQuery,
  tables: TableContext[],
  catalogStats?: Record<string, { partitionColumn?: string }>,
): Promise<SampleRowResult[]> {
  const results: SampleRowResult[] = [];
  for (const table of tables) {
    const partitionColumn = catalogStats?.[table.name]?.partitionColumn;
    results.push(await fetchSampleRows(bigquery, table, partitionColumn));
  }
  return results;
}

function truncateRow(
  row: Record<string, unknown>,
  maxCellLength: number,
): Record<string, unknown> {
  const truncated: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (typeof value === 'string' && value.length > maxCellLength) {
      truncated[key] = value.substring(0, maxCellLength) + '...';
    } else {
      truncated[key] = value;
    }
  }
  return truncated;
}
