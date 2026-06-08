import { describe, it, expect } from 'vitest';
import { computeEpsilon } from '../../scripts/node-sweep-calibrate.js';

describe('computeEpsilon', () => {
  it('returns the floor when two runs are identical', () => {
    expect(computeEpsilon([0.9, 0.8, 0.7], [0.9, 0.8, 0.7])).toBe(0.01);
  });

  it('returns the largest absolute per-index difference when it exceeds the floor', () => {
    expect(computeEpsilon([0.9, 0.8, 0.7], [0.9, 0.6, 0.7])).toBeCloseTo(0.2, 10);
  });

  it('honors a custom floor', () => {
    expect(computeEpsilon([0.9], [0.9], 0.05)).toBe(0.05);
  });

  it('compares only over the shorter length when runs differ in size', () => {
    // runB dropped its 3rd case; the 0.3 gap at index 2 must NOT be compared.
    expect(computeEpsilon([0.9, 0.8, 0.5], [0.9, 0.8])).toBe(0.01);
  });
});
