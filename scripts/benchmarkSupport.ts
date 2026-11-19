import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { Parser, type LocationRange, type Select } from 'node-sql-parser';
import type { GroundingCitation } from '../src/agents/types.js';
import type { FailureRecord, QualityResult, ValidationLayerRecord } from '../src/qualityLoop.js';
import {
  extractReferenceIdsFromCitations as extractCitationReferenceIds,
  extractTeachingIdsFromCitations as extractCitationTeachingIds,
} from '../src/agents/grounding.js';

export interface BenchmarkMetadataInput {
  packageJson: string;
  corpusRaw: string;
  manifestRaw?: string | null;
  catalogRaw?: string | null;
  gitSha?: string | null;
  gitDirty?: boolean;
  geminiModel?: string | null;
  judgeModel?: string | null;
  fileSearchStoreId?: string | null;
  gcpProjectId?: string | null;
  runStartedAt?: string;
}

function sha256(value: string | null | undefined): string | null {
  if (value == null) return null;
  return createHash('sha256').update(value).digest('hex');
}

function safeGit(args: string[], cwd: string): string | null {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
  } catch {
    return null;
  }
}

export function getGitSha(cwd = process.cwd()): string | null {
  return safeGit(['rev-parse', 'HEAD'], cwd);
}

export function getGitDirty(cwd = process.cwd()): boolean {
  const status = safeGit(['status', '--porcelain'], cwd);
  return status != null && status.length > 0;
}

// Implementations drop a gitignored corpus.live.json next to the template corpus; prefer it so acceptance runs use the real schema without dirtying the pinned template corpus.
export async function resolveCorpusPath(
  root: string,
  fileExists: (path: string) => Promise<boolean>,
): Promise<string> {
  const livePath = join(root, 'benchmarks', 'corpus.live.json');
  if (await fileExists(livePath)) return livePath;
  return join(root, 'benchmarks', 'corpus.json');
}

/**
 * Resolve a results path that never overwrites an earlier same-day run. Same-day
 * re-runs are the normal repair cadence; collide-suffix (-run2, -run3, ...)
 * instead of clobbering evidence. The `exists` predicate is injected so this is
 * pure and unit-testable.
 */
export async function resolveCollisionFreeResultPath(
  resultsDir: string,
  runDate: string,
  exists: (path: string) => Promise<boolean>,
): Promise<string> {
  let outputPath = join(resultsDir, `${runDate}.json`);
  for (let n = 2; await exists(outputPath); n++) {
    outputPath = join(resultsDir, `${runDate}-run${n}.json`);
  }
  return outputPath;
}

// The judge attaches corpus expectations (expected tables/fragments) to each result;
// a corpus file that differs from the one the benchmark ran with would attach the
// wrong expectations silently, so callers verify the run's recorded hash first.
export function corpusHashMatches(corpusRaw: string, recordedHash: string | null | undefined): boolean {
  if (!recordedHash) return true;
  return sha256(corpusRaw) === recordedHash;
}

export function buildBenchmarkMetadata(input: BenchmarkMetadataInput) {
  let packageVersion = 'unknown';
  try {
    const parsed = JSON.parse(input.packageJson) as { version?: string };
    packageVersion = parsed.version || packageVersion;
  } catch {
    packageVersion = 'unknown';
  }

  const runStartedAt = input.runStartedAt ?? new Date().toISOString();

  return {
    runId: `benchmark_${runStartedAt.replace(/[:.]/g, '-')}`,
    runStartedAt,
    gitSha: input.gitSha ?? null,
    gitDirty: input.gitDirty ?? false,
    packageVersion,
    corpusHash: sha256(input.corpusRaw)!,
    dbtManifestHash: sha256(input.manifestRaw),
    dbtCatalogHash: sha256(input.catalogRaw),
    geminiModel: input.geminiModel ?? null,
    judgeModel: input.judgeModel ?? null,
    fileSearchStoreId: input.fileSearchStoreId ?? null,
    gcpProjectId: input.gcpProjectId ?? null,
  };
}

