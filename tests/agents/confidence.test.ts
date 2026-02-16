import { describe, it, expect } from 'vitest';
import { reconcileConfidence } from '../../src/agents/confidence.js';

describe('reconcileConfidence', () => {
  it('returns high when both primary and supervisor are high', () => {
    expect(reconcileConfidence('high', 'high')).toBe('high');
  });

  it('returns medium when primary is high but supervisor is medium', () => {
    expect(reconcileConfidence('high', 'medium')).toBe('medium');
  });

  it('returns low when either is low', () => {
    expect(reconcileConfidence('low', 'high')).toBe('low');
    expect(reconcileConfidence('high', 'low')).toBe('low');
  });

  it('returns low when supervisor is low even if primary is high', () => {
    expect(reconcileConfidence('high', 'low')).toBe('low');
  });

  it('returns primary confidence when supervisor is missing', () => {
    expect(reconcileConfidence('high')).toBe('high');
    expect(reconcileConfidence('medium')).toBe('medium');
    expect(reconcileConfidence('low')).toBe('low');
  });
});
