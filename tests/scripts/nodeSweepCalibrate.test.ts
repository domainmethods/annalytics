import { describe, expect, it } from 'vitest';
import { computeEpsilon } from '../../scripts/node-sweep-calibrate.js';

describe('computeEpsilon', () => {
  it('returns the floor when two runs are identical', () => {
    expect(computeEpsilon([0.9, 0.8, 0.7], [0.9, 0.8, 0.7])).toBe(0.01);
  });

  it('measures noise on the mean: 2 * sd(paired diffs) / sqrt(n)', () => {
    // diffs = [0, 0.2, 0] → mean 0.0667, sample sd = 0.11547, ε = 2 * 0.11547 / √3
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

  it('grows with the number of noisy cases', () => {
    const runA = Array.from({ length: 40 }, () => 1);
    const oneFlip = [...runA];
    oneFlip[0] = 0;
    const tenFlips = runA.map((v, i) => (i < 10 ? 0 : v));
    expect(computeEpsilon(runA, tenFlips)).toBeGreaterThan(computeEpsilon(runA, oneFlip));
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