export function validationResultsFromFailures(
  failureHistory: FailureRecord[],
  verdict: QualityResult['verdict'],
  validationHistory: ValidationLayerRecord[] = [],
): { l1: boolean; l2: boolean; l3: boolean; l4: boolean } {
  if (validationHistory.length > 0) {
    const finalAttempt = Math.max(...validationHistory.map(result => result.attempt));
    const finalHistory = validationHistory.filter(result => result.attempt === finalAttempt);
    const hasLayer = (layer: ValidationLayerRecord['layer']) =>
      finalHistory.some(result => result.layer === layer);
    const layerPassed = (layer: ValidationLayerRecord['layer']) =>
      finalHistory.some(result => result.layer === layer && result.valid);

    return {
      l1: layerPassed('l1'),
      l2: hasLayer('l2') ? layerPassed('l2') : true,
      l3: layerPassed('l3'),
      l4: hasLayer('l4') ? layerPassed('l4') : verdict !== 'cost_exceeded',
    };
  }

  if (verdict === 'pass' || verdict === 'fail_then_pass') {
    return { l1: true, l2: true, l3: true, l4: true };
  }

  if (verdict === 'cost_exceeded') {
    return { l1: true, l2: true, l3: true, l4: false };
  }

  const lastFailure = failureHistory[failureHistory.length - 1];
  return {
    l1: !lastFailure || lastFailure.failureType !== 'structural',
    l2: true,
    l3: !lastFailure || (lastFailure.failureType !== 'structural' && lastFailure.failureType !== 'dry_run'),
    l4: true,
  };
}

// Compact, deterministic per-attempt failure trace for the acceptance report.
// Only failing layers appear; L2 is marked advisory (visible, never blocking).
export function formatValidationTrace(history: ValidationLayerRecord[] = []): string {
  return history
    .filter(r => !r.valid)
    .map(r => {
      const advisory = r.layer === 'l2' ? ' advisory' : '';
      const detail = r.detail ? ` (${r.detail})` : '';
      return `a${r.attempt} ${r.layer.toUpperCase()}✗${advisory}${detail}`;
    })
    .join('; ');
}

export function extractReferenceIdsFromCitations(
  citations: Pick<GroundingCitation, 'sourceFile' | 'chunkText' | 'relevanceScore'>[],
): string[] {
  return extractCitationReferenceIds(citations);
}

export function combineReferenceIds(...groups: Array<string[] | undefined>): string[] {
  return [...new Set(groups.flatMap(group => group ?? []))].sort();
}

export function referenceRetrievalSource(
  referenceProbeIds: string[],
  sqlGroundingIds: string[],
): 'explicit_probe' | 'sql_grounding' | 'none' {
  if (referenceProbeIds.length > 0) return 'explicit_probe';
  if (sqlGroundingIds.length > 0) return 'sql_grounding';
  return 'none';
}

export function referenceRetrievalPassed(
  expectedReferenceIds: string[] | undefined,
  observedReferenceIds: string[],
): boolean | null {
  if (!expectedReferenceIds || expectedReferenceIds.length === 0) return null;
  const observed = new Set(observedReferenceIds);
  return expectedReferenceIds.every(id => observed.has(id));
}

export function extractTeachingIdsFromCitations(
  citations: Pick<GroundingCitation, 'sourceFile' | 'chunkText' | 'relevanceScore'>[],
): string[] {
  return extractCitationTeachingIds(citations);
}

// Same shape as referenceRetrievalPassed: null when nothing expected, else
// "every expected id observed". Keeps the two retrieval signals symmetric.
export function teachingRetrievalPassed(
  expectedTeachingIds: string[] | undefined,
  observedTeachingIds: string[],
): boolean | null {
  if (!expectedTeachingIds || expectedTeachingIds.length === 0) return null;
  const observed = new Set(observedTeachingIds);
  return expectedTeachingIds.every(id => observed.has(id));
}

export function teachingComplianceLabel(passed: boolean | null): string {
  if (passed === null) return 'no_relevant_teaching';
  return passed ? 'followed' : 'missed';
}

class UnscorableSqlError extends Error {}

