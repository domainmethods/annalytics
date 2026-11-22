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
 * rather than crashing. In Stage 2 that cannot happen in practice: the Stage 1
 * winner is carried into Stage 2 at the anchor level and already cleared the same bar.
 */
export function pickWithinEpsilon(
  candidates: PointScore[],
  metricEps: number,
  e2eEps: number,
  tieBreak: 'cost' | 'latency',
  latencyBand = 0.05,
  reference?: { metric: number; e2e: number },
): PointScore {
  if (candidates.length === 0) {
    throw new Error('pickWithinEpsilon: no candidates to choose from');
  }

  const bestMetric = Math.max(...candidates.map((c) => c.metric), reference?.metric ?? -Infinity);
  const bestE2e = Math.max(...candidates.map((c) => c.e2e), reference?.e2e ?? -Infinity);
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
