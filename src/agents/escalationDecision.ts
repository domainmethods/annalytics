import type { FailureRecord } from '../qualityLoop.js';

export interface EscalationDecision {
  shouldEscalate: boolean;
  behavior: 'best_effort_verify' | 'park_wait';
  trigger: 'supervisor_exhausted' | 'quality_loop_exhausted';
  dominantFailureType?: 'structural' | 'dry_run' | 'semantic';
  failureHistory?: FailureRecord[];
}

export function decideEscalation(
  verdict: 'pass' | 'fail_then_pass' | 'exhausted',
  confidence: 'high' | 'medium' | 'low',
  failureHistory?: FailureRecord[],
): EscalationDecision {
  if (verdict !== 'exhausted') {
    return { shouldEscalate: false, behavior: 'park_wait', trigger: 'supervisor_exhausted' };
  }

  // Determine dominant failure type from history
  const lastFailure = failureHistory?.[failureHistory.length - 1];
  const dominantFailureType = lastFailure?.failureType;
  const trigger = failureHistory ? 'quality_loop_exhausted' : 'supervisor_exhausted';

  // Structural/dry-run failures mean no valid SQL exists — cannot best_effort_verify
  if (dominantFailureType === 'structural' || dominantFailureType === 'dry_run') {
    return {
      shouldEscalate: true,
      behavior: 'park_wait',
      trigger,
      dominantFailureType,
      failureHistory,
    };
  }

  return {
    shouldEscalate: true,
    behavior: confidence === 'low' ? 'park_wait' : 'best_effort_verify',
    trigger,
    dominantFailureType,
    failureHistory,
  };
}
