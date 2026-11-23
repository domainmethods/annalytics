// The proof reads node-sql-parser's AST shape. onlyKeys() rejects unknown keys, but a parser bump that maps a new
// construct onto an allowed key could widen what passes: re-run tests/execution/composition.test.ts on any bump
// (package.json pins the exact version, so a bump is always a deliberate change).
import { Parser } from 'node-sql-parser';
import { isTotalLikeLabel } from './totalLike.js';
import type { QueryResult } from '../types.js';
import { computeShares, type ShareCell } from './shares.js';

/**
 * Composition verifier: proves, from the executed SQL's AST plus the result
 * schema and rows, that a two-column grouped result is an honest partition of
 * a whole, so a Share column and a Total row can be shown. Every check fails
 * closed: an AST shape it does not recognise is a rejection, never a pass.
 * See docs/answer-shares-totals-design.md §3.
 */

export type CompositionRejectReason =
  | 'result_truncated' | 'row_count' | 'column_count' | 'column_name_collision' | 'column_types'
  | 'total_like_row' | 'parse_failed' | 'outer_shape' | 'group_by_shape' | 'measure_not_additive'
  | 'count_distinct' | 'sum_non_additive_column' | 'sum_joined_column' | 'limit_applied' | 'row_source' | 'where_subquery'
  | 'where_on_dimension' | 'measure_value' | 'negative_value' | 'zero_total' | 'internal_error';

