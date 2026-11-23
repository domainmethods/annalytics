import type { KnownBlock, SectionBlock } from '@slack/types';
import { unwrapBigQueryScalar } from '../execution/bigqueryScalar.js';
import { boundedText } from './limits.js';

/**
 * A one-line, answer-first sentence above a result table, computed in code
 * from the result rows (never by an LLM), so every number in it is a cell the
 * reader can find in the table below.
 *
 * It makes a RANK-ONLY claim ("X has the highest <measure> (n), followed by
 * Y (m)") and never a share or total: those need a provably additive measure
 * and an uncut denominator, which a result set alone cannot prove. When it
 * cannot prove even the ranking — a cut result, a tie at the top, a time
 * series, an ambiguous column shape — it says nothing, because a wrong
 * sentence is worse than none.
 */
export interface LeadInInput {
  /** Every returned row (not just the rows displayed), so the ranking covers the whole result. */
  rows: Record<string, unknown>[];
  columnNames: string[];
  /** True when the row cap cut the result: the real top row may be missing. */
  truncated: boolean;
  /** The executed SQL, checked for a LIMIT that may have cut rows. */
  sql: string;
}

const MAX_LABEL_LENGTH = 200;
const NUMERIC_TEXT = /^\d+(\.\d+)?$/;
const SIGNED_NUMERIC_TEXT = /^[+-]?\d+(\.\d+)?$/;
// ISO-ish dates, datetimes and times ("2026-11-01", "2026-11", "2026-11-01 10:00:00Z", "10:00").
const TEMPORAL_TEXT = /^(\d{4}-\d{2}(-\d{2})?([T ][\d:.]+)?(Z|[+-]\d{2}:?\d{2})?|\d{1,2}:\d{2}(:\d{2}(\.\d+)?)?)$/;

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
  const num = Number(text);
  return Number.isFinite(num) ? { text, num } : null;
}

/** A plain-text category label; null for anything numeric, temporal, empty or structured. */
function readLabel(val: unknown): string | null {
  // Objects are SDK wrappers (DATE/TIME/TIMESTAMP/INT64) or STRUCTs: never a category name.
  if (typeof val !== 'string') return null;
  const text = val.trim();
  if (text.length === 0 || text.length > MAX_LABEL_LENGTH || /[\r\n]/.test(text)) return null;
  if (SIGNED_NUMERIC_TEXT.test(text) || TEMPORAL_TEXT.test(text)) return null;
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
 */
function limitIsSafe(sql: string, rowCount: number, measureCol: string, measurePos: number): boolean {
  const code = sql
    .replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"/g, "''")
    .replace(/--[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\//g, ' ');
  if (/\bOFFSET\b/i.test(code)) return false;
  const cutting = [...code.matchAll(/\bLIMIT\s+(\d+)/gi)].filter((m) => rowCount >= Number(m[1]));
  if (cutting.length === 0) return true;
  if (cutting.length > 1) return false;
  const key = `(?:\`?(?:\\w+\\.)*\`?${escapeRegExp(measureCol)}\`?|${measurePos})`;
  const topN = new RegExp(`\\bORDER\\s+BY\\s+${key}\\s+DESC\\b[^()]*?\\bLIMIT\\s+${cutting[0][1]}\\s*;?\\s*$`, 'i');
  return topN.test(code);
}

function escapeMrkdwn(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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
  if (!limitIsSafe(sql, rows.length, measureCol[0], columnNames.indexOf(measureCol[0]) + 1)) return null;

  const ranked = rows
    .map((r) => ({ label: readLabel(r[labelCol[0]]) as string, measure: readMeasure(r[measureCol[0]]) as Measure }))
    .sort((a, b) => b.measure.num - a.measure.num);
  // Repeated labels mean un-aggregated rows: "Alice, followed by Alice" is not a ranking.
  if (new Set(ranked.map((r) => r.label)).size !== ranked.length) return null;
  const [first, second, third] = ranked;
  if (first.measure.num === second.measure.num) return null;

  const measureName = escapeMrkdwn(measureCol[0].replace(/_/g, ' ').trim().toLowerCase());
  const lead = `${emphasize(first.label)} has the highest ${measureName} (${first.measure.text})`;
  const runnerUpTied = third !== undefined && third.measure.num === second.measure.num;
  return runnerUpTied
    ? `${lead}.`
    : `${lead}, followed by ${escapeMrkdwn(second.label)} (${second.measure.text}).`;
}

/**
 * The caption above a result table: the computed lead-in when it is provable,
 * otherwise the generator's one-line headline (what the table represents), else
 * nothing.
 */
export function buildAnswerCaptionBlocks(input: LeadInInput & { headline?: string }): KnownBlock[] {
  const text = computeLeadIn(input) ?? input.headline?.trim();
  if (!text) return [];
  return [{ type: 'section', text: { type: 'mrkdwn', text: boundedText(text) } } as SectionBlock];
}
