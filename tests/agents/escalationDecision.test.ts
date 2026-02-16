import { describe, it, expect } from 'vitest';
import { decideEscalation } from '../../src/agents/escalationDecision.js';
import type { FailureRecord } from '../../src/qualityLoop.js';

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

  // ── New: failure history tests ──────────────────────────────────────

  it('forces park_wait for structural exhaustion regardless of confidence', () => {
    const history: FailureRecord[] = [
      { attempt: 0, failureType: 'structural', detail: 'DML blocked' },
      { attempt: 1, failureType: 'structural', detail: 'DML blocked' },
      { attempt: 2, failureType: 'dry_run', detail: 'Table not found' },
    ];

    const result = decideEscalation('exhausted', 'high', history);

    expect(result.shouldEscalate).toBe(true);
    expect(result.behavior).toBe('park_wait');
    expect(result.dominantFailureType).toBe('dry_run');
    expect(result.trigger).toBe('quality_loop_exhausted');
    expect(result.failureHistory).toEqual(history);
  });

  it('forces park_wait for dry_run exhaustion regardless of confidence', () => {
    const history: FailureRecord[] = [
      { attempt: 0, failureType: 'dry_run', detail: 'Invalid table' },
      { attempt: 1, failureType: 'dry_run', detail: 'Invalid table' },
      { attempt: 2, failureType: 'dry_run', detail: 'Invalid table' },
    ];

    const result = decideEscalation('exhausted', 'high', history);

    expect(result.shouldEscalate).toBe(true);
    expect(result.behavior).toBe('park_wait');
    expect(result.dominantFailureType).toBe('dry_run');
  });

  it('uses confidence for semantic exhaustion — best_effort_verify for medium', () => {
    const history: FailureRecord[] = [
      { attempt: 0, failureType: 'semantic', detail: 'Wrong join' },
      { attempt: 1, failureType: 'semantic', detail: 'Missing filter' },
      { attempt: 2, failureType: 'semantic', detail: 'Incorrect aggregation' },
    ];

    const result = decideEscalation('exhausted', 'medium', history);

    expect(result.shouldEscalate).toBe(true);
    expect(result.behavior).toBe('best_effort_verify');
    expect(result.dominantFailureType).toBe('semantic');
    expect(result.trigger).toBe('quality_loop_exhausted');
  });

  it('uses confidence for semantic exhaustion — park_wait for low', () => {
    const history: FailureRecord[] = [
      { attempt: 0, failureType: 'semantic', detail: 'Wrong join' },
    ];

    const result = decideEscalation('exhausted', 'low', history);

    expect(result.shouldEscalate).toBe(true);
    expect(result.behavior).toBe('park_wait');
  });

  it('is backward-compatible when failureHistory is not provided', () => {
    // Without failureHistory — same as original behavior
    const result = decideEscalation('exhausted', 'medium');

    expect(result.shouldEscalate).toBe(true);
    expect(result.behavior).toBe('best_effort_verify');
    expect(result.trigger).toBe('supervisor_exhausted');
    expect(result.dominantFailureType).toBeUndefined();
    expect(result.failureHistory).toBeUndefined();
  });

  it('sets trigger to quality_loop_exhausted when failureHistory provided', () => {
    const history: FailureRecord[] = [
      { attempt: 0, failureType: 'semantic', detail: 'Issue' },
    ];

    const result = decideEscalation('exhausted', 'high', history);

    expect(result.trigger).toBe('quality_loop_exhausted');
  });

  it('does not escalate for pass verdict even with failureHistory', () => {
    const history: FailureRecord[] = [
      { attempt: 0, failureType: 'structural', detail: 'blocked' },
    ];

    const result = decideEscalation('pass', 'high', history);

    expect(result.shouldEscalate).toBe(false);
  });
});
