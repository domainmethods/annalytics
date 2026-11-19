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

function groupColumns({ columnNames, rows }: QueryResult) {
  const groups: { values: Value[]; count: number }[] = [];
  for (const name of columnNames) {
    const values = rows.map(row => normalize(row[name]));
    const identical = groups.find(group => values.every((value, i) => equalValues(value, group.values[i], 0)));
    if (identical) identical.count++;
    else groups.push({ values, count: 1 });
  }
  return groups;
}

function columnSlots(counts: number[]): number[] {
  return counts.flatMap((count, i) => Array<number>(count).fill(i));
}

export function resultsEquivalent(
  ref: QueryResult,
  cand: QueryResult,
  opts: { ordered: boolean; relTol?: number },
): boolean {
  if (ref.columnNames.length !== cand.columnNames.length || ref.rows.length !== cand.rows.length) return false;
  if (ref.rows.length === 0) return true;

  const relTol = opts.relTol ?? 1e-6;
  const equal = (a: Value, b: Value) => equalValues(a, b, relTol);
  const equalSequence = (a: Value[], b: Value[]) => a.every((value, i) => equal(value, b[i]));
  const refGroups = groupColumns(ref);
  const candGroups = groupColumns(cand);
  const refSlots = columnSlots(refGroups.map(group => group.count));
  const remainingCounts = candGroups.map(group => group.count);
  const compatible = refGroups.map(({ values }) => new Set(candGroups.flatMap((candidate, i) => {
    const matches = opts.ordered
      ? equalSequence(values, candidate.values)
      : matchMultiset(values, candidate.values, equal);
    return matches ? [i] : [];
  })));
  const canPair = (a: number, b: number) => compatible[a].has(b);

  // With row positions fixed, each column pair can be checked independently.
  // Group only exact duplicates and match individual slots, since tolerance is non-transitive.
  if (opts.ordered) return matchMultiset(refSlots, columnSlots(remainingCounts), canPair);

  const mapping: number[] = [];
  let mappingsTried = 0;
  const refRows = ref.rows.map((_, i) => refSlots.map(group => refGroups[group].values[i]));

  function search(): boolean {
    const depth = mapping.length;
    if (depth === refSlots.length) {
      mappingsTried++;
      const projected = cand.rows.map((_, i) => mapping.map(group => candGroups[group].values[i]));
      return matchMultiset(refRows, projected, equalSequence);
    }

    const refGroup = refSlots[depth];
    // Assign duplicate reference columns in candidate-group order to visit each allocation once.
    const first = refGroup === refSlots[depth - 1] ? mapping[depth - 1] : 0;
    if (!matchMultiset(refSlots.slice(depth), columnSlots(remainingCounts),
      (a, b) => canPair(a, b) && (a !== refGroup || b >= first))) return false;

    for (const i of compatible[refGroup]) {
      // Treat a result as inequivalent when the search exhausts its mapping budget.
      if (mappingsTried >= MAX_COLUMN_MAPPINGS) return false;
      if (i < first || remainingCounts[i] === 0) continue;
      mapping.push(i);
      remainingCounts[i]--;
      if (search()) return true;
      mapping.pop();
      remainingCounts[i]++;
    }
    return false;
  }

  return search();
}