const benchmarkSqlParser = new Parser();
const quotedIdentifier = /`[^`\\]+`/.source;
const comment = /--[^\r\n]*|#[^\r\n]*|\/\*[\s\S]*?\*\//.source;
const stringBody = [
  /'''(?:\\[\s\S]|'(?!'')|[^'\\])*'''/,
  /"""(?:\\[\s\S]|"(?!"")|[^"\\])*"""/,
  /'(?!'')(?:\\[^\r\n]|[^'\\\r\n])*'/,
  /"(?!"")(?:\\[^\r\n]|[^"\\\r\n])*"/,
].map(pattern => pattern.source).join('|');
const literal = `(?:br|rb|[br])?(?:${stringBody})`;
const sqlSpans = new RegExp([
  quotedIdentifier,
  String.raw`(${literal}(?:(?:\s|${comment})+${literal})*)`,
  `(${comment})`,
  /(['"`]|\/\*)/.source,
  /[a-z_]\w*/.source,
].join('|'), 'gi');
const namePart = String.raw`(?:${quotedIdentifier}|[a-z_][\w-]*)`;
const tablePath = String.raw`${namePart}(?:\s*\.\s*${namePart}){0,2}`;
const bigQueryParserGaps = new RegExp([
  String.raw`(\bWITH\s+RECURSIVE)(?=\s+${namePart}\s+AS\s*\()`,
  // project.dataset.INFORMATION_SCHEMA.VIEW (or project.`region-us`...) has one more part than the parser accepts.
  String.raw`(?<![\w.\x60-])(${namePart}\s*\.\s*${namePart}\s*\.\s*(?:\x60INFORMATION_SCHEMA\x60|INFORMATION_SCHEMA)\s*\.\s*${namePart})(?![\w\x60-]|\s*\.)`,
  String.raw`(${quotedIdentifier})(?=\s+AS\s*\()`,
  String.raw`(\bML\s*\.\s*\w+\s*\(\s*)MODEL\s+${tablePath}(?=\s*[,)])`,
  String.raw`([(,])\s*TABLE\s+(${tablePath})(?=\s*[,)])`,
  // Clauses the parser rejects but which never name a relation.
  /\b(?:IGNORE|RESPECT)\s+NULLS\b|\bNULLS\s+(?:FIRST|LAST)\b|\bTABLESAMPLE\s+SYSTEM\s*\([^()]*\)/.source,
  quotedIdentifier,
].join('|'), 'gi');

/** Empties string literals and blanks comments; quoted identifiers are kept. */
function scrubLiteralsAndComments(sql: string): string {
  return sql.replace(sqlSpans, (token, value, ignoredComment, unterminated) => {
    if (unterminated) throw new UnscorableSqlError('SQL has an unsupported or unterminated quoted token');
    if (value) return "''";
    return ignoredComment ? ' ' : token;
  });
}

function prepareBenchmarkSql(sql: string): string {
  // Keep quotes and comments opaque while adapting syntax absent from the installed parser.
  const scrubbed = scrubLiteralsAndComments(sql);
  const adapted = scrubbed.replace(
    bigQueryParserGaps,
    (token, recursive, schemaPath, cte, mlPrefix, separator, inputTable) => {
      if (recursive) return 'WITH /*recursive*/';
      if (schemaPath) return `\`${schemaPath.replace(/[`\s]/g, '')}\``;
      if (cte) return JSON.stringify(cte.slice(1, -1));
      if (mlPrefix) return `${mlPrefix}NULL`;
      if (separator) return `${separator}(SELECT * FROM ${inputTable})`;
      if (token.startsWith('`')) return token;
      return ' '.repeat(token.length);
    },
  );
  return neutralizeAggregateModifiers(adapted);
}

