import { describe, it, expect } from 'vitest';
import { pickWithinEpsilon } from '../../scripts/node-sweep-decision.js';
import type { PointScore } from '../../scripts/node-sweep-types.js';

// A point that's "best" on quality; clones override only what each test exercises.
const pt = (over: Partial<PointScore>): PointScore => ({
  label: 'x', metric: 0.9, e2e: 8.0, p95LatencyMs: 1000, cost: 100, ...over,
});

describe('pickWithinEpsilon', () => {
  describe("tieBreak = 'cost' (Stage 1: cheapest model within ε of the best)", () => {
    it('picks the cheapest candidate that is within ε of the best on BOTH quality axes', () => {
      const cands = [
        pt({ label: 'pro', metric: 0.90, e2e: 8.00, cost: 100 }),
        pt({ label: 'flash', metric: 0.89, e2e: 7.95, cost: 30 }),   // within ε, cheaper → winner
        pt({ label: 'lite', metric: 0.60, e2e: 6.00, cost: 10 }),    // cheapest but regresses quality
      ];
      expect(pickWithinEpsilon(cands, 0.02, 0.1, 'cost').label).toBe('flash');
    });

    it('gates on the end-to-end score, not just the node metric', () => {
      const cands = [
        pt({ label: 'pro', metric: 0.90, e2e: 8.0, cost: 100 }),
        pt({ label: 'cheap', metric: 0.90, e2e: 7.4, cost: 10 }),   // metric fine, e2e drop 0.6 > ε
      ];
      expect(pickWithinEpsilon(cands, 0.02, 0.3, 'cost').label).toBe('pro');
    });

    it('breaks a cost tie by higher quality, then lower latency', () => {
      const cands = [
        pt({ label: 'a', metric: 0.90, e2e: 8.0, cost: 50, p95LatencyMs: 900 }),
        pt({ label: 'b', metric: 0.91, e2e: 8.0, cost: 50, p95LatencyMs: 900 }), // same cost, better metric
      ];
      expect(pickWithinEpsilon(cands, 0.02, 0.1, 'cost').label).toBe('b');
    });

    it('falls back to all candidates when none sits near both bests at once', () => {
      // A is best-metric/worst-e2e, B is best-e2e/worst-metric: with a tight ε no
      // single point clears BOTH gates, so the viable set is empty. Rather than
      // crash, fall back to the full pool and let the tie-break choose (cheapest).
      const cands = [
        pt({ label: 'A', metric: 1.0, e2e: 0.0, cost: 100 }),
        pt({ label: 'B', metric: 0.0, e2e: 1.0, cost: 10 }),
      ];
      expect(pickWithinEpsilon(cands, 0.01, 0.01, 'cost').label).toBe('B');
    });
  });

  describe("tieBreak = 'latency' (Stage 2: fastest thinking level within ε)", () => {
    it('picks the fastest viable point (least thinking) within ε of the best', () => {
      const cands = [
        pt({ label: 'high', metric: 0.92, e2e: 8.0, p95LatencyMs: 2000 }),
        pt({ label: 'minimal', metric: 0.91, e2e: 7.95, p95LatencyMs: 400 }), // within ε, far faster
      ];
      expect(pickWithinEpsilon(cands, 0.02, 0.1, 'latency').label).toBe('minimal');
    });

    it('within the 5% latency band, prefers higher quality then lower cost', () => {
      const cands = [
        pt({ label: 'fast-lo', metric: 0.90, e2e: 8.0, p95LatencyMs: 400, cost: 30 }),
        pt({ label: 'fast-hi', metric: 0.92, e2e: 8.0, p95LatencyMs: 410, cost: 40 }), // within 5% of 400, better quality
      ];
      expect(pickWithinEpsilon(cands, 0.05, 0.1, 'latency').label).toBe('fast-hi');
    });

    it('does NOT downsize to a faster point that regresses quality past ε', () => {
      const cands = [
        pt({ label: 'high', metric: 0.92, e2e: 8.0, p95LatencyMs: 2000 }),
        pt({ label: 'minimal', metric: 0.70, e2e: 8.0, p95LatencyMs: 400 }), // 0.22 metric drop > ε
      ];
      expect(pickWithinEpsilon(cands, 0.02, 0.1, 'latency').label).toBe('high');
    });
  });

  it('throws on an empty candidate set rather than returning a bogus point', () => {
    expect(() => pickWithinEpsilon([], 0.02, 0.1, 'cost')).toThrow(/no candidates/i);
  });
});
