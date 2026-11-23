import { Parser } from 'node-sql-parser';
import type { QueryResult } from '../types.js';
import { computeShares, type ShareCell } from './shares.js';

/**
 * Composition verifier: proves, from the executed SQL's AST plus the result
 * schema and rows, that a two-column grouped result is an honest partition of
 * a whole, so a Share column and a Total row can be shown. Every check fails
 * closed: an AST shape it does not recognise is a rejection, never a pass.
 * See docs/plans/answer-shares-totals-design.md §3.
 */

export type CompositionRejectReason =
  | 'result_truncated' | 'row_count' | 'column_count' | 'column_name_collision' | 'column_types'
  | 'total_like_row' | 'parse_failed' | 'outer_shape' | 'group_by_shape' | 'measure_not_additive'
  | 'count_distinct' | 'sum_non_additive_column' | 'limit_applied' | 'row_source' | 'where_subquery'
  | 'where_on_dimension' | 'measure_value' | 'negative_value' | 'zero_total' | 'internal_error';

export interface CompositionInput {
  sql: string;
  result: QueryResult;
  maxDisplayRows: number;
  /** dbt-declared unique keys (`project.dataset.table.column`). Unused in v1. */
  uniqueKeys?: string[];
}

export type EligibleComposition = {
  eligible: true;
  dimension: string;
  measure: string;
  measureKind: 'count' | 'sum';
  total: string;
  /** Aligned with result.rows. */
  shares: ShareCell[];
  /** Row with the unique max basisPoints; null on a tie. */
  topIndex: number | null;
  /** Unique keys a proof relied on; always [] in v1. */
  usedUniqueKeys: string[];
};

export type CompositionVerdict = EligibleComposition | { eligible: false; reason: CompositionRejectReason };

type Node = Record<string, unknown>;

class Reject extends Error {
  constructor(readonly reason: CompositionRejectReason) {
    super(reason);
  }
}

const fail = (reason: CompositionRejectReason): never => {
  throw new Reject(reason);
};

const DIMENSION_TYPES = new Set(['STRING', 'BOOL']);
const MEASURE_TYPES = new Set(['INT64', 'NUMERIC', 'BIGNUMERIC', 'FLOAT64']);
const LEGACY_TYPES: Record<string, string> = { INTEGER: 'INT64', FLOAT: 'FLOAT64', BOOLEAN: 'BOOL' };
const TOTAL_LIKE_RE = /^\s*(total|grand total|all|overall|\(all\)|sum)\s*$/i;
const NON_ADDITIVE_COLUMN_RE = /(rate|ratio|pct|percent|share|avg|average|mean|median|p\d{2}|_per_|users?|visitors?|unique)/i;
const CAST_TARGETS = new Set(['INT64', 'NUMERIC', 'FLOAT64']);
/** BigQuery built-in aggregate (or grouping) function names that parse as plain `function` nodes. */
const AGGREGATE_FN_RE =
  /^(ANY_VALUE|ARRAY_AGG|ARRAY_CONCAT_AGG|AVG|BIT_AND|BIT_OR|BIT_XOR|COUNT|COUNTIF|LOGICAL_AND|LOGICAL_OR|MAX|MAX_BY|MIN|MIN_BY|STRING_AGG|SUM|GROUPING|CORR|COVAR_POP|COVAR_SAMP|STDDEV(_POP|_SAMP)?|VARIANCE|VAR_POP|VAR_SAMP|APPROX_\w+|ST_UNION_AGG|ST_EXTENT|ST_CENTROID_AGG|PERCENTILE_CONT|PERCENTILE_DISC|ROLLUP|CUBE)$/;

const OUTER_KEYS = new Set(['type', 'columns', 'from', 'where', 'with', 'groupby', 'orderby', 'limit']);
const SOURCE_KEYS = new Set(['type', 'columns', 'from', 'where', 'orderby']);
const TABLE_KEYS = new Set(['db', 'table', 'catalog', 'schema', 'surround', 'as', 'operator']);
const DERIVED_KEYS = new Set(['expr', 'as', 'operator']);