const sqlTokens = /`[^`]*`|'[^']*'|"[^"]*"|[()]|[a-z_]\w*|\S/gi;
// Words that open a parenthesis without making it a function call (window specs, joins, IN lists).
const nonCallWords = new Set(['as', 'over', 'in', 'from', 'join', 'on', 'using', 'exists', 'unnest', 'values']);

/**
 * The parser rejects ORDER BY / LIMIT (and some DISTINCT) inside aggregate calls (ARRAY_AGG, STRING_AGG, ...).
 * Neither can name a relation unless it holds a subquery, so blank that tail of the call;
 * when it does hold a subquery, keep the expressions as extra call arguments instead.
 */
function neutralizeAggregateModifiers(source: string): string {
  const tokens = [...source.matchAll(sqlTokens)].map(match => ({
    text: match[0],
    word: /^[a-z_]/i.test(match[0]) ? match[0].toLowerCase() : null,
    start: match.index,
  }));
  const chars = source.split(''); // UTF-16 units, matching match.index
  const frames: Array<{ call: boolean; tail: number | null }> = [];

  tokens.forEach((token, index) => {
    if (token.text === '(') {
      const previous = tokens[index - 1]?.word;
      const next = tokens[index + 1];
      const call = previous != null && !nonCallWords.has(previous)
        && next?.text !== '(' && next?.word !== 'select' && next?.word !== 'with';
      frames.push({ call, tail: null });
      // ARRAY_AGG(DISTINCT x) and STRING_AGG(DISTINCT x, ', ') are also rejected.
      if (call && next?.word === 'distinct') {
        for (let at = next.start; at < next.start + next.text.length; at++) chars[at] = ' ';
      }
      return;
    }
    const frame = frames.at(-1);
    if (token.text === ')') {
      frames.pop();
      if (!frame || frame.tail === null) return;
      const tail = tokens.slice(frame.tail, index);
      const tailEnd = token.start;
      const tailStart = tail[0].start;
      if (!tail.some(item => item.word === 'select')) {
        for (let at = tailStart; at < tailEnd; at++) chars[at] = ' ';
        return;
      }
      // Rewrite only the modifier keywords that sit directly inside this call.
      let depth = 0;
      for (const item of tail) {
        if (item.text === '(') depth++;
        else if (item.text === ')') depth--;
        else if (depth === 0 && item.word && ['order', 'limit', 'by', 'asc', 'desc'].includes(item.word)) {
          const replacement = item.word === 'order' || item.word === 'limit' ? ',' : ' ';
          chars[item.start] = replacement;
          for (let at = item.start + 1; at < item.start + item.text.length; at++) chars[at] = ' ';
        }
      }
      return;
    }
    if (!frame?.call || frame.tail !== null) return;
    const startsOrderBy = token.word === 'order' && tokens[index + 1]?.word === 'by';
    if (startsOrderBy || token.word === 'limit') frame.tail = index;
  });

  return chars.join('');
}

interface BigQueryFromItem {
  type?: string;
  db?: string | null;
  schema?: string;
  table?: string;
  surround?: { table?: string };
  as?: string | { value: string } | null;
  expr?: unknown;
}

export function warehouseRelations(sql: string): string[] {
  const options = { database: 'BigQuery', trimQuery: false, parseOptions: { includeLocations: true } };
  let source = prepareBenchmarkSql(sql);
  let patchedThrough = 0;
  let ast;
  for (;;) {
    try {
      ast = benchmarkSqlParser.astify(source, options);
      break;
    } catch (error) {
      // After a bare FROM item, the parser can consume QUALIFY as an alias.
      const offset = (error as { location?: LocationRange }).location?.start.offset ?? 0;
      const qualify = /\bQUALIFY\s*$/i.exec(source.slice(0, offset));
      if (!qualify || qualify.index < patchedThrough) throw error;
      const where = 'WHERE TRUE ';
      source = source.slice(0, qualify.index) + where + source.slice(qualify.index);
      patchedThrough = qualify.index + where.length + 'QUALIFY'.length;
    }
  }

  const statements = Array.isArray(ast) ? ast : [ast];
  // Anything but one SELECT is a definite miss, never unscorable.
  if (statements.length !== 1 || statements[0]?.type !== 'select') return [];

  const relations = new Set<string>();
  function visit(value: unknown, ctes: ReadonlySet<string>, outerAliases: ReadonlySet<string>): void {
    if (!value || typeof value !== 'object') return;
    if (!('type' in value) || value.type !== 'select') {
      for (const child of Object.values(value)) visit(child, ctes, outerAliases);
      return;
    }

    const { with: definitions, from, _next, loc, parentheses_symbol, ...expressions } = value as Select;
    const visibleCtes = new Set(ctes);
    const recursive = loc && source.startsWith('WITH /*recursive*/', loc.start.offset);
    const cteDefinitions = (definitions ?? []).map(({ name, stmt }) => ({
      // The parser retains escaped double quotes in normalized CTE declarations.
      name: name.value.replace(/\\"/g, '"').toLowerCase(),
      stmt,
    }));
    if (recursive) {
      for (const { name } of cteDefinitions) visibleCtes.add(name);
    }
    for (const { name, stmt } of cteDefinitions) {
      visit(stmt, visibleCtes, outerAliases);
      visibleCtes.add(name);
    }

    const aliases = new Set(outerAliases);
    for (const item of (from ?? []) as BigQueryFromItem[]) {
      const { type, table, db, schema, surround, as, expr, ...clauses } = item;
      const path = [db, schema, table].filter(Boolean).join('.').toLowerCase();
      const parts = path.split('.');
      const quotedPath = !db && surround?.table === '`';
      const arrayPath = parts.length > 1 && !quotedPath && aliases.has(parts[0]);
      if (table && !arrayPath && (db || !visibleCtes.has(path))) relations.add(path);

      visit(expr, visibleCtes, type === 'unnest' ? aliases : outerAliases);
      const alias = typeof as === 'string' ? as : as?.value ?? parts.at(-1);
      if (alias) aliases.add(alias.toLowerCase());
      visit(clauses, visibleCtes, aliases);
    }

    for (const expression of Object.values(expressions)) visit(expression, visibleCtes, aliases);
    // The parser links set branches as siblings. A WITH inside parentheses stays local.
    visit(_next, parentheses_symbol ? ctes : visibleCtes, outerAliases);
  }

  visit(statements[0], new Set(), new Set());
  return [...relations];
}

