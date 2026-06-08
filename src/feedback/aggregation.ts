export interface FeedbackRecord {
  domain: string;
  negative: boolean;
  confidence: 'high' | 'medium' | 'low';
}

export interface DomainPain {
  domain: string;
  total: number;
  negative: number;
  negativeRate: number;
  belowSample: boolean;
}

export interface CalibrationBucket {
  confidence: 'high' | 'medium' | 'low';
  total: number;
  negative: number;
  negativeRate: number;
}

function tally<T extends string>(records: FeedbackRecord[], key: (r: FeedbackRecord) => T) {
  const acc = new Map<T, { total: number; negative: number }>();
  for (const r of records) {
    const k = key(r);
    const cur = acc.get(k) ?? { total: 0, negative: 0 };
    cur.total += 1;
    if (r.negative) cur.negative += 1;
    acc.set(k, cur);
  }
  return acc;
}

/** Per-domain pain, sorted: sample-meeting domains by negativeRate desc, then
 *  below-sample domains by total desc. minSample guards against 1/1 noise. */
export function getDomainPainRanking(records: FeedbackRecord[], minSample = 5): DomainPain[] {
  const acc = tally(records, (r) => r.domain);
  const rows: DomainPain[] = [...acc.entries()].map(([domain, { total, negative }]) => ({
    domain,
    total,
    negative,
    negativeRate: total === 0 ? 0 : negative / total,
    belowSample: total < minSample,
  }));
  return rows.sort((a, b) => {
    if (a.belowSample !== b.belowSample) return a.belowSample ? 1 : -1;
    if (!a.belowSample) return b.negativeRate - a.negativeRate || b.total - a.total;
    return b.total - a.total;
  });
}

/** negativeRate bucketed by the response's reconciled confidence. Emitted in fixed
 *  low→medium→high order; buckets with no records are omitted. */
export function getConfidenceCalibration(records: FeedbackRecord[]): CalibrationBucket[] {
  const acc = tally(records, (r) => r.confidence);
  const order: CalibrationBucket['confidence'][] = ['low', 'medium', 'high'];
  return order
    .filter((c) => acc.has(c))
    .map((confidence) => {
      const { total, negative } = acc.get(confidence)!;
      return { confidence, total, negative, negativeRate: total === 0 ? 0 : negative / total };
    });
}