function isObj(v: unknown): v is Node {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isEmpty(v: unknown): boolean {
  return v === null || v === undefined || (Array.isArray(v) && v.length === 0);
}

/** True when every key outside `allowed` is empty. */
function onlyKeys(node: Node, allowed: Set<string>): boolean {
  return Object.entries(node).every(([k, v]) => allowed.has(k) || isEmpty(v));
}

/** Depth-first search over every object node, including subquery ASTs. */
function some(node: unknown, pred: (n: Node) => boolean): boolean {
  if (Array.isArray(node)) return node.some(n => some(n, pred));
  if (!isObj(node)) return false;
  if (pred(node)) return true;
  return Object.values(node).some(v => some(v, pred));
}

const hasSubquery = (n: unknown) => some(n, o => 'ast' in o);
const hasWindow = (n: unknown) => some(n, o => !isEmpty(o.over));

/** Upper-cased name of an unqualified built-in function; null for a qualified (user-defined) or unknown shape. */
function builtinName(fn: Node): string | null {
  const name = fn.name;
  if (!isObj(name) || !Array.isArray(name.name) || name.name.length !== 0) return null;
  const schema = name.schema;
  return isObj(schema) && typeof schema.value === 'string' ? schema.value.toUpperCase() : null;
}

/** True for any aggregate, or any function we cannot rule out as one (user-defined). */
const hasAggregate = (n: unknown) =>
  some(n, o => {
    if (o.type === 'aggr_func') return true;
    if (o.type !== 'function') return false;
    const name = builtinName(o);
    return name === null || AGGREGATE_FN_RE.test(name);
  });

/** Column name of a column_ref, or null when the shape is not recognised. */
function refName(ref: Node): string | null {
  const col = ref.column;
  if (typeof col === 'string') return col;
  if (isObj(col) && isObj(col.expr) && typeof col.expr.value === 'string') return col.expr.value;
  return null;
}

function isColumnRef(n: unknown): n is Node {
  return isObj(n) && n.type === 'column_ref';
}

/** Every name a WHERE/expression references: column names and table qualifiers. null marks an unrecognised ref. */
function referencedNames(n: unknown): (string | null)[] {
  const out: (string | null)[] = [];
  some(n, o => {
    if (o.type === 'column_ref') {
      out.push(refName(o)?.toLowerCase() ?? null);
      if (typeof o.table === 'string') out.push(o.table.toLowerCase());
      else if (!isEmpty(o.table)) out.push(null);
    }
    return false;
  });
  return out;
}

function aliasOf(as: unknown): string | null {
  if (isEmpty(as)) return null;
  if (typeof as === 'string') return as;
  if (isObj(as) && typeof as.value === 'string') return as.value;
  return fail('group_by_shape');
}

/** Structural identity, case-insensitive on column references. */
function canon(n: unknown): unknown {
  if (Array.isArray(n)) return n.map(canon);
  if (!isObj(n)) return n;
  if (n.type === 'column_ref') {
    const name = refName(n);
    if (name === null || (!isEmpty(n.table) && typeof n.table !== 'string')) fail('group_by_shape');
    return { column_ref: [typeof n.table === 'string' ? n.table.toLowerCase() : null, name!.toLowerCase()] };
  }
  return Object.fromEntries(Object.entries(n).map(([k, v]) => [k, canon(v)]));
}

const sameExpr = (a: unknown, b: unknown) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));

function normType(t: unknown): string {
  if (typeof t !== 'string') return '';
  const u = t.toUpperCase();
  return LEGACY_TYPES[u] ?? u;
}

function exprList(fn: Node): unknown[] {
  const args = fn.args;
  if (!isObj(args) || args.type !== 'expr_list' || !Array.isArray(args.value) || !onlyKeys(args, new Set(['type', 'value']))) {
    return fail('measure_not_additive');
  }
  return args.value;
}

const isNumber = (n: unknown, pred: (v: number) => boolean) =>
  isObj(n) && n.type === 'number' && typeof n.value === 'number' && pred(n.value);

