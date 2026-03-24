import { describe, it, expect } from 'vitest';
import { detectRegressions } from '../../scripts/benchmark-analyze.js';
import type { JudgeResult } from '../../scripts/benchmark-types.js';

const makeJudge = (id: string, correctness: number): JudgeResult => ({
  corpusId: id,
  scores: { correctness, efficiency: 3, readability: 3, teachingCompliance: 3, safety: 3 },
  overallScore: correctness,
  rationale: 'test',
  flaggedForReview: false,
});

describe('detectRegressions', () => {
  it('detects regression when correctness drops by 2+', () => {
    const previous = [makeJudge('q1', 5), makeJudge('q2', 4)];
    const current = [makeJudge('q1', 2), makeJudge('q2', 4)];
    const regressions = detectRegressions(previous, current);
    expect(regressions).toHaveLength(1);
    expect(regressions[0].corpusId).toBe('q1');
  });

  it('returns empty when no regressions', () => {
    const previous = [makeJudge('q1', 3)];
    const current = [makeJudge('q1', 4)];
    expect(detectRegressions(previous, current)).toHaveLength(0);
  });
});
