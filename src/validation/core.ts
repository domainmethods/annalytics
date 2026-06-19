import type { ValidationResult } from '../types.js';
import { staticAnalysis } from './staticAnalysis.js';
import { astValidation } from './astValidation.js';
import { dryRunValidation } from './dryRun.js';

/**
 * One record per validation layer attempt. Shared by every path that keeps a
 * validation trace (qualityLoop retries; routineFastPath single-pass). The
 * canonical definition lives here so the validation layer owns its own record
 * type; qualityLoop.ts re-exports it for existing importers.
 */
export interface ValidationLayerRecord {
  attempt: number;
  layer: 'l1' | 'l2' | 'l3' | 'l4';
  valid: boolean;
  detail?: string;
  bytesProcessed?: number;
}

/** Build a layer record from a raw ValidationResult. */
export function toLayerRecord(
  attempt: number,
  layer: ValidationLayerRecord['layer'],
  result: ValidationResult,
): ValidationLayerRecord {
  return {
    attempt,
    layer,
    valid: result.valid,
    detail: result.error,
    bytesProcessed: result.bytesProcessed,
  };
}

/**
 * Outcome of running the core L1→L2→L3 ladder once.
 *
 * L2 (AST) is advisory: it is always recorded but never blocks. L4 (cost gate)
 * is intentionally NOT here — it is policy applied per-path (inline for
 * single-pass paths; once after the retry loop in qualityLoop).
 */
export interface CoreValidationOutcome {
  /** l1, l2, l3 records in order, each stamped with `attempt`. */
  records: ValidationLayerRecord[];
  /** Discriminant of which layer blocked, or null when L1 and L3 both passed. */
  blockedLayer: 'l1' | 'l3' | null;
  /** The blocking layer's raw result (L1 or L3), or null when nothing blocked. */
  blocked: ValidationResult | null;
  /** Dry-run bytes when L3 passed; undefined when blocked before L3 succeeded. */
  bytesProcessed?: number;
}

/**
 * Run L1 (static) → L2 (AST, advisory) → L3 (dry run) exactly once. Single
 * source of truth for the layer sequence; callers add L4 plus their own
 * failure-history / return shaping.
 */
export async function runCoreValidation(
  sql: string,
  attempt: number,
): Promise<CoreValidationOutcome> {
  const records: ValidationLayerRecord[] = [];

  const l1 = staticAnalysis(sql);
  records.push(toLayerRecord(attempt, 'l1', l1));
  if (!l1.valid) {
    return { records, blockedLayer: 'l1', blocked: l1 };
  }

  const l2 = astValidation(sql);
  records.push(toLayerRecord(attempt, 'l2', l2));

  const l3 = await dryRunValidation(sql);
  records.push(toLayerRecord(attempt, 'l3', l3));
  if (!l3.valid) {
    return { records, blockedLayer: 'l3', blocked: l3 };
  }

  return { records, blockedLayer: null, blocked: null, bytesProcessed: l3.bytesProcessed ?? 0 };
}