/** S3 + S4: the measure is an allow-listed additive aggregate, optionally wrapped. */
function measureKind(e: unknown): 'count' | 'sum' {
  if (!isObj(e)) return fail('measure_not_additive');
  if (e.type === 'cast') {
    const target = e.target;
    const keyword = typeof e.keyword === 'string' ? e.keyword.toLowerCase() : '';
    if ((keyword !== 'cast' && keyword !== 'safe_cast') || !Array.isArray(target) || target.length !== 1
      || !isObj(target[0]) || typeof target[0].dataType !== 'string' || !CAST_TARGETS.has(target[0].dataType.toUpperCase())
      || !onlyKeys(target[0], new Set(['dataType']))) {
      return fail('measure_not_additive');
    }
    return measureKind(e.expr);
  }
  if (e.type === 'function') {
    const name = builtinName(e);
    if (name === 'APPROX_COUNT_DISTINCT') return fail('count_distinct');
    const args = exprList(e);
    if (name === 'ROUND' && (args.length === 1 || (args.length === 2 && isNumber(args[1], v => Number.isInteger(v) && v >= 0)))) {
      return measureKind(args[0]);
    }
    if ((name === 'IFNULL' || name === 'COALESCE') && args.length === 2 && isNumber(args[1], v => v === 0)) {
      return measureKind(args[0]);
    }
    if (name === 'COUNTIF' && args.length === 1 && !hasSubquery(args[0]) && !hasAggregate(args[0])) return 'count';
    return fail('measure_not_additive');
  }
  if (e.type === 'aggr_func') {
    const name = typeof e.name === 'string' ? e.name.toUpperCase() : '';
    const args = e.args;
    if (!isObj(args) || !onlyKeys(args, new Set(['expr', 'distinct']))) return fail('measure_not_additive');
    const arg = args.expr;
    const distinct = !isEmpty(args.distinct);
    if (name === 'COUNT') {
      if (distinct) return fail('count_distinct');
      if (isObj(arg) && arg.type === 'star') return 'count';
      if (!isObj(arg) || hasSubquery(arg) || hasAggregate(arg)) return fail('measure_not_additive');
      return 'count';
    }
    if (name === 'SUM') {
      if (distinct || !isObj(arg) || hasSubquery(arg) || hasAggregate(arg)) return fail('measure_not_additive');
      // S4, extended conservatively to every column referenced inside the SUM argument.
      if (referencedNames(arg).some(n => n === null || NON_ADDITIVE_COLUMN_RE.test(n))) return fail('sum_non_additive_column');
      return 'sum';
    }
  }
  return fail('measure_not_additive');
}

interface Cte { name: string; ast: Node }

function parseCtes(withClause: unknown): Cte[] {
  if (isEmpty(withClause)) return [];
  if (!Array.isArray(withClause)) return fail('row_source');
  return withClause.map(c => {
    if (!isObj(c) || !onlyKeys(c, new Set(['name', 'stmt']))) return fail('row_source');
    const name = isObj(c.name) && typeof c.name.value === 'string' ? c.name.value.toLowerCase() : null;
    const ast = isObj(c.stmt) ? c.stmt.ast : null;
    if (name === null || !isObj(ast)) return fail('row_source');
    return { name, ast };
  });
}

/** S6: exactly one plain source. Returns the chain of row-preserving source selects (outermost first). */
function resolveSource(from: unknown, scope: Cte[]): Node[] {
  if (!Array.isArray(from) || from.length !== 1 || !isObj(from[0])) return fail('row_source');
  const item = from[0];
  if (!isEmpty(item.join) || !isEmpty(item.on) || !isEmpty(item.using) || !isEmpty(item.operator) || item.type === 'unnest') {
    return fail('row_source');
  }
  if ('expr' in item) {
    if (!onlyKeys(item, DERIVED_KEYS) || !isObj(item.expr) || !isObj(item.expr.ast)) return fail('row_source');
    return rowPreservingChain(item.expr.ast, scope);
  }
  if (typeof item.table !== 'string' || !onlyKeys(item, TABLE_KEYS)) return fail('row_source');
  if (isEmpty(item.db) && isEmpty(item.schema) && isEmpty(item.catalog) && !item.table.includes('.')) {
    // CTEs shadow base tables: resolve against the CTEs visible at this point first.
    const name = item.table.toLowerCase();
    for (let i = scope.length - 1; i >= 0; i--) {
      if (scope[i].name === name) return rowPreservingChain(scope[i].ast, scope.slice(0, i));
    }
  }
  return [];
}

