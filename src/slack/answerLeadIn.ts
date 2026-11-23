import type { KnownBlock, SectionBlock } from '@slack/types';
import { unwrapBigQueryScalar } from '../execution/bigqueryScalar.js';
import type { EligibleComposition } from '../execution/composition.js';
import { isNumericColumnType } from '../execution/shares.js';
import { isTotalLikeLabel } from '../execution/totalLike.js';
import { boundedText, escapeMrkdwn, MAX_DISPLAY_ROWS } from './limits.js';

/**
 * A one-line, answer-first sentence above a result table, computed in code
 * from the result rows (never by an LLM), so every number in it is a cell the
 * reader can find in the table below.
 *
 * It makes a RANK claim ("X has the highest <measure> (n), followed by
 * Y (m)") and adds a share only from a `verifyComposition` proof (a provably
 * additive measure over an uncut denominator, which a result set alone cannot
 * prove). When it
 * cannot prove even the ranking — a cut result, a tie at the top, a time
 * series, an ambiguous column shape — it says nothing, because a wrong
 * sentence is worse than none. It also stays silent when a row it would name
 * sits past the displayed rows, so every number it quotes is on screen.
 */
export interface LeadInInput {
  /** Every returned row (not just the rows displayed), so the ranking covers the whole result. */
  rows: Record<string, unknown>[];
  columnNames: string[];
  /** True when the row cap cut the result: the real top row may be missing. */
  truncated: boolean;
  /** The executed SQL, checked for a LIMIT that may have cut rows. */
  sql: string;
  /** BigQuery type per column (aligned with columnNames). Required for a caption: the measure must be numeric and the label a STRING. */
  columnTypes?: string[];
  /** The leader's proven share label and its index in the ORIGINAL row order. */
  leaderShare?: { label: string; rowIndex: number };
}

const MAX_LABEL_LENGTH = 200;
const NUMERIC_TEXT = /^\d+(\.\d+)?$/;
const SIGNED_NUMERIC_TEXT = /^[+-]?\d+(\.\d+)?$/;
// ISO-ish dates, datetimes and times ("2026-11-01", "2026-11", "2026-11-01 10:00:00Z", "10:00").
const TEMPORAL_TEXT = /^(\d{4}-\d{2}(-\d{2})?([T ][\d:.]+)?(Z|[+-]\d{2}:?\d{2})?|\d{1,2}:\d{2}(:\d{2}(\.\d+)?)?)$/;
// Whole-label period names a STRING column can carry: "January", "Jan 2026", "Q1 2026", "2026-Q1", "2026-W03", "H2", "FY2026", "Monday".
const MONTH = '(?:january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept?|oct|nov|dec)';
const PERIOD_TEXT = new RegExp(
  `^(?:${MONTH}\\.?(?:[\\s,/-]+\\d{2,4})?|\\d{4}[\\s/-]*${MONTH}|\\d{4}[\\s/-]*(?:q[1-4]|h[12]|w\\d{1,2})|(?:q[1-4]|h[12]|w\\d{1,2}|week\\s*\\d{1,2})(?:[\\s/-]*\\d{2,4})?|fy\\s*\\d{2,4}|(?:mon|tues?|wed(?:nes)?|thu(?:rs)?|fri|sat(?:ur)?|sun)(?:day)?)$`,
  'i',
);

interface Measure { text: string; num: number }

/** A non-negative finite measure cell, keeping its original text; null otherwise. */
function readMeasure(val: unknown): Measure | null {
  if (typeof val === 'number') {
    return Number.isFinite(val) && val >= 0 ? { text: String(val), num: val } : null;
  }
  if (typeof val === 'bigint') {
    const num = Number(val);
    return val >= 0n && Number.isFinite(num) ? { text: val.toString(), num } : null;
  }
  let text: string;
  if (typeof val === 'string') {
    text = val;
  } else if (val !== null && typeof val === 'object' && !Array.isArray(val)) {
    // SDK INT64 wrappers hold text in `value`; big.js NUMERIC values stringify.
    const wrapped = unwrapBigQueryScalar(val);
    text = wrapped !== undefined ? String(wrapped) : String(val);
  } else {
    return null;
  }
  if (!NUMERIC_TEXT.test(text)) return null;
  // Ranking uses doubles: INT64 values above 2^53 that differ only in low digits compare equal, which reads as a tie (silence).
  const num = Number(text);
  return Number.isFinite(num) ? { text, num } : null;
}

