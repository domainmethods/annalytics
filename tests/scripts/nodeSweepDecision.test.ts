import { describe, it, expect } from 'vitest';
import { pickRecommendation } from '../../scripts/node-sweep-decision.js';

const base = { rung: 'DEFAULT', metric: 0.90, e2e: 8.0, p95LatencyMs: 1000, cost: 100 };

describe('pickRecommendation', () => {
  it('falls back to baseline when no cheaper rung is viable', () => {
    const cands = [base, { rung: 'R0', metric: 0.5, e2e: 8.0, p95LatencyMs: 200, cost: 10 }];
    expect(pickRecommendation(base, cands, 0.02, 0.3).rung).toBe('DEFAULT'); // R0 regresses metric
  });

  it('prefers a >5% faster viable rung over baseline', () => {
    const cands = [base, { rung: 'R2', metric: 0.89, e2e: 7.9, p95LatencyMs: 800, cost: 60 }];
    expect(pickRecommendation(base, cands, 0.02, 0.3).rung).toBe('R2');
  });

  it('within the latency band, prefers higher quality then lower cost', () => {
    const cands = [
      base,
      { rung: 'A', metric: 0.91, e2e: 8.0, p95LatencyMs: 500, cost: 80 },
      { rung: 'B', metric: 0.93, e2e: 8.0, p95LatencyMs: 510, cost: 90 }, // within 5% of 500
      { rung: 'C', metric: 0.93, e2e: 8.0, p95LatencyMs: 505, cost: 70 }, // same quality, cheaper
    ];
    expect(pickRecommendation(base, cands, 0.02, 0.3).rung).toBe('C');
  });

  it('gates on the end-to-end score, not just the node metric', () => {
    const cands = [base, { rung: 'R', metric: 0.90, e2e: 7.5, p95LatencyMs: 300, cost: 20 }];
    expect(pickRecommendation(base, cands, 0.02, 0.3).rung).toBe('DEFAULT'); // e2e drop 0.5 > eps 0.3
  });

  it('falls back to baseline when no candidate is viable (defensive guard)', () => {
    // Contract is "candidates includes baseline"; an empty list violates it.
    // The guard must return baseline rather than crash on Math.min(...[]) → Infinity.
    expect(pickRecommendation(base, [], 0.02, 0.3).rung).toBe('DEFAULT');
  });
});