function rowPreservingChain(s: Node, scope: Cte[]): Node[] {
  if (s.type !== 'select' || !onlyKeys(s, SOURCE_KEYS)) return fail('row_source');
  for (const part of [s.columns, s.orderby]) {
    if (hasAggregate(part) || hasWindow(part) || hasSubquery(part)) return fail('row_source');
  }
  if (hasAggregate(s.where) || hasWindow(s.where)) return fail('row_source');
  return [s, ...resolveSource(s.from, scope)];
}

/** S8: no WHERE on the chain references the dimension, traced through passthrough columns. */
function checkWhereOnDimension(outer: Node, dimNames: Set<string>, chain: Node[]): void {
  const touches = (where: unknown) => referencedNames(where).some(n => n === null || dimNames.has(n));
  if (touches(outer.where)) fail('where_on_dimension');
  for (const s of chain) {
    for (const col of Array.isArray(s.columns) ? s.columns : []) {
      if (!isObj(col)) return fail('where_on_dimension');
      if (!onlyKeys(col, new Set(['expr', 'as']))) {
        // `* EXCEPT/REPLACE (...)` and other shapes: treat every name inside as dimension lineage.
        for (const n of referencedNames(col)) {
          if (n === null) return fail('where_on_dimension');
          dimNames.add(n);
        }
        continue;
      }
      const alias = typeof col.as === 'string' ? col.as : isObj(col.as) && typeof col.as.value === 'string' ? col.as.value : null;
      const own = alias ?? (isColumnRef(col.expr) ? refName(col.expr) : null);
      if (own !== null && dimNames.has(own.toLowerCase())) {
        for (const n of referencedNames(col.expr)) {
          if (n === null) return fail('where_on_dimension');
          dimNames.add(n);
        }
      }
    }
    if (touches(s.where)) fail('where_on_dimension');
  }
}