export interface TableReferenceAnalysis {
  observedTables: string[];
  /** Set when the SQL could not be resolved to relations, so table selection cannot be scored. */
  unscorableReason: string | null;
}

export function analyzeTablesInSql(
  sql: string | null | undefined,
  knownTables: string[],
): TableReferenceAnalysis {
  // Missing, blank or comment-only SQL is a real miss, not an unscorable one.
  if (!sql?.trim() || knownTables.length === 0) return { observedTables: [], unscorableReason: null };
  let relations: string[];
  try {
    relations = isSingleSelectText(sql) ? warehouseRelations(sql) : [];
  } catch (error) {
    return { observedTables: [], unscorableReason: unscorableReasonFor(error) };
  }
  // A short expectation can match a longer path. Missing qualifiers cannot be inferred.
  const observedTables = [...new Set(knownTables.filter(table => {
    const name = normalizeTableName(table);
    return name && relations.some(ref => ref === name || ref.endsWith(`.${name}`));
  }))];
  return { observedTables, unscorableReason: null };
}

function normalizeTableName(table: string): string {
  return table.toLowerCase().replace(/`/g, '').trim();
}

/**
 * Checks statement shape without the parser, so DML or multi-statement SQL the
 * parser cannot read still scores as a miss. A failed scrub defers to the parser.
 */
function isSingleSelectText(sql: string): boolean {
  let text: string;
  try {
    text = scrubLiteralsAndComments(sql).trim().replace(/(?:\s*;)+$/, '');
  } catch {
    return true;
  }
  if (text.length === 0 || text.includes(';')) return false;
  return /^(?:\(\s*)*(?:SELECT|WITH)\b/i.test(text);
}

/**
 * Text-level presence check for SQL the parser rejected. Literals and comments are
 * scrubbed, so a table named only there is absent. Presence is necessary for a pass,
 * never sufficient; an unscrubbable query proves nothing and counts as absent.
 */
function expectedTablesAppearInText(sql: string, expectedTables: string[]): boolean {
  let text: string;
  try {
    text = scrubLiteralsAndComments(sql).toLowerCase().replace(/`/g, '').replace(/\s*\.\s*/g, '.');
  } catch {
    return false;
  }
  return expectedTables.every(table => {
    const name = normalizeTableName(table);
    if (!name) return false;
    // Same suffix rule as relation matching: a preceding qualifier (".") is allowed.
    // A trailing "." means a qualified column (table.col), never a relation reference.
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?<![\\w-])${escaped}(?![\\w.-])`).test(text);
  });
}

function unscorableReasonFor(error: unknown): string {
  if (error instanceof UnscorableSqlError) return error.message;
  const start = (error as { location?: LocationRange }).location?.start;
  return start
    ? `SQL parser could not resolve table references (line ${start.line}, column ${start.column})`
    : 'SQL parser could not resolve table references';
}

/** Uncertain SQL earns no table credit; use analyzeTablesInSql to tell that apart from a miss. */
export function extractTablesFromSql(sql: string | null | undefined, knownTables: string[]): string[] {
  return analyzeTablesInSql(sql, knownTables).observedTables;
}

export interface TableSelectionScore {
  observedTables: string[];
  tableSelectionPassed: boolean | null;
  tableSelectionUnscorableReason?: string;
}

/**
 * Scores table selection for a generated query. SQL the parser cannot resolve is
 * unscorable (null plus a reason) only when every expected table still appears in
 * its text; an expected table that is provably absent is a definite miss (false).
 */
export function scoreTableSelection(
  expectedTables: string[] | undefined,
  sql: string | null | undefined,
  knownTables: string[],
): TableSelectionScore {
  const { observedTables, unscorableReason } = analyzeTablesInSql(sql, knownTables);
  if (unscorableReason && sql && expectedTables && expectedTables.length > 0
    && expectedTablesAppearInText(sql, expectedTables)) {
    return { observedTables, tableSelectionPassed: null, tableSelectionUnscorableReason: unscorableReason };
  }
  return { observedTables, tableSelectionPassed: tableSelectionPassed(expectedTables, observedTables) };
}

export function tableSelectionPassed(
  expectedTables: string[] | undefined,
  observedTables: string[],
): boolean | null {
  if (!expectedTables || expectedTables.length === 0) return null;
  const observed = new Set(observedTables.map(table => table.toLowerCase()));
  return expectedTables.every(table => observed.has(table.toLowerCase()));
}

export function sqlShapePassed(
  expectedSqlContains: string[] | undefined,
  generatedSql: string | null,
): boolean | null {
  if (!expectedSqlContains || expectedSqlContains.length === 0) return null;
  if (!generatedSql) return false;
  const normalizedSql = normalizeSqlFragment(generatedSql);
  const identifierTolerantSql = stripIdentifierQualifiers(normalizedSql);
  return expectedSqlContains.every(fragment =>
    normalizedSql.includes(normalizeSqlFragment(fragment))
    || (
      !fragment.includes('.')
      && identifierTolerantSql.includes(stripIdentifierQualifiers(normalizeSqlFragment(fragment)))
    ),
  );
}

export function clarificationPassed(
  expectedConfidence: 'high' | 'medium' | 'low' | undefined,
  observedConfidence: 'high' | 'medium' | 'low' | undefined,
): boolean | null {
  if (!expectedConfidence) return null;
  return observedConfidence === expectedConfidence;
}

function normalizeSqlFragment(value: string): string {
  return value.toLowerCase().replace(/`/g, '').replace(/\s+/g, ' ').trim();
}

function stripIdentifierQualifiers(value: string): string {
  let previous = value;
  let next = previous.replace(/\b[a-z_][a-z0-9_]*\s*\.\s*([a-z_][a-z0-9_]*)\b/g, '$1');
  while (next !== previous) {
    previous = next;
    next = previous.replace(/\b[a-z_][a-z0-9_]*\s*\.\s*([a-z_][a-z0-9_]*)\b/g, '$1');
  }
  return next;
}
