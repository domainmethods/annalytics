import type { RungScore } from './node-sweep-types.js';

export function pickRecommendation(
  baseline: RungScore,
  candidates: RungScore[],   // MUST include baseline
  metricEps: number,
  e2eEps: number,
  latencyBand = 0.05,
): RungScore {
  const viable = candidates.filter(c => c.metric >= baseline.metric - metricEps && c.e2e >= baseline.e2e - e2eEps);
  if (viable.length === 0) return baseline; // contract: candidates includes baseline; defensive against a caller that forgot
  const fastest = Math.min(...viable.map(c => c.p95LatencyMs));
  const contenders = viable.filter(c => c.p95LatencyMs <= fastest * (1 + latencyBand));
  contenders.sort((a, b) => (b.metric - a.metric) || (a.cost - b.cost));
  return contenders[0];
}