export interface CompositionInput {
  sql: string;
  result: QueryResult;
  maxDisplayRows: number;
  /** dbt-declared unique keys (`project.dataset.table.column`), matched case-insensitively. */
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
  /** Unique keys the proof relied on: deduped, column lower-cased (table case kept, see `uniqueKeyCase`), sorted. */
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
// Mirrors the aliases shares.ts accepts (isNumericColumnType); the two tables are separate, so keep them in step.
const LEGACY_TYPES: Record<string, string> = { INTEGER: 'INT64', FLOAT: 'FLOAT64', BOOLEAN: 'BOOL', DECIMAL: 'NUMERIC', BIGDECIMAL: 'BIGNUMERIC' };
// Substring match on purpose: names with no separator (conversionrate, bounceRate, avgTime)
// must still be caught. It costs eligibility on names like generated_revenue, never correctness.
const NON_ADDITIVE_COLUMN_RE = /(rate|ratio|pct|percent|share|avg|average|mean|median|p\d{2}|_per_|users?|visitors?|unique)/i;
const CAST_TARGETS = new Set(['INT64', 'NUMERIC', 'FLOAT64']);
/** BigQuery built-in aggregate (or grouping) function names that parse as plain `function` nodes. */
const AGGREGATE_FN_RE =
  /^(ANY_VALUE|ARRAY_AGG|ARRAY_CONCAT_AGG|AVG|BIT_AND|BIT_OR|BIT_XOR|COUNT|COUNTIF|LOGICAL_AND|LOGICAL_OR|MAX|MAX_BY|MIN|MIN_BY|STRING_AGG|SUM|GROUPING|CORR|COVAR_POP|COVAR_SAMP|STDDEV(_POP|_SAMP)?|VARIANCE|VAR_POP|VAR_SAMP|APPROX_\w+|ST_UNION_AGG|ST_EXTENT|ST_CENTROID_AGG|PERCENTILE_CONT|PERCENTILE_DISC|ROLLUP|CUBE)$/;

const OUTER_KEYS = new Set(['type', 'columns', 'from', 'where', 'with', 'groupby', 'orderby', 'limit']);
const SOURCE_KEYS = new Set(['type', 'columns', 'from', 'where', 'orderby']);
const TABLE_KEYS = new Set(['db', 'table', 'catalog', 'schema', 'surround', 'as', 'operator']);
const DERIVED_KEYS = new Set(['expr', 'as', 'operator']);
const JOIN_ITEM_KEYS = new Set([...TABLE_KEYS, 'join', 'on', 'using']);
const LEFT_JOINS = new Set(['LEFT JOIN', 'LEFT OUTER JOIN']);
const PLAIN_REF_KEYS = new Set(['type', 'table', 'column', 'subFields', 'collate']);

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

/**
 * Names a select's own FROM item can be qualified by: its alias, or, only when
 * it has none, its full table name and the table name's last segment. Unrecognised shapes add nothing, so
 * their qualifiers stay tracked as names (fail closed).
 */
function fromQualifiers(s: Node): Set<string> {
  const out = new Set<string>();
  for (const item of Array.isArray(s.from) ? s.from : []) for (const q of itemQualifiers(item)) out.add(q);
  return out;
}

/** The qualifiers of one FROM item (see fromQualifiers). */
function itemQualifiers(item: unknown): Set<string> {
  const out = new Set<string>();
  if (!isObj(item)) return out;
  const alias = typeof item.as === 'string' ? item.as : isObj(item.as) && typeof item.as.value === 'string' ? item.as.value : null;
  // An explicit alias hides the table name (`FROM t AS s`: `t.x` is a struct column `t`).
  if (alias !== null && alias !== '') out.add(alias.toLowerCase());
  else if (typeof item.table === 'string') {
    out.add(item.table.toLowerCase());
    out.add(lastSegment(item.table));
  }
  return out;
}

const lastSegment = (table: string) => table.split('.').pop()!.toLowerCase();

/**
 * BigQuery dataset and table names are case-sensitive, column names are not: fold only the column, so a
 * `unique` test on `ds.Orders` never vouches for a different table `ds.orders` (fail closed).
 */
export function uniqueKeyCase(key: string): string {
  const i = key.lastIndexOf('.');
  return key.slice(0, i + 1) + key.slice(i + 1).toLowerCase();
}

/**
 * A base-table reference's full `project.dataset.table` name, case kept (see `uniqueKeyCase`):
 * the (backtick-stripped) table when it has exactly three non-empty parts,
 * else catalog/db, schema and table when all three exist; otherwise null.
 */
function fullName(item: Node): string | null {
  if (typeof item.table !== 'string') return null;
  const parts = item.table.split('.');
  if (parts.length === 3) {
    const unsplit = isEmpty(item.db) && isEmpty(item.schema) && isEmpty(item.catalog);
    return unsplit && parts.every(x => x !== '') ? item.table : null;
  }
  const project = item.catalog ?? item.db;
  if (parts.length !== 1 || item.table === '') return null;
  return [project, item.schema].every(x => typeof x === 'string' && x !== '' && !x.includes('.'))
    ? `${project as string}.${item.schema as string}.${item.table}`
    : null;
}

/**
 * A column_ref with no struct-field access and no COLLATE (a case-insensitive
 * collation would merge distinct key values).
 */
function isPlainRef(n: unknown): n is Node {
  return isColumnRef(n) && onlyKeys(n, PLAIN_REF_KEYS) && isEmpty(n.subFields) && isEmpty(n.collate);
}

/** `[qualifier, column]` (lower-cased) of a qualified plain column_ref; else null. */
function plainQualifiedRef(n: unknown): [string, string] | null {
  if (!isPlainRef(n) || typeof n.table !== 'string') return null;
  const name = refName(n);
  return name === null || name === '*' ? null : [n.table.toLowerCase(), name.toLowerCase()];
}

/**
 * Every name an expression references: column names, plus table qualifiers
 * other than `ownQualifiers` (the enclosing select's FROM names), so a
 * struct-field access like `user.channel` stays tracked. null marks a
 * reference that may carry any column, which every caller fails closed on:
 * an unrecognised ref, a `*` inside an expression (`STRUCT(s.*)`), or an
 * unqualified reference to the select's own FROM item (`s`, `sessions`, a
 * derived alias `t`), which in BigQuery is the whole row as a STRUCT.
 */
function referencedNames(n: unknown, ownQualifiers: Set<string>): (string | null)[] {
  const out: (string | null)[] = [];
  some(n, o => {
    if (o.type === 'column_ref') {
      const name = refName(o)?.toLowerCase() ?? null;
      const wholeRow = name === '*' || (isEmpty(o.table) && name !== null && ownQualifiers.has(name));
      out.push(wholeRow ? null : name);
      if (typeof o.table === 'string') {
        if (!ownQualifiers.has(o.table.toLowerCase())) out.push(o.table.toLowerCase());
      } else if (!isEmpty(o.table)) out.push(null);
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

/**
 * S3 + S4: the measure is an allow-listed additive aggregate, optionally
 * wrapped. A `COUNT(DISTINCT arg)` is pushed to `distinctArgs` for the
 * unique-key proof after S6; with no unique keys (`distinctArgs` null) it
 * rejects at once.
 */
function measureKind(e: unknown, quals: Set<string>, distinctArgs: unknown[] | null): 'count' | 'sum' {
  if (!isObj(e)) return fail('measure_not_additive');
  if (e.type === 'cast') {
    const target = e.target;
    const keyword = typeof e.keyword === 'string' ? e.keyword.toLowerCase() : '';
    if ((keyword !== 'cast' && keyword !== 'safe_cast') || !Array.isArray(target) || target.length !== 1
      || !isObj(target[0]) || typeof target[0].dataType !== 'string' || !CAST_TARGETS.has(target[0].dataType.toUpperCase())
      || !onlyKeys(target[0], new Set(['dataType']))) {
      return fail('measure_not_additive');
    }
    const inner = measureKind(e.expr, quals, distinctArgs);
    // INT64 rounds each cell separately, so over a SUM the shares stop bounding the error (0.4/0.4/1.4 → 0%/0%/100%).
    // Over a count it changes nothing.
    if (target[0].dataType.toUpperCase() === 'INT64' && inner !== 'count') return fail('measure_not_additive');
    return inner;
  }
  if (e.type === 'function') {
    const name = builtinName(e);
    if (name === 'APPROX_COUNT_DISTINCT') return fail('count_distinct');
    const args = exprList(e);
    if (name === 'ROUND' && (args.length === 1 || (args.length === 2 && isNumber(args[1], v => Number.isInteger(v) && v >= 0)))) {
      // ROUND is a no-op on a count; over a SUM it rounds each cell separately, as INT64 does above.
      const inner = measureKind(args[0], quals, distinctArgs);
      return inner === 'count' ? inner : fail('measure_not_additive');
    }
    if ((name === 'IFNULL' || name === 'COALESCE') && args.length === 2 && isNumber(args[1], v => v === 0)) {
      return measureKind(args[0], quals, distinctArgs);
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
      if (distinct) {
        if (distinctArgs === null) return fail('count_distinct');
        distinctArgs.push(arg);
        return 'count';
      }
      if (isObj(arg) && arg.type === 'star') return 'count';
      if (!isObj(arg) || hasSubquery(arg) || hasAggregate(arg)) return fail('measure_not_additive');
      return 'count';
    }
    if (name === 'SUM') {
      if (distinct || !isObj(arg) || hasSubquery(arg) || hasAggregate(arg)) return fail('measure_not_additive');
      // S4, extended conservatively to every column referenced inside the SUM argument.
      if (referencedNames(arg, quals).some(n => n === null || NON_ADDITIVE_COLUMN_RE.test(n))) return fail('sum_non_additive_column');
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
    // A dotted CTE name could pass for a base table's full name (fail closed; BigQuery rejects it anyway).
    if (name === null || name.includes('.') || !isObj(ast)) return fail('row_source');
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

/** Names an expression references; any null from referencedNames (see there) fails closed. */
function namesOf(n: unknown, ownQualifiers: Set<string>): string[] {
  return referencedNames(n, ownQualifiers).map(x => x ?? fail('where_on_dimension'));
}

/**
 * One lineage step through source select `s`: every name `s`'s consumer may
 * reference maps to the names `s` reads from its own source. Over-approximates
 * (fail closed): a name always maps to itself too (it may pass through a `*`),
 * and a `* EXCEPT/REPLACE (...)` item or any unrecognised item maps every name
 * to everything that item references.
 */
function expandThrough(names: Set<string>, s: Node): Set<string> {
  const out = new Set(names);
  const quals = fromQualifiers(s);
  for (const col of Array.isArray(s.columns) ? s.columns : fail('where_on_dimension')) {
    if (!isObj(col)) return fail('where_on_dimension');
    if (!onlyKeys(col, new Set(['expr', 'as']))) {
      for (const n of namesOf(col, quals)) out.add(n);
      continue;
    }
    const alias = isEmpty(col.as) ? null : aliasOf(col.as);
    const own = alias ?? (isColumnRef(col.expr) ? refName(col.expr) : null);
    if (own !== null && names.has(own.toLowerCase())) for (const n of namesOf(col.expr, quals)) out.add(n);
  }
  return out;
}

/** Union of the names at every level from `from` down to the base tables. */
function lineage(names: Set<string>, levels: Node[], from: number): Set<string> {
  const all = new Set(names);
  let current = names;
  for (let i = from; i < levels.length; i++) {
    current = expandThrough(current, levels[i]);
    for (const n of current) all.add(n);
  }
  return all;
}

/**
 * S8: no WHERE on the chain (outer included) may touch the dimension. Each
 * WHERE's names and the dimension's names are both traced to base columns,
 * and any overlap at any level rejects. levels = [outer, ...source chain]; the
 * WHERE of levels[k] reads the outputs of levels[k + 1]. The outer WHERE's
 * names are passed in (`outerWhere`), so a join query can pass only those
 * that read the left source.
 */
function checkWhereOnDimension(levels: Node[], dimNames: Set<string>, outerWhere: Set<string>): void {
  const dimAll = lineage(dimNames, levels, 1);
  levels.forEach((level, k) => {
    const names = k === 0 ? outerWhere : new Set(namesOf(level.where, fromQualifiers(level)));
    const whereAll = lineage(names, levels, k + 1);
    for (const n of whereAll) if (dimAll.has(n)) fail('where_on_dimension');
  });
}

/**
 * The name `col` keeps when it passes through source select `s` un-renamed
 * and untransformed: exactly one item produces it, as `*` (no EXCEPT/REPLACE,
 * own qualifier or none) or as a plain own column ref of the same name.
 * Anything else, including a struct-field item whose output name is not its
 * ref name, is null (fail closed).
 */
function passthrough(s: Node, col: string): string | null {
  const quals = fromQualifiers(s);
  const ownOrNone = (t: unknown) => isEmpty(t) || (typeof t === 'string' && quals.has(t.toLowerCase()));
  let found = 0;
  for (const item of Array.isArray(s.columns) ? s.columns : []) {
    if (!isObj(item) || !onlyKeys(item, new Set(['expr', 'as'])) || !isObj(item.expr)) return null;
    const e = item.expr;
    const alias = isEmpty(item.as) ? null : typeof item.as === 'string' ? item.as : isObj(item.as) && typeof item.as.value === 'string' ? item.as.value : undefined;
    if (alias === undefined) return null;
    // A struct-field item's output name is not its ref name; a COLLATE item is a transform.
    if (isColumnRef(e) && !isPlainRef(e)) return null;
    const name = isColumnRef(e) ? refName(e)?.toLowerCase() ?? null : null;
    if (name === '*' && alias === null) {
      if (!ownOrNone(e.table)) return null;
      found++;
      continue;
    }
    if ((alias ?? name)?.toLowerCase() !== col) continue;
    if (name !== col || !ownOrNone(e.table) || quals.has(col)) return null;
    found++;
  }
  return found === 1 ? col : null;
}

/**
 * The unique key a `COUNT(DISTINCT arg)` relies on: `arg` is a plain column
 * ref (qualified by one of `quals`, or unqualified when `allowBare`) that
 * passes un-renamed through every row-preserving `chain` level to `base`,
 * whose full name plus the column is a declared key. null when unproven.
 */
function distinctKey(arg: unknown, quals: Set<string>, allowBare: boolean, chain: Node[], base: Node, keys: Set<string>): string | null {
  if (!isPlainRef(arg)) return null;
  let col = refName(arg)?.toLowerCase() ?? null;
  if (col === null || col === '*') return null;
  if (isEmpty(arg.table) ? !allowBare || quals.has(col) : typeof arg.table !== 'string' || !quals.has(arg.table.toLowerCase())) return null;
  for (const level of chain) {
    col = passthrough(level, col);
    if (col === null) return null;
  }
  const full = fullName(base);
  const key = full === null ? null : `${full}.${col}`;
  return key !== null && keys.has(key) ? key : null;
}

/** The base-table FROM item at the bottom of a resolved chain. */
function baseOf(from: unknown, chain: Node[]): Node {
  const items = chain.length > 0 ? chain[chain.length - 1].from : from;
  return Array.isArray(items) && isObj(items[0]) ? items[0] : fail('row_source');
}

interface Joins {
  /** Qualifiers per FROM item, pairwise disjoint. */
  quals: Set<string>[];
  /** S8 namespace per item: 0 for the left source, the table's last segment for a right base table. */
  spaces: string[];
  /** ON/USING equalities as pairs of `space\0column`. */
  pairs: [string, string][];
  usedKeys: string[];
}

const ref = (space: string, col: string) => `${space}\0${col}`;

/**
 * S6 for joins (outer select only): every `from[i > 0]` is a LEFT [OUTER] JOIN
 * of a fully named base table on a single equality, or USING one column, whose
 * right-side column is a declared unique key, so each left row matches at most
 * one right row and the joined rows are exactly the left rows.
 */
function checkJoins(from: unknown[], keys: Set<string>): Joins {
  const quals = from.map(itemQualifiers);
  const seen = new Set<string>();
  for (const q of quals) {
    if (q.size === 0) fail('row_source');
    for (const n of q) {
      if (seen.has(n)) fail('row_source');
      seen.add(n);
    }
  }
  const spaces = ['0'];
  const pairs: [string, string][] = [];
  const usedKeys: string[] = [];
  const srcOf = (qual: string) => quals.findIndex(q => q.has(qual));
  for (let i = 1; i < from.length; i++) {
    const item = from[i];
    if (!isObj(item) || typeof item.join !== 'string' || !LEFT_JOINS.has(item.join.toUpperCase())) return fail('row_source');
    if ('expr' in item || item.type === 'unnest' || !isEmpty(item.operator) || !onlyKeys(item, JOIN_ITEM_KEYS)) return fail('row_source');
    const full = fullName(item) ?? fail('row_source');
    // `LEFT JOIN f.rec.arr` whose head names an earlier range variable is a correlated array path (an UNNEST).
    if (quals.slice(0, i).some(q => q.has(full.split('.')[0].toLowerCase()))) fail('row_source');
    spaces.push(`t:${lastSegment(full)}`);
    let rightCol: string;
    if (!isEmpty(item.on) && isEmpty(item.using)) {
      const on = item.on;
      if (!isObj(on) || on.type !== 'binary_expr' || on.operator !== '=' || !onlyKeys(on, new Set(['type', 'operator', 'left', 'right', 'parentheses']))) {
        return fail('row_source');
      }
      const sides = [plainQualifiedRef(on.left), plainQualifiedRef(on.right)];
      if (sides.some(x => x === null)) return fail('row_source');
      const [a, b] = sides as [string, string][];
      const [ia, ib] = [srcOf(a[0]), srcOf(b[0])];
      const [right, left, il] = ia === i ? [a, b, ib] : ib === i ? [b, a, ia] : fail('row_source');
      if (il < 0 || il >= i) return fail('row_source');
      rightCol = right[1];
      pairs.push([ref(spaces[i], rightCol), ref(spaces[il], left[1])]);
    } else if (isEmpty(item.on) && Array.isArray(item.using) && item.using.length === 1) {
      const u = item.using[0];
      if (!isObj(u) || u.type !== 'default' || typeof u.value !== 'string' || !onlyKeys(u, new Set(['type', 'value']))) return fail('row_source');
      rightCol = u.value.toLowerCase();
      // USING may bind to any earlier source's column: link them all (over-approximation).
      for (let j = 0; j < i; j++) pairs.push([ref(spaces[i], rightCol), ref(spaces[j], rightCol)]);
    } else return fail('row_source');
    const key = `${full}.${rightCol}`;
    if (!keys.has(key)) fail('row_source');
    usedKeys.push(key);
  }
  return { quals, spaces, pairs, usedKeys };
}

/**
 * Every column an expression in a join query references, as `space\0column`.
 * Each ref must be qualified by one of the select's FROM items; an unqualified
 * ref (which could name any source's column, or a whole row), a foreign
 * qualifier (a struct column), or a `*` fails closed.
 */
function joinRefs(n: unknown, j: Joins): string[] {
  const out: string[] = [];
  some(n, o => {
    if (o.type !== 'column_ref') return false;
    const name = refName(o)?.toLowerCase() ?? null;
    const src = typeof o.table === 'string' ? j.quals.findIndex(q => q.has((o.table as string).toLowerCase())) : -1;
    if (name === null || name === '*' || src < 0) fail('where_on_dimension');
    out.push(ref(j.spaces[src], name!));
    return false;
  });
  return out;
}

/**
 * S8 for joins. A unique right key makes the whole right row a function of the
 * join key, so each right namespace (the same table joined twice shares one),
 * together with the left columns ON/USING-linked to it, is one dimension group
 * (one per ON/USING pair). When the dimension reaches a group, every column of
 * the group counts as dimension, iterated to a fixpoint so groups sharing a
 * namespace or left lineage (chained joins) are absorbed too. A WHERE on any
 * right column of the group, or (through the left source's lineage, at any
 * level) on a linked left column, rejects. This is deliberately coarse: a
 * WHERE on a right sibling rejects too.
 *
 * Worked example (customers.id and regions.id unique):
 *   FROM orders o LEFT JOIN customers c ON o.customer_id = c.id, GROUP BY c.region
 *     group {c.*, o.customer_id}: WHERE c.tier or WHERE o.customer_id rejects
 *     (it filters the dimension); WHERE o.status passes.
 *   ... LEFT JOIN regions r ON c.region_id = r.id, GROUP BY r.name
 *     group {r.*, c.region_id} reaches namespace c, so {c.*, o.customer_id} is
 *     absorbed: WHERE c.tier now rejects too; WHERE o.status still passes.
 */
function checkJoinWhereOnDimension(levels: Node[], dimExpr: unknown, where: unknown, j: Joins): void {
  const left = (r: string) => (r.startsWith('0\0') ? r.slice(2) : null);
  const space = (r: string) => r.slice(0, r.indexOf('\0'));
  type Group = { spaces: Set<string>; left: Set<string> };
  const groups: Group[] = j.pairs.map(pair => {
    const g: Group = { spaces: new Set(), left: new Set() };
    for (const r of pair) {
      const l = left(r);
      if (l === null) g.spaces.add(space(r));
      else g.left.add(l);
    }
    return g;
  });
  const leftAll = (names: Set<string>) => lineage(names, levels, 1);
  const overlaps = (a: Set<string>, b: Set<string>) => [...a].some(n => b.has(n));
  const dimSpaces = new Set<string>();
  const dimLeft = new Set<string>();
  for (const r of joinRefs(dimExpr, j)) {
    const l = left(r);
    if (l === null) dimSpaces.add(space(r));
    else dimLeft.add(l);
  }
  const touched = new Set<Group>();
  for (let changed = true; changed;) {
    changed = false;
    const dimAll = leftAll(dimLeft);
    for (const g of groups) {
      if (touched.has(g) || !(overlaps(g.spaces, dimSpaces) || overlaps(leftAll(g.left), dimAll))) continue;
      touched.add(g);
      g.spaces.forEach(x => dimSpaces.add(x));
      g.left.forEach(x => dimLeft.add(x));
      changed = true;
    }
  }
  const whereRefs = joinRefs(where, j);
  if (whereRefs.some(r => left(r) === null && dimSpaces.has(space(r)))) fail('where_on_dimension');
  checkWhereOnDimension(levels, dimLeft, new Set(whereRefs.flatMap(r => left(r) ?? [])));
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
  if (rows.some(r => typeof r[dimension] === 'string' && isTotalLikeLabel(r[dimension] as string))) fail('total_like_row');

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
  const keys = new Set((input.uniqueKeys ?? []).map(uniqueKeyCase));
  const distinctArgs: unknown[] | null = keys.size > 0 ? [] : null;
  const kind = measureKind(exprs[measIdx], fromQualifiers(sel), distinctArgs);

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
  const scope = parseCtes(sel.with);
  const joins = Array.isArray(sel.from) && sel.from.length > 1 ? checkJoins(sel.from, keys) : null;
  const leftFrom = joins === null ? sel.from : [(sel.from as unknown[])[0]];
  const chain = resolveSource(leftFrom, scope);
  const base = baseOf(leftFrom, chain);
  // The left base table joined again could be the same row as the right side, so
  // a WHERE on one could filter the other's dimension: fail closed.
  if (joins !== null && typeof base.table === 'string' && joins.spaces.includes(`t:${lastSegment(base.table)}`)) fail('row_source');
  // A right row repeats once per left row it matches, so a SUM over a right column totals a
  // per-left-row copy, not a real whole. In a join query a SUM may read only left-source columns.
  if (joins !== null && kind === 'sum') {
    some(exprs[measIdx], o => {
      if (o.type === 'column_ref' && !(typeof o.table === 'string' && joins.quals[0].has(o.table.toLowerCase()))) fail('sum_joined_column');
      return false;
    });
  }
  const usedKeys = new Set(joins?.usedKeys ?? []);
  for (const arg of distinctArgs ?? []) {
    const own = joins === null ? fromQualifiers(sel) : joins.quals[0];
    usedKeys.add(distinctKey(arg, own, joins === null, chain, base, keys) ?? fail('count_distinct'));
  }

  // S4 through the chain: a CTE or subquery can rename a non-additive column (`conversion_rate AS amt`),
  // so trace the SUM's names to the base columns and run the lexicon over every level.
  if (kind === 'sum') {
    const measNames = referencedNames(exprs[measIdx], fromQualifiers(sel)).map(n => n ?? fail('sum_non_additive_column'));
    for (const n of lineage(new Set(measNames), [sel, ...chain], 1)) {
      if (NON_ADDITIVE_COLUMN_RE.test(n)) fail('sum_non_additive_column');
    }
  }

  // S7
  if ([sel.where, ...chain.map(s => s.where)].some(hasSubquery)) fail('where_subquery');

  // S8
  if (joins !== null) checkJoinWhereOnDimension([sel, ...chain], dimExpr, sel.where, joins);
  else {
    const dimNames = new Set<string>([dimension.toLowerCase()]);
    if (aliases[dimIdx] !== null) dimNames.add(aliases[dimIdx]!.toLowerCase());
    for (const n of referencedNames(dimExpr, fromQualifiers(sel))) {
      if (n === null) fail('where_on_dimension');
      dimNames.add(n!);
    }
    checkWhereOnDimension([sel, ...chain], dimNames, new Set(namesOf(sel.where, fromQualifiers(sel))));
  }

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
    usedUniqueKeys: [...usedKeys].sort(),
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
