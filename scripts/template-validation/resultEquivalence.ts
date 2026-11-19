import { BigQueryDate, BigQueryDatetime, BigQueryInt, BigQueryTime, BigQueryTimestamp } from '@google-cloud/bigquery';

type QueryResult = { columnNames: string[]; rows: Record<string, unknown>[] };
type Scalar = null | boolean | number | string;
type Value = Scalar | { encoded: string };
const MAX_COLUMN_MAPPINGS = 5000;

export function referenceIsOrdered(sql: string): boolean {
  // Consume quoted text and comments as whole tokens so their parentheses cannot affect depth.
  const tokens = /--[^\r\n]*|#[^\r\n]*|\/\*[\s\S]*?\*\/|"""(?:\\[\s\S]|(?!""")[^\\])*"""|'''(?:\\[\s\S]|(?!''')[^\\])*'''|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|`(?:\\[\s\S]|[^`\\])*`|[\w@]+|\S/g;
  let depth = 0;
  let previous = '';
  let hasOrderBy = false;
  for (const [token] of sql.matchAll(tokens)) {
    if (token.startsWith('--') || token.startsWith('#') || token.startsWith('/*')) continue;
    if (token === '(') depth++;
    if (token === ')') depth--;
    const keyword = depth === 0 ? token.toUpperCase() : '';
    if (keyword === 'BY' && previous === 'ORDER') hasOrderBy = true;
    if (keyword === 'LIMIT' && previous !== '.' && hasOrderBy) return true;
    previous = keyword === 'ORDER' && previous === '.' ? '' : keyword;
  }
  return false;
}

function normalizeWrappedString(value: string): string | number {
  const text = value.trim();
  const number = Number(text);
  return text !== '' && Number.isFinite(number) ? number : value;
}

function normalizeScalar(value: unknown): Scalar | undefined {
  if (value == null) return null;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') return value;
  if (value instanceof BigQueryDate || value instanceof BigQueryDatetime || value instanceof BigQueryTime
    || value instanceof BigQueryTimestamp || value instanceof BigQueryInt) {
    return normalizeWrappedString(value.value);
  }
  if (typeof value === 'object' && value.constructor?.name === 'Big'
    && 'toFixed' in value && typeof value.toFixed === 'function') {
    return normalizeWrappedString(value.toString());
  }
  return undefined;
}

function encodeNested(value: unknown): unknown {
  if (value === undefined) return ['undefined'];
  const scalar = normalizeScalar(value);
  if (typeof scalar === 'number' && !Number.isFinite(scalar)) return ['number', String(scalar)];
  if (scalar !== undefined) return scalar;
  if (Array.isArray(value)) return ['array', value.map(encodeNested)];
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return ['record', Object.keys(record).sort().map(key => [key, encodeNested(record[key])])];
  }
  return [typeof value, String(value)];
}

function normalize(value: unknown): Value {
  const scalar = normalizeScalar(value);
  return scalar === undefined ? { encoded: JSON.stringify(encodeNested(value)) } : scalar;
}

function equalValues(a: Value, b: Value, relTol: number): boolean {
  if (a === b || Object.is(a, b)) return true;
  if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object') {
    return a.encoded === b.encoded;
  }
  return typeof a === 'number' && typeof b === 'number'
    && Number.isFinite(a) && Number.isFinite(b)
    && Math.abs(a - b) <= relTol * Math.max(Math.abs(a), Math.abs(b), 1e-12);
}

function matchMultiset<T>(ref: T[], cand: T[], equal: (a: T, b: T) => boolean): boolean {
  const assigned: (T | undefined)[] = Array.from({ length: cand.length });

  function assign(value: T, visited: Set<number>): boolean {
    const free = cand.findIndex((candidate, i) => assigned[i] === undefined && equal(value, candidate));
    if (free !== -1) {
      assigned[free] = value;
      return true;
    }

    // If every compatible candidate is taken, try moving its current match.
    return cand.some((candidate, i) => {
      const current = assigned[i];
      if (current === undefined || visited.has(i) || !equal(value, candidate)) return false;
      visited.add(i);
      if (!assign(current, visited)) return false;
      assigned[i] = value;
      return true;
    });
  }

  return ref.every(value => assign(value, new Set()));
}

export function resultsEquivalent(
  ref: QueryResult,
  cand: QueryResult,
  opts: { ordered: boolean; relTol?: number },
): boolean {
  if (ref.columnNames.length !== cand.columnNames.length || ref.rows.length !== cand.rows.length) return false;
  if (ref.rows.length === 0) return true;

  const normalizeRows = ({ columnNames, rows }: QueryResult) =>
    rows.map(row => columnNames.map(name => normalize(row[name])));
  const refRows = normalizeRows(ref);
  const candRows = normalizeRows(cand);
  const relTol = opts.relTol ?? 1e-6;
  const equal = (a: Value, b: Value) => equalValues(a, b, relTol);
  const refColumns = ref.columnNames.map((_, i) => refRows.map(row => row[i]));
  const candColumns = cand.columnNames.map((_, i) => candRows.map(row => row[i]));
  const columnIndices = refColumns.map((_, i) => i);
  const compatible = refColumns.map(column => new Set(
    columnIndices.filter(i => matchMultiset(column, candColumns[i], equal))));

  const mapping: number[] = [];
  const used = new Set<number>();
  let mappingsTried = 0;
  const equalRows = (a: Value[], b: Value[]) => a.every((value, i) => equal(value, b[i]));

  function search(): boolean {
    if (mapping.length === refColumns.length) {
      mappingsTried++;
      const projected = candRows.map(row => mapping.map(i => row[i]));
      return opts.ordered
        ? refRows.every((row, i) => equalRows(row, projected[i]))
        : matchMultiset(refRows, projected, equalRows);
    }
    const remaining = columnIndices.slice(mapping.length);
    const available = columnIndices.filter(i => !used.has(i));
    // Skip prefixes that cannot extend to a full mapping, even if every column has an edge.
    if (!matchMultiset(remaining, available, (a, b) => compatible[a].has(b))) return false;

    for (const i of compatible[mapping.length]) {
      // Treat a result as inequivalent when the search exhausts its mapping budget.
      if (mappingsTried >= MAX_COLUMN_MAPPINGS) return false;
      if (used.has(i)) continue;
      mapping.push(i);
      used.add(i);
      if (search()) return true;
      mapping.pop();
      used.delete(i);
    }
    return false;
  }

  return search();
}
