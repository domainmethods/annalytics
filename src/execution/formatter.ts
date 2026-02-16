import type { QueryResult } from '../types.js';

export type FormatType = 'single_value' | 'table' | 'wide_table' | 'summary' | 'zero_rows';

export function chooseFormat(result: QueryResult): FormatType {
  if (result.totalRows === 0) return 'zero_rows';
  if (result.columnNames.length > 6) return 'wide_table';
  if (result.totalRows === 1 && result.columnNames.length === 1) return 'single_value';
  if (result.rows.length > 20) return 'summary';
  return 'table';
}
