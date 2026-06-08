import { describe, it, expect } from 'vitest';
import { getDomainPainRanking, getConfidenceCalibration, type FeedbackRecord } from '../../src/feedback/aggregation.js';

const rec = (domain: string, negative: boolean, confidence: FeedbackRecord['confidence'] = 'high'): FeedbackRecord =>
  ({ domain, negative, confidence });

describe('getDomainPainRanking', () => {
  it('ranks domains meeting the sample floor by negativeRate', () => {
    const records = [
      ...Array.from({ length: 10 }, () => rec('revenue', true)),   // 10/10 negative
      ...Array.from({ length: 10 }, () => rec('revenue', false)),  // -> 0.5
      ...Array.from({ length: 6 }, () => rec('users', true)),      // 6/6 -> but small
    ];
    const ranking = getDomainPainRanking(records, 8);
    expect(ranking[0].domain).toBe('revenue');       // meets floor (20 >= 8)
    expect(ranking[0].negativeRate).toBeCloseTo(0.5);
    // 'users' has higher rate but is below the sample floor -> ranked after
    expect(ranking[1].domain).toBe('users');
    expect(ranking[1].belowSample).toBe(true);
  });
  it('returns an empty array for no records', () => {
    expect(getDomainPainRanking([], 5)).toEqual([]);
  });
});

describe('getConfidenceCalibration', () => {
  it('buckets negativeRate by confidence', () => {
    const records = [
      rec('a', true, 'low'), rec('a', false, 'low'),   // low -> 0.5
      rec('b', false, 'high'), rec('b', false, 'high'), // high -> 0.0
    ];
    const cal = Object.fromEntries(getConfidenceCalibration(records).map((c) => [c.confidence, c]));
    expect(cal.low.negativeRate).toBeCloseTo(0.5);
    expect(cal.high.negativeRate).toBeCloseTo(0.0);
  });
});
