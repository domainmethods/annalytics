import { describe, it, expect } from 'vitest';
import { chooseFormat } from '../../src/execution/formatter.js';
import type { QueryResult } from '../../src/types.js';

function makeQueryResult(overrides: Partial<QueryResult> = {}): QueryResult {
  return {
    rows: [{ id: '1', name: 'Alice', total: 100 }],
    columnNames: ['id', 'name', 'total'],
    totalRows: 1,
    bytesProcessed: 1000,
    truncated: false,
    ...overrides,
  };
}

describe('chooseFormat', () => {
  it('returns "single_value" for 1 row, 1 column', () => {
    const result = makeQueryResult({
      rows: [{ count: 42 }],
      columnNames: ['count'],
      totalRows: 1,
    });
    expect(chooseFormat(result)).toBe('single_value');
  });

  it('returns "table" for small result (<=20 rows, <=6 columns)', () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({ id: i, name: `user${i}` }));
    const result = makeQueryResult({ rows, columnNames: ['id', 'name'], totalRows: 5 });
    expect(chooseFormat(result)).toBe('table');
  });

  it('returns "wide_table" for >6 columns', () => {
    const row = { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7 };
    const result = makeQueryResult({
      rows: [row],
      columnNames: Object.keys(row),
      totalRows: 1,
    });
    expect(chooseFormat(result)).toBe('wide_table');
  });

  it('returns "summary" for >20 rows', () => {
    const rows = Array.from({ length: 21 }, (_, i) => ({ id: i }));
    const result = makeQueryResult({ rows, columnNames: ['id'], totalRows: 21 });
    expect(chooseFormat(result)).toBe('summary');
  });

  it('returns "zero_rows" for empty result', () => {
    const result = makeQueryResult({ rows: [], columnNames: [], totalRows: 0 });
    expect(chooseFormat(result)).toBe('zero_rows');
  });

  it('returns data format even when truncated (truncation is additive notice)', () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({ id: i }));
    const result = makeQueryResult({ rows, columnNames: ['id'], totalRows: 50000, truncated: true });
    // Truncation is handled as an additive notice by the caller, not an exclusive format
    expect(chooseFormat(result)).toBe('table');
  });
});