/** A plain-text category label; null for anything numeric, temporal, empty or structured. */
function readLabel(val: unknown): string | null {
  // Objects are SDK wrappers (DATE/TIME/TIMESTAMP/INT64) or STRUCTs: never a category name.
  if (typeof val !== 'string') return null;
  const text = val.trim();
  if (text.length === 0 || text.length > MAX_LABEL_LENGTH || /[\r\n]/.test(text)) return null;
  if (SIGNED_NUMERIC_TEXT.test(text) || TEMPORAL_TEXT.test(text) || PERIOD_TEXT.test(text)) return null;
  // Trimmed, so bolding never wraps edge spaces ("* x *" renders literally).
  return text;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * True only when no LIMIT/OFFSET in the query can have dropped the real top
 * row. A LIMIT that returned fewer rows than its bound cut nothing. A LIMIT
 * that may have cut is accepted only as the query's final clause, directly
 * after an outer ORDER BY whose FIRST key is the measure (by name or 1-based
 * position) descending — a genuine top-N. A DESC elsewhere (a window, a CTE, a
 * tiebreaker, the label column) proves nothing, and any OFFSET may skip the top.
 * QUALIFY or any window (OVER, including a named WINDOW) also means silence: a ranked filter such as
 * `QUALIFY ROW_NUMBER() OVER (ORDER BY n) <= 3` cuts rows with no LIMIT at all.
 * The Share column has its own, stricter AST rule (composition.ts S5: a LIMIT must have
 * returned fewer rows than its bound); keep the two in step so a caption never treats as
 * whole a result the Share column treats as cut, or the reverse. This one stays a regex
 * on purpose: the caption is always on (no flag), and node-sql-parser rejects some valid
 * BigQuery (L2 is advisory for that reason), so an AST-only check would silence captions
 * on every query the parser can't read.
 */
/** The SQL with comments blanked and string literals emptied, for clause matching. */
function sqlCode(sql: string): string {
  // One pass, so a quote inside a comment ("-- don't") never opens a fake string
  // that swallows a real LIMIT/OFFSET, and a comment marker inside a string is inert.
  return sql.replace(
    // Backticked identifiers and triple-quoted strings are consumed whole, so a
    // quote inside them (`o'brien`) can't open a fake string that hides a LIMIT.
    // A backticked identifier keeps its word characters for the ORDER BY match.
    /--[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\/|`[^`]*`|'''[\s\S]*?'''|"""[\s\S]*?"""|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"/g,
    (m) => {
      if (m[0] === '`') return `\`${m.slice(1, -1).replace(/[^\w.]/g, '_')}\``;
      return m[0] === "'" || m[0] === '"' ? "''" : ' ';
    },
  );
}

function measureKeyPattern(measureCol: string, measurePos: number): string {
  // Each qualifier may be backticked on its own (`t`.`n`) or the path as one (`t.n`).
  return `(?:(?:\`?\\w+\`?\\.)*\`?${escapeRegExp(measureCol)}\`?|${measurePos})`;
}

/**
 * True when the query's outer ORDER BY sorts by the measure ascending (ASC, or
 * no direction): the asker wanted the smallest, so "X has the highest" would
 * lead with the opposite of the question.
 */
function sortsMeasureAscending(code: string, measureCol: string, measurePos: number): boolean {
  const keys = outerOrderByKeys(code);
  if (keys === null) return false;
  return new RegExp(`^${measureKeyPattern(measureCol, measurePos)}(?:\\s+ASC\\b|\\s*(?:,|\\bNULLS\\b|\\bLIMIT\\b|;|$))`, 'i').test(keys.trim());
}

/**
 * The text after the query's last ORDER BY at parenthesis depth 0, or null when there
 * is none. Depth, not "no parentheses to the end", so a sort key like LOWER(c) after
 * the measure can't hide the outer ORDER BY.
 */
function outerOrderByKeys(code: string): string | null {
  let depth = 0;
  let start = -1;
  const re = /[()]|\bORDER\s+BY\s+/gi;
  for (let m = re.exec(code); m !== null; m = re.exec(code)) {
    if (m[0] === '(') depth++;
    else if (m[0] === ')') depth = Math.max(0, depth - 1);
    else if (depth === 0) start = m.index + m[0].length;
  }
  return start < 0 ? null : code.slice(start);
}

function limitIsSafe(code: string, rowCount: number, measureCol: string, measurePos: number): boolean {
  if (/\b(?:OFFSET|QUALIFY|OVER|WINDOW)\b/i.test(code)) return false;
  const limits = code.match(/\bLIMIT\b/gi) ?? [];
  if (limits.length === 0) return true;
  // A LIMIT inside a CTE or subquery may have cut the rows that were aggregated, so the
  // final row count proves nothing about it. Only one LIMIT is accepted: the query's
  // trailing clause with a literal bound (LIMIT @n or LIMIT (5) proves nothing either).
  if (limits.length > 1) return false;
  const trailing = /\bLIMIT\s+(\d+)\s*;?\s*$/i.exec(code);
  if (!trailing) return false;
  if (rowCount < Number(trailing[1])) return true;
  const key = measureKeyPattern(measureCol, measurePos);
  const topN = new RegExp(`\\bORDER\\s+BY\\s+${key}\\s+DESC\\b[^()]*?\\bLIMIT\\s+${trailing[1]}\\s*;?\\s*$`, 'i');
  return topN.test(code);
}

