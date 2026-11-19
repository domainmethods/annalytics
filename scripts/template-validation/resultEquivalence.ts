type QueryResult = { columnNames: string[]; rows: Record<string, unknown>[] };
type Value = null | boolean | number | string;

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
  if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value)) {
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return value;
}

function normalize(value: unknown): Value {
  if (value == null) return null;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') return value;
  if (typeof value === 'object' && !Array.isArray(value)) {
    if ('value' in value && typeof value.value === 'string') return normalizeWrappedString(value.value);
    if (typeof value.toString === 'function' && value.toString !== Object.prototype.toString) {
      return normalizeWrappedString(value.toString());
    }
  }
  return JSON.stringify(value, (_key, child: unknown) => {
    if (typeof child === 'bigint') return Number(child);
    if (child === null || typeof child !== 'object' || Array.isArray(child)) return child;
    return Object.fromEntries(Object.entries(child).sort(([a], [b]) => a < b ? -1 : Number(a > b)));
  }) ?? String(value);
}

function typeRank(value: Value): number {
  if (value === null) return 0;
  if (typeof value === 'boolean') return 1;
  if (typeof value === 'number') return 2;
  return 3;
}

function compareValues(a: Value, b: Value): number {
  const typeDifference = typeRank(a) - typeRank(b);
  if (typeDifference !== 0) return typeDifference;
  if (a === null || b === null) return 0;
  if (Number.isNaN(a)) return Number(Number.isNaN(b)) - 1;
  if (Number.isNaN(b)) return 1;
  return a < b ? -1 : Number(a > b);
}

function equalValues(a: Value, b: Value, relTol: number): boolean {
  if (a === b || Object.is(a, b)) return true;
  return typeof a === 'number' && typeof b === 'number'
    && Number.isFinite(a) && Number.isFinite(b)
    && Math.abs(a - b) <= relTol * Math.max(Math.abs(a), Math.abs(b), 1e-12);
}

function matchMultiset<T>(ref: T[], cand: T[], equal: (a: T, b: T) => boolean): boolean {
  const used = new Set<number>();
  return ref.every(value => {
    const index = cand.findIndex((candidate, i) => !used.has(i) && equal(value, candidate));
    if (index === -1) return false;
    used.add(index);
    return true;
  });
}

export function resultsEquivalent(
  ref: QueryResult,
  cand: QueryResult,
  opts: { ordered: boolean; relTol?: number },
): boolean {
  if (ref.columnNames.length !== cand.columnNames.length || ref.rows.length !== cand.rows.length) return false;

  const normalizeRows = ({ columnNames, rows }: QueryResult) =>
    rows.map(row => columnNames.map(name => normalize(row[name])).sort(compareValues));
  const refRows = normalizeRows(ref);
  const candRows = normalizeRows(cand);
  const relTol = opts.relTol ?? 1e-6;
  const equalRows = (a: Value[], b: Value[]) => matchMultiset(a, b, (left, right) => equalValues(left, right, relTol));
  return opts.ordered
    ? refRows.every((row, i) => equalRows(row, candRows[i]))
    : matchMultiset(refRows, candRows, equalRows);
}
