import type { ModelTier } from '../src/agents/modelConfig.js';
import type { ThinkingLevel } from '../src/agents/nodeProfiles.js';

// ── Judge-free sizing for data-invariant (universal) classifier nodes ────────
//
// Unlike the SQL-path sweep, these nodes emit an OBJECTIVE label (a route or an
// intent), so correctness is exact-match against a hand-labeled corpus — no LLM
// judge, and therefore none of the holistic-score noise (ε≈2.85) that makes the
// supervisor node unsizable. That lets us tune them with a simple "floor-up"
// rule: take the cheapest ladder rung that still classifies correctly.

/** One graded prediction: what the corpus says vs. what the model emitted. */
export interface Prediction {
  expected: string;
  predicted: string;
}

/** A ladder rung's measured accuracy, carrying enough to write it back as a profile. */
export interface RungAccuracy {
  rung: string;
  tier: ModelTier;
  version: string;
  thinkingLevel: ThinkingLevel;
  accuracy: number;
}

export interface FloorUpResult {
  chosen: RungAccuracy;
  /** True when `chosen` actually cleared the threshold (vs. a best-effort fallback). */
  metThreshold: boolean;
}

/** Fraction of predictions that exactly match their label. Empty set → 0 (not NaN). */
export function accuracy(predictions: Prediction[]): number {
  if (predictions.length === 0) return 0;
  const hits = predictions.reduce((n, p) => (p.predicted === p.expected ? n + 1 : n), 0);
  return hits / predictions.length;
}

/**
 * Floor-up pick: the CHEAPEST rung whose accuracy clears `threshold`.
 *
 * `rungs` MUST be ordered cheapest → most expensive (the natural DEFAULT_LADDER
 * order), because "cheapest that passes" is just "first that passes" over that
 * ordering. If no rung clears the threshold, fall back to the highest-accuracy
 * rung, tie-breaking to the cheapest (earliest) — and flag `metThreshold:false`
 * so the caller surfaces it as a non-confident pick rather than a clean win.
 */
export function pickFloorUp(rungs: RungAccuracy[], threshold: number): FloorUpResult {
  if (rungs.length === 0) {
    throw new Error('pickFloorUp: empty ladder — nothing to choose from');
  }

  const passing = rungs.find((r) => r.accuracy >= threshold);
  if (passing) {
    return { chosen: passing, metThreshold: true };
  }

  // No rung passed. Pick the best accuracy; on a tie, the earliest (cheapest)
  // rung wins because we only replace `best` on a STRICT improvement.
  let best = rungs[0];
  for (const r of rungs) {
    if (r.accuracy > best.accuracy) best = r;
  }
  return { chosen: best, metThreshold: false };
}