/** Bold the label only when it holds no mrkdwn control characters that would break the bold. */
function emphasize(label: string): string {
  const escaped = escapeMrkdwn(label);
  return /[*_~`]/.test(label) ? escaped : `*${escaped}*`;
}

export function computeLeadIn(input: LeadInInput): string | null {
  const { rows, columnNames, truncated, sql } = input;
  if (truncated || rows.length < 2 || columnNames.length !== 2) return null;

  const measureCol = columnNames.filter((c) => rows.every((r) => readMeasure(r[c]) !== null));
  const labelCol = columnNames.filter((c) => rows.every((r) => readLabel(r[c]) !== null));
  if (measureCol.length !== 1 || labelCol.length !== 1 || measureCol[0] === labelCol[0]) return null;
  // BigQuery names an unaliased expression `f0_`, `f1_`, ...: "the highest f0" names nothing a reader asked about.
  if (/^f\d+_$/.test(measureCol[0])) return null;
  // Without the schema a numeric-looking STRING (a zip code) could pass as the measure, so unknown types mean silence.
  const types = input.columnTypes;
  if (!types || types.length !== columnNames.length) return null;
  if (!isNumericColumnType(types[columnNames.indexOf(measureCol[0])])) return null;
  // Stricter than the share proof, which picks its dimension by type alone: a BOOL
  // label can still get a Share column with no leader share in the caption.
  if (types[columnNames.indexOf(labelCol[0])] !== 'STRING') return null;
  const code = sqlCode(sql);
  const measurePos = columnNames.indexOf(measureCol[0]) + 1;
  if (!limitIsSafe(code, rows.length, measureCol[0], measurePos)) return null;
  // An ascending sort on the measure asked for the lowest: a "highest" lead would answer the opposite question.
  if (sortsMeasureAscending(code, measureCol[0], measurePos)) return null;

  const ranked = rows
    .map((r, index) => ({ index, label: readLabel(r[labelCol[0]]) as string, measure: readMeasure(r[measureCol[0]]) as Measure }))
    .sort((a, b) => b.measure.num - a.measure.num);
  // Repeated labels mean un-aggregated rows: "Alice, followed by Alice" is not a ranking.
  if (new Set(ranked.map((r) => r.label)).size !== ranked.length) return null;
  // A grand-total row (UNION ALL SELECT 'Total', ...) is the whole, not a contender.
  if (ranked.some((r) => isTotalLikeLabel(r.label))) return null;
  const [first, second, third] = ranked;
  if (first.measure.num === second.measure.num) return null;

  const measureName = escapeMrkdwn(measureCol[0].replace(/_/g, ' ').trim().toLowerCase());
  const share = input.leaderShare && input.leaderShare.rowIndex === first.index
    ? `, ${escapeMrkdwn(input.leaderShare.label)} of the total`
    : '';
  const lead = `${emphasize(first.label)} has the highest ${measureName} (${first.measure.text}${share})`;
  const runnerUpTied = third !== undefined && third.measure.num === second.measure.num;
  // The table shows the first MAX_DISPLAY_ROWS rows; never name a row past them.
  if (first.index >= MAX_DISPLAY_ROWS || (!runnerUpTied && second.index >= MAX_DISPLAY_ROWS)) return null;
  return runnerUpTied
    ? `${lead}.`
    : `${lead}, followed by ${escapeMrkdwn(second.label)} (${second.measure.text}).`;
}

/**
 * The caption above a result table: the computed lead-in when it is provable,
 * otherwise the generator's one-line headline (what the table represents), else
 * nothing.
 */
export function buildAnswerCaptionBlocks(input: Omit<LeadInInput, 'leaderShare'> & { headline?: string; composition?: EligibleComposition }): KnownBlock[] {
  const { composition, headline, ...leadInput } = input;
  const leaderShare = (composition && composition.shares.length === leadInput.rows.length && composition.topIndex !== null && composition.shares[composition.topIndex]
    ? { label: composition.shares[composition.topIndex].label, rowIndex: composition.topIndex }
    : undefined);
  // The headline is model text: escaped so "<!here>" or link syntax renders as written.
  const fallback = headline?.trim();
  const text = computeLeadIn({ ...leadInput, ...(leaderShare ? { leaderShare } : {}) }) ?? (fallback ? escapeMrkdwn(fallback) : undefined);
  if (!text) return [];
  return [{ type: 'section', text: { type: 'mrkdwn', text: boundedText(text) } } as SectionBlock];
}
