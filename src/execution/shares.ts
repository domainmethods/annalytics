import { unwrapBigQueryScalar } from './bigqueryScalar.js';

export interface ShareCell { basisPoints: number; label: string }
export type SharesResult =
  | { ok: true; total: string; shares: ShareCell[] }
  | { ok: false; reason: 'measure_value' | 'negative_value' | 'zero_total' };

const MAX_SCALE = 38;
const INT_RE = /^-?\d+$/;
const DEC_RE = /^-?\d+(\.\d+)?$/;

type Kind = 'int' | 'decimal';

/** Maps BigQuery type names (including legacy REST names) to a parse kind. */
function kindOf(type: string): Kind | null {
  switch (type.toUpperCase()) {
    case 'INT64':
    case 'INTEGER':
      return 'int';
    case 'NUMERIC':
    case 'BIGNUMERIC':
    case 'FLOAT64':
    case 'FLOAT':
      return 'decimal';
    default:
      return null;
  }
}

/**
 * Returns the exact decimal text of a BigQuery numeric cell, or null when it
 * cannot be represented exactly (non-numeric, non-finite, exponent notation,
 * unsupported type).
 */
export function toExactDecimal(val: unknown, type: string): string | null {
  const kind = kindOf(type);
  if (kind === null || val === null || val === undefined) return null;
  let text: string | null = null;
  if (typeof val === 'number') {
    if (!Number.isFinite(val)) return null;
    if (kind === 'int' && !Number.isSafeInteger(val)) return null;
    text = String(val);
  } else if (typeof val === 'string') {
    text = val;
  } else if (typeof val === 'bigint') {
    text = String(val);
  } else if (typeof val === 'object' && !Array.isArray(val)) {
    const inner = unwrapBigQueryScalar(val);
    // Wrapped values take the same validation path as bare ones.
    // unwrapBigQueryScalar only returns primitives, so `inner === val` is
    // unreachable today; the guard keeps the recursion fail-closed if that changes.
    if (inner !== undefined) return (inner as unknown) === val ? null : toExactDecimal(inner, type);
    text = String(val);
  }
  if (text === null) return null;
  return (kind === 'int' ? INT_RE : DEC_RE).test(text) ? text : null;
}

function roundHalfUp(num: bigint, den: bigint): bigint {
  return (2n * num + den) / (2n * den);
}

function parseScaled(text: string, scale: number): bigint {
  const neg = text.startsWith('-');
  const [intPart, frac = ''] = (neg ? text.slice(1) : text).split('.');
  const magnitude = BigInt(intPart + frac.padEnd(scale, '0'));
  return neg ? -magnitude : magnitude;
}

function formatScaled(v: bigint, scale: number): string {
  if (scale === 0) return v.toString();
  const digits = v.toString().padStart(scale + 1, '0');
  return `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
}

function label(v: bigint, total: bigint): string {
  if (v === 0n) return '0%';
  if (v === total) return '100%';
  if (200n * v < total) return '<1%';
  if (200n * v >= 199n * total) return '>99%';
  return `${roundHalfUp(100n * v, total)}%`;
}

/** Exact share of each value in their sum; never uses floating-point arithmetic. */
export function computeShares(values: unknown[], type: string): SharesResult {
  const texts: string[] = [];
  for (const v of values) {
    const t = toExactDecimal(v, type);
    if (t === null) return { ok: false, reason: 'measure_value' };
    texts.push(t);
  }
  const scale = Math.max(0, ...texts.map(t => (t.split('.')[1] ?? '').length));
  if (scale > MAX_SCALE) return { ok: false, reason: 'measure_value' };
  const scaled = texts.map(t => parseScaled(t, scale));
  if (scaled.some(v => v < 0n)) return { ok: false, reason: 'negative_value' };
  const total = scaled.reduce((a, b) => a + b, 0n);
  if (total === 0n) return { ok: false, reason: 'zero_total' };
  return {
    ok: true,
    total: formatScaled(total, scale),
    shares: scaled.map(v => ({
      basisPoints: Number(roundHalfUp(10000n * v, total)),
      label: label(v, total),
    })),
  };
}
