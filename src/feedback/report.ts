import type { ResponseContext } from '../types.js';
import { resolveDomain, type DomainMapEntry } from './domainAttribution.js';
import type { FeedbackRecord, DomainPain, CalibrationBucket } from './aggregation.js';

/** Drop responses with no thumb (or legacy docs missing confidence); tag the
 *  rest with a domain. This is a retroactive read over historical Firestore
 *  docs, some persisted before `confidence` was consistently populated, so the
 *  `confidence` guard keeps a stray legacy doc from poisoning the calibration. */
export function toFeedbackRecords(docs: ResponseContext[], domainMap: DomainMapEntry[]): FeedbackRecord[] {
  return docs
    .filter((d) => d.negativeFeedback !== undefined && d.confidence !== undefined)
    .map((d) => ({
      domain: resolveDomain(d.tablesUsed ?? [], domainMap),
      negative: d.negativeFeedback === true,
      confidence: d.confidence,
    }));
}

const pct = (r: number) => `${(r * 100).toFixed(0)}%`;

export function formatReport(ranking: DomainPain[], calibration: CalibrationBucket[], windowDays: number): string {
  const lines: string[] = [];
  lines.push(`Feedback sensor — trailing ${windowDays} days`, '');
  lines.push('Domain pain ranking (by negativeRate):');
  if (ranking.length === 0) lines.push('  (no feedback recorded in window)');
  for (const r of ranking) {
    lines.push(`  ${r.domain.padEnd(16)} ${pct(r.negativeRate)}  (${r.negative}/${r.total})${r.belowSample ? '  [low sample]' : ''}`);
  }
  lines.push('', 'Calibration — negativeRate by reconciled confidence:');
  for (const c of calibration) {
    lines.push(`  ${c.confidence.padEnd(8)} ${pct(c.negativeRate)}  (${c.negative}/${c.total})`);
  }
  if (calibration.length === 0) lines.push('  (no feedback recorded in window)');
  return lines.join('\n');
}
