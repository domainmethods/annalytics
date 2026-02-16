export interface EscalationDecision {
  shouldEscalate: boolean;
  behavior: 'best_effort_verify' | 'park_wait';
  trigger: 'supervisor_exhausted';
}

export function decideEscalation(
  supervisorVerdict: 'pass' | 'fail_then_pass' | 'exhausted',
  primaryConfidence: 'high' | 'medium' | 'low',
): EscalationDecision {
  if (supervisorVerdict !== 'exhausted') {
    return { shouldEscalate: false, behavior: 'park_wait', trigger: 'supervisor_exhausted' };
  }

  return {
    shouldEscalate: true,
    behavior: primaryConfidence === 'low' ? 'park_wait' : 'best_effort_verify',
    trigger: 'supervisor_exhausted',
  };
}
