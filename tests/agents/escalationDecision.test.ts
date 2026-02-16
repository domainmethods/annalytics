import { describe, it, expect } from 'vitest';
import { decideEscalation } from '../../src/agents/escalationDecision.js';

describe('decideEscalation', () => {
  it('does not escalate when verdict is pass', () => {
    const result = decideEscalation('pass', 'high');
    expect(result.shouldEscalate).toBe(false);
  });

  it('does not escalate when verdict is fail_then_pass', () => {
    const result = decideEscalation('fail_then_pass', 'medium');
    expect(result.shouldEscalate).toBe(false);
  });

  it('escalates with park_wait when exhausted and low confidence', () => {
    const result = decideEscalation('exhausted', 'low');
    expect(result.shouldEscalate).toBe(true);
    expect(result.behavior).toBe('park_wait');
    expect(result.trigger).toBe('supervisor_exhausted');
  });

  it('escalates with best_effort_verify when exhausted and medium/high confidence', () => {
    const medium = decideEscalation('exhausted', 'medium');
    expect(medium.shouldEscalate).toBe(true);
    expect(medium.behavior).toBe('best_effort_verify');

    const high = decideEscalation('exhausted', 'high');
    expect(high.shouldEscalate).toBe(true);
    expect(high.behavior).toBe('best_effort_verify');
  });
});
