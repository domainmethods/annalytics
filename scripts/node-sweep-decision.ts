import type { PointScore } from './node-sweep-types.js';

/**
 * Pick the best point under coordinate isolation.
 *
 * QUALITY GATE first: a point is "viable" only if it stays within ε of the BEST
 * observed value on BOTH axes — the node's own metric AND the end-to-end judge
 * score. Gating against the best (not a fixed baseline) is what makes this reusable
 * across the two stages: in each stage the strongest point in that stage sets the
 * bar, and we keep anything statistically indistinguishable from it.
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
 * rather than crashing.
 */
export function pickWithinEpsilon(
  candidates: PointScore[],
  metricEps: number,
  e2eEps: number,
  tieBreak: 'cost' | 'latency',
  latencyBand = 0.05,
): PointScore {
  if (candidates.length === 0) {
    throw new Error('pickWithinEpsilon: no candidates to choose from');
  }

  const bestMetric = Math.max(...candidates.map((c) => c.metric));
  const bestE2e = Math.max(...candidates.map((c) => c.e2e));
  const viable = candidates.filter(
    (c) => c.metric >= bestMetric - metricEps && c.e2e >= bestE2e - e2eEps,
  );
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
