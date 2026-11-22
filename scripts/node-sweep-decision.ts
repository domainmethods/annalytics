import type { PointScore } from './node-sweep-types.js';

/**
 * Pick the best point under coordinate isolation.
 *
 * QUALITY GATE first: a point is "viable" only if it stays within ε of the BEST
 * observed value on BOTH axes — the node's own metric AND the end-to-end judge
 * score. Gating against the best (not a fixed baseline) is what makes this reusable
 * across the two stages.
 *
 * `reference` carries the best seen in an EARLIER stage. Stage 2 passes Stage 1's
 * bests, so the bar is the best across both stages, not just Stage 2's own best.
 * Without it each stage could give up a full ε against its own best and the losses
 * would stack: Stage 1 picks a model ε below the top, then Stage 2 drops another ε
 * below that model (the 2026-11-22 dbtStatus run landed 0.069 under the best with
 * ε = 0.057). With a shared bar the final pick is never more than ε under the best
 * point measured anywhere in the sweep.
 *
 * TIE-BREAK among the viable set depends on the axis being searched:
 *  - `'cost'`  (Stage 1, the MODEL axis): take the cheapest point — i.e. the
 *    cheapest model whose quality matches the best. Cost is dominated by tier
 *    price, so this is "the cheapest tier that's good enough". Ties resolve to
 *    higher quality, then lower latency.
 *  - `'latency'` (Stage 2, the THINKING axis): the model is fixed, so cost varies
 *    only with thinking tokens; take the fastest point within a 5% latency band
 *    (least thinking), then higher quality, then lower cost.
 *
 * If ε is tight enough that no single point sits near both bests at once (a
 * best-metric point can have a poor e2e and vice-versa), the viable set is empty;
 * we fall back to the full pool so the tie-break still yields a defensible choice
 * rather than crashing. In Stage 2 the Stage 1 winner, carried in at the anchor
 * level, usually keeps the viable set non-empty. It can still empty if Stage 1
 * itself fell back, or if a Stage 2 point raises one axis's best far enough to push
 * the anchor out of ε there; then the stage's own bests are tried before the full
 * pool, so the pick is never worse than gating without a reference.
 */
export function pickWithinEpsilon(
  candidates: PointScore[],
  metricEps: number,
  e2eEps: number,
  tieBreak: 'cost' | 'latency',
  reference?: { metric: number; e2e: number },
  latencyBand = 0.05,
): PointScore {
  if (candidates.length === 0) {
    throw new Error('pickWithinEpsilon: no candidates to choose from');
  }

  const ownBestMetric = Math.max(...candidates.map((c) => c.metric));
  const ownBestE2e = Math.max(...candidates.map((c) => c.e2e));
  const within = (bestMetric: number, bestE2e: number) =>
    candidates.filter((c) => c.metric >= bestMetric - metricEps && c.e2e >= bestE2e - e2eEps);
  let viable = within(
    Math.max(ownBestMetric, reference?.metric ?? -Infinity),
    Math.max(ownBestE2e, reference?.e2e ?? -Infinity),
  );
  // If the shared bar excludes everything, keep the stage's own quality gate rather
  // than letting the latency tie-break pick the fastest point at any quality.
  if (viable.length === 0 && reference) viable = within(ownBestMetric, ownBestE2e);
  const pool = viable.length > 0 ? viable : candidates;

  if (tieBreak === 'cost') {
    return [...pool].sort(
      (a, b) => (a.cost - b.cost) || (b.metric - a.metric) || (a.p95LatencyMs - b.p95LatencyMs),
    )[0];
  }

  const fastest = Math.min(...pool.map((c) => c.p95LatencyMs));
  const band = pool.filter((c) => c.p95LatencyMs <= fastest * (1 + latencyBand));
  return [...band].sort((a, b) => (b.metric - a.metric) || (a.cost - b.cost))[0];
}