function verify(input: CompositionInput): CompositionVerdict {
  const { result, maxDisplayRows } = input;
  const rows = result.rows;

  // R1–R3
  if (result.truncated !== false || rows.length !== result.totalRows) fail('result_truncated');
  if (rows.length < 2 || rows.length > maxDisplayRows) fail('row_count');
  const names = result.columnNames;
  if (!Array.isArray(names) || names.length !== 2) fail('column_count');
  if (names.some(n => typeof n !== 'string' || n.toLowerCase() === 'share') || names[0].toLowerCase() === names[1].toLowerCase()) {
    fail('column_name_collision');
  }

  // R4: the types alone decide which column is the dimension; the AST must agree (S2).
  const types = result.columnTypes;
  if (!Array.isArray(types) || types.length !== 2) fail('column_types');
  const [t0, t1] = types!.map(normType);
  const dimIdx = DIMENSION_TYPES.has(t0) && MEASURE_TYPES.has(t1) ? 0
    : DIMENSION_TYPES.has(t1) && MEASURE_TYPES.has(t0) ? 1
      : fail('column_types');
  const measIdx = 1 - dimIdx;
  const dimension = names[dimIdx];
  const measure = names[measIdx];

  // R5
  if (rows.some(r => typeof r[dimension] === 'string' && TOTAL_LIKE_RE.test(r[dimension] as string))) fail('total_like_row');

  // S0
  let ast: unknown;
  try {
    ast = new Parser().astify(input.sql, { database: 'BigQuery' });
  } catch {
    return fail('parse_failed');
  }
  const stmts = Array.isArray(ast) ? ast : [ast];
  if (stmts.length !== 1 || !isObj(stmts[0]) || stmts[0].type !== 'select') fail('parse_failed');
  const sel = stmts[0] as Node;

  // S1
  if (!onlyKeys(sel, OUTER_KEYS)) fail('outer_shape');
  if ([sel.columns, sel.where, sel.groupby, sel.orderby].some(hasWindow)) fail('outer_shape');

  // S2
  const cols = sel.columns;
  if (!Array.isArray(cols) || cols.length !== 2) return fail('group_by_shape');
  const aliases = cols.map((c, i) => {
    if (!isObj(c) || !onlyKeys(c, new Set(['expr', 'as'])) || !isObj(c.expr)) return fail('group_by_shape');
    if (isColumnRef(c.expr) && refName(c.expr) === '*') return fail('group_by_shape');
    const alias = aliasOf(c.as);
    if (alias !== null && alias !== names[i]) fail('group_by_shape');
    if (alias === null && isColumnRef(c.expr) && refName(c.expr)?.toLowerCase() !== names[i].toLowerCase()) fail('group_by_shape');
    return alias;
  });
  const exprs = cols.map(c => (c as Node).expr as Node);
  const groupby = sel.groupby;
  if (!isObj(groupby) || !onlyKeys(groupby, new Set(['columns'])) || !Array.isArray(groupby.columns) || groupby.columns.length !== 1) {
    return fail('group_by_shape');
  }
  const g = groupby.columns[0];
  if (!isObj(g)) return fail('group_by_shape');
  // ROLLUP/CUBE/GROUPING SETS (or any unrecognised function name) never resolve to a plain dimension.
  if (g.type === 'function' && ['ROLLUP', 'CUBE', 'GROUPING', null].includes(builtinName(g))) fail('group_by_shape');
  let groupIdx: number;
  if (g.type === 'number') {
    groupIdx = isNumber(g, v => v === 1 || v === 2) ? (g.value as number) - 1 : fail('group_by_shape');
  } else {
    const gName = isColumnRef(g) && isEmpty(g.table) ? refName(g)?.toLowerCase() : undefined;
    const matches = [0, 1].filter(i => sameExpr(g, exprs[i]) || (gName !== undefined && aliases[i]?.toLowerCase() === gName));
    groupIdx = matches.length === 1 ? matches[0] : fail('group_by_shape');
  }
  if (groupIdx !== dimIdx) fail('group_by_shape');
  const dimExpr = exprs[dimIdx];
  if (hasAggregate(dimExpr) || hasSubquery(dimExpr)) fail('group_by_shape');

  // S3 + S4
  const kind = measureKind(exprs[measIdx]);

  // S5
  const limit = sel.limit;
  if (!isEmpty(limit)) {
    if (!isObj(limit)) return fail('limit_applied');
    const vals = limit.value;
    const plain = isEmpty(limit.seperator) || limit.seperator === '';
    const noLimit = Array.isArray(vals) && vals.length === 0 && plain;
    // Only a literal `LIMIT n` (no OFFSET) that provably didn't bite: rows.length < n.
    if (!noLimit && (!plain || !Array.isArray(vals) || vals.length !== 1
      || !isNumber(vals[0], v => Number.isInteger(v) && rows.length < v))) {
      fail('limit_applied');
    }
  }

  // S6
  const chain = resolveSource(sel.from, parseCtes(sel.with));

  // S7
  if ([sel.where, ...chain.map(s => s.where)].some(hasSubquery)) fail('where_subquery');

  // S8
  const dimNames = new Set<string>([dimension.toLowerCase()]);
  if (aliases[dimIdx] !== null) dimNames.add(aliases[dimIdx]!.toLowerCase());
  for (const n of referencedNames(dimExpr)) {
    if (n === null) fail('where_on_dimension');
    dimNames.add(n!);
  }
  checkWhereOnDimension(sel, dimNames, chain);

  // V1–V3
  const computed = computeShares(rows.map(r => r[measure]), types![measIdx]);
  if (!computed.ok) return fail(computed.reason);
  const max = Math.max(...computed.shares.map(s => s.basisPoints));
  const top = computed.shares.flatMap((s, i) => (s.basisPoints === max ? [i] : []));
  return {
    eligible: true,
    dimension,
    measure,
    measureKind: kind,
    total: computed.total,
    shares: computed.shares,
    topIndex: top.length === 1 ? top[0] : null,
    usedUniqueKeys: [],
  };
}

/** Never throws: any unproven or unexpected case is a rejection. */
export function verifyComposition(input: CompositionInput): CompositionVerdict {
  try {
    return verify(input);
  } catch (err) {
    return { eligible: false, reason: err instanceof Reject ? err.reason : 'internal_error' };
  }
}
