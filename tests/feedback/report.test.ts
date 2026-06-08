import { describe, it, expect } from 'vitest';
import { toFeedbackRecords, formatReport } from '../../src/feedback/report.js';
import type { DomainMapEntry } from '../../src/feedback/domainAttribution.js';

const map: DomainMapEntry[] = [{ table: 'analytics.fct_orders', domain: 'revenue' }];

const ctx = (over: Record<string, unknown>) => ({
  traceId: 't', tablesUsed: ['analytics.fct_orders'], confidence: 'high', ...over,
}) as any;

describe('toFeedbackRecords', () => {
  it('keeps only responses that received a thumb and tags domain', () => {
    const docs = [
      ctx({ negativeFeedback: true }),
      ctx({ negativeFeedback: false }),
      ctx({}),                       // no thumb -> dropped
    ];
    const records = toFeedbackRecords(docs, map);
    expect(records).toHaveLength(2);
    expect(records[0]).toEqual({ domain: 'revenue', negative: true, confidence: 'high' });
  });
  it('drops a legacy doc that has a thumb but no confidence', () => {
    const docs = [ctx({ negativeFeedback: true, confidence: undefined })];
    expect(toFeedbackRecords(docs, map)).toHaveLength(0);
  });
  it('tags unclassified when the doc has no tables', () => {
    const docs = [ctx({ negativeFeedback: false, tablesUsed: undefined })];
    expect(toFeedbackRecords(docs, map)[0].domain).toBe('unclassified');
  });
});

describe('formatReport', () => {
  it('renders a non-empty report with both sections', () => {
    const out = formatReport(
      [{ domain: 'revenue', total: 10, negative: 5, negativeRate: 0.5, belowSample: false }],
      [{ confidence: 'low', total: 4, negative: 3, negativeRate: 0.75 }],
      30,
    );
    expect(out).toContain('revenue');
    expect(out).toContain('Calibration');
    expect(out).toContain('30');
  });
  it('renders rate, counts, and the low-sample marker exactly', () => {
    const out = formatReport(
      [
        { domain: 'revenue', total: 10, negative: 5, negativeRate: 0.5, belowSample: false },
        { domain: 'users', total: 3, negative: 3, negativeRate: 1, belowSample: true },
      ],
      [{ confidence: 'low', total: 4, negative: 3, negativeRate: 0.75 }],
      30,
    );
    expect(out).toContain('50%  (5/10)');
    expect(out).toContain('100%  (3/3)  [low sample]');
    expect(out).toContain('low');
    expect(out).toContain('75%  (3/4)');
  });
  it('shows the empty-state line in both sections when there is no feedback', () => {
    const out = formatReport([], [], 14);
    expect(out).toContain('trailing 14 days');
    // both the ranking and calibration sections render the empty-state line
    expect(out.match(/\(no feedback recorded in window\)/g)).toHaveLength(2);
  });
});
