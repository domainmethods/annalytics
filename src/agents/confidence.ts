type ConfidenceLevel = 'high' | 'medium' | 'low';

const CONFIDENCE_RANK: Record<ConfidenceLevel, number> = {
  high: 3,
  medium: 2,
  low: 1,
};

const RANK_TO_CONFIDENCE: Record<number, ConfidenceLevel> = {
  3: 'high',
  2: 'medium',
  1: 'low',
};

export function reconcileConfidence(
  primaryConfidence: ConfidenceLevel,
  supervisorConfidence?: ConfidenceLevel,
): ConfidenceLevel {
  if (!supervisorConfidence) return primaryConfidence;

  const minRank = Math.min(
    CONFIDENCE_RANK[primaryConfidence],
    CONFIDENCE_RANK[supervisorConfidence],
  );
  return RANK_TO_CONFIDENCE[minRank];
}
