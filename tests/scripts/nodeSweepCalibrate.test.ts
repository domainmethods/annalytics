import { describe, expect, it } from 'vitest';
import { computeEpsilon } from '../../scripts/node-sweep-calibrate.js';

describe('computeEpsilon', () => {
  it('returns the floor when two runs are identical', () => {
    expect(computeEpsilon([0.9, 0.8, 0.7], [0.9, 0.8, 0.7])).toBe(0.01);
  });

  it('measures noise on the mean: 2 * sqrt(sum of squared paired diffs) / n', () => {
    // diffs = [0, 0.2, 0] → ε = 2 * 0.2 / 3
    expect(computeEpsilon([0.9, 0.8, 0.7], [0.9, 0.6, 0.7])).toBeCloseTo(0.13333, 4);
  });

  it('keeps one flipped case on a 40-case corpus from tying every candidate', () => {
    // The old max-per-case band was 2/3 here; candidates differ by ~0.01–0.08.
    const runA = Array.from({ length: 40 }, () => 1);
    const runB = [...runA];
    runB[7] = 1 / 3;
    const eps = computeEpsilon(runA, runB);
    expect(eps).toBeCloseTo(0.03333, 4);
    expect(eps).toBeLessThan(0.05);
  });

  it('grows with the number of noisy cases, including same-direction flips', () => {
    const runA = Array.from({ length: 40 }, () => 1);
    const flipped = (k: number) => runA.map((v, i) => (i < k ? 0 : v));
    const eps = [1, 10, 20, 30, 40].map(k => computeEpsilon(runA, flipped(k)));
    for (let i = 1; i < eps.length; i++) expect(eps[i]).toBeGreaterThan(eps[i - 1]);
  });

  it('never collapses on a uniform run-to-run shift', () => {
    // Every case moved by 0.5; centering on the observed mean would return the floor.
    // At n = 40 the standard-error term is only 2 * sqrt(10) / 40 ≈ 0.16, so the
    // 0.5 here comes from the |mean(d)| bound.
    const runA = Array.from({ length: 40 }, () => 1);
    const runB = runA.map(v => v - 0.5);
    expect(computeEpsilon(runA, runB)).toBeCloseTo(0.5, 10);
  });

  it('honors a custom floor and z', () => {
    expect(computeEpsilon([0.9, 0.8], [0.9, 0.8], 0.05)).toBe(0.05);
    expect(computeEpsilon([0.9, 0.8, 0.7], [0.9, 0.6, 0.7], 0.01, 1)).toBeCloseTo(0.06667, 4);
  });

  it('returns the floor with fewer than two shared cases', () => {
    expect(computeEpsilon([0.9], [0.1])).toBe(0.01);
    expect(computeEpsilon([], [])).toBe(0.01);
  });

  it('compares only over the shorter length when runs differ in size', () => {
    // runB dropped its 3rd case; the 0.3 gap at index 2 must NOT be compared.
    expect(computeEpsilon([0.9, 0.8, 0.5], [0.9, 0.8])).toBe(0.01);
  });
});
