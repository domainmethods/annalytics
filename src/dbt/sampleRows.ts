import type { BigQuery } from '@google-cloud/bigquery';
import type { TableContext } from './types.js';

export interface SampleRowResult {
  tableName: string;
  rows: Record<string, unknown>[];
  error?: string;
}

export async function fetchSampleRows(
  bigquery: BigQuery,
  table: TableContext,
  partitionColumn?: string,
): Promise<SampleRowResult> {
  const fqn = `\`${table.schema}.${table.name.split('.').pop()}\``;
  let query: string;

  if (partitionColumn) {
    query = `SELECT * FROM ${fqn} WHERE ${partitionColumn} >= DATE_SUB(CURRENT_DATE(), INTERVAL 7 DAY) LIMIT 5`;
  } else {
    query = `SELECT * FROM ${fqn} LIMIT 5`;
  }

  try {
    const [rows] = await bigquery.query({ query, useLegacySql: false });
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
  return Promise.all(
    tables.map(table => {
      const stats = catalogStats?.[table.name];
      return fetchSampleRows(bigquery, table, stats?.partitionColumn);
    }),
  );
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
