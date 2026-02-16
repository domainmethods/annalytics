import { describe, it, expect } from 'vitest';
import { costGate } from '../../src/validation/costGate.js';

describe('costGate', () => {
  const TEN_GB = 10_737_418_240;

  it('passes when bytes are under the threshold', () => {
    const result = costGate(5_000_000_000, TEN_GB);
    expect(result.valid).toBe(true);
    expect(result.bytesProcessed).toBe(5_000_000_000);
  });

  it('fails when bytes exceed the threshold', () => {
    const result = costGate(20_000_000_000, TEN_GB);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('10.00 GB');
  });

  it('passes at exactly the threshold', () => {
    const result = costGate(TEN_GB, TEN_GB);
    expect(result.valid).toBe(true);
  });

  it('includes human-readable sizes in error message', () => {
    const result = costGate(50_000_000_000, TEN_GB);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('46.57 GB'); // actual
    expect(result.error).toContain('10.00 GB'); // limit
  });
});
