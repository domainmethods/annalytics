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
});
