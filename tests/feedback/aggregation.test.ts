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
  it('tie-breaks equal negativeRate by total desc among sample-meeting domains', () => {
    const records = [
      // both 100% negative (rate ties); 'big' has more samples -> ranks first
      ...Array.from({ length: 10 }, () => rec('big', true)),
      ...Array.from({ length: 6 }, () => rec('small', true)),
    ];
    const ranking = getDomainPainRanking(records, 5);
    expect(ranking.map((r) => r.domain)).toEqual(['big', 'small']);
  });

  it('orders below-sample domains by total desc', () => {
    const records = [
      ...Array.from({ length: 4 }, () => rec('mid', true)),
      ...Array.from({ length: 2 }, () => rec('tiny', true)),
    ];
    const ranking = getDomainPainRanking(records, 5); // both below floor of 5
    expect(ranking.every((r) => r.belowSample)).toBe(true);
    expect(ranking.map((r) => r.domain)).toEqual(['mid', 'tiny']);
  });

  it('treats total === minSample as meeting the floor (boundary is <)', () => {
    const records = Array.from({ length: 5 }, () => rec('edge', true));
    const [row] = getDomainPainRanking(records, 5);
    expect(row.belowSample).toBe(false);
  });

  it('treats total === minSample - 1 as below the floor', () => {
    const records = Array.from({ length: 4 }, () => rec('edge', true));
    const [row] = getDomainPainRanking(records, 5);
    expect(row.belowSample).toBe(true);
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
  it('emits present buckets in low→medium→high order and omits empty ones', () => {
    const records = [
      rec('a', true, 'high'),
      rec('a', false, 'low'),
      rec('a', true, 'medium'),
    ];
    // only assert ORDER here (do not collapse with Object.fromEntries)
    expect(getConfidenceCalibration(records).map((c) => c.confidence)).toEqual(['low', 'medium', 'high']);
  });

  it('omits a confidence bucket that has no records', () => {
    const records = [rec('a', true, 'low'), rec('a', false, 'high')]; // no medium
    expect(getConfidenceCalibration(records).map((c) => c.confidence)).toEqual(['low', 'high']);
  });
});
