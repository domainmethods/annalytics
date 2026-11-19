import type { ChartSpec } from '../../src/agents/chartAgent.js';
import { renderChart } from '../../src/execution/chartRenderer.js';
import type { TeachingCandidate } from '../../src/state/teachingCandidates.js';
import type { ChartItem, SummaryOverrideItem, TeachingCandidateItem } from './items.js';

function encodingFieldsExist(encoding: unknown, columnNames: string[]): boolean {
  if (Array.isArray(encoding)) {
    return encoding.every(entry => encodingFieldsExist(entry, columnNames));
  }
  if (encoding === null || typeof encoding !== 'object') return true;
  return Object.entries(encoding).every(([key, value]) =>
    key === 'field'
      ? typeof value === 'string' && columnNames.includes(value)
      : encodingFieldsExist(value, columnNames),
  );
}

export async function scoreChart(spec: ChartSpec | null, item: ChartItem): Promise<number> {
  if (!spec) return 0;
  const { mark, encoding } = spec.vegaLiteSpec;
  const markType = typeof mark === 'object' && mark !== null && 'type' in mark ? mark.type : mark;
  if (typeof markType !== 'string' || !item.allowedMarks.includes(markType)) return 0;
  if (!encodingFieldsExist(encoding, item.columnNames)) return 0;

  try {
    return Number(Boolean(await renderChart(spec.vegaLiteSpec, item.sampleRows)));
  } catch {
    return 0;
  }
}

const MONTH_NAME = /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/i.source;
const MONTH_BEFORE = new RegExp(`${MONTH_NAME}[.,]?\\s+$`, 'i');
const MONTH_AFTER = new RegExp(`^,?\\s+${MONTH_NAME}`, 'i');
const NUMBER_SCALES: Record<string, number> = { k: 1e3, m: 1e6, b: 1e9 };

export function scoreSummaryNumbers(summary: string, rows: Record<string, unknown>[]): number {
  if (!summary.trim()) return 0;

  const rowNumbers = rows.flatMap(Object.values)
    .filter(value => typeof value === 'number' || (typeof value === 'string' && value.trim() !== ''))
    .map(Number)
    .filter(Number.isFinite);
  // ISO dates are single tokens. Bare years are skipped only beside an English month name.
  const tokens = /(?<![\w.])(?:(?:19\d{2}|20\d{2}|2100)-\d{2}-\d{2}|((?:[-+]\$?|\$[-+]?)?(?:(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?|\.\d+))([kmb%]?))(?!\w)/gi;
  let matches = 0;
  let count = 0;
  for (const match of summary.matchAll(tokens)) {
    const [token, magnitude, suffix] = match;
    if (magnitude === undefined) continue;
    // A signed, grouped, or suffixed number is a value even beside a month name.
    const index = match.index!;
    if (/^(?:19\d{2}|20\d{2}|2100)$/.test(token) &&
      (MONTH_BEFORE.test(summary.slice(0, index)) || MONTH_AFTER.test(summary.slice(index + token.length)))) {
      continue;
    }

    count++;
    const displayed = Number(magnitude.replace(/[$,]/g, ''));
    const scale = NUMBER_SCALES[suffix.toLowerCase()] ?? 1;
    const precision = Math.min(magnitude.split('.')[1]?.length ?? 0, 100);
    const matchesValue = (value: number) => Number.isFinite(value) && (
      Math.abs(value - displayed) <= 1e-6 * Math.max(Math.abs(value), Math.abs(displayed)) ||
      Number(value.toFixed(precision)) === displayed
    );

    if (Number.isFinite(displayed) && rowNumbers.some(value =>
      matchesValue(value / scale) || (suffix === '%' && matchesValue(value * 100)),
    )) matches++;
  }
  return count === 0 ? 1 : matches / count;
}

export function scoreFacts(text: string, requiredFacts: string[]): number {
  const normalized = text.toLowerCase();
  return requiredFacts.length === 0 ? 1
    : requiredFacts.filter(fact => normalized.includes(fact.toLowerCase())).length / requiredFacts.length;
}

export function scoreTeachingCandidate(candidate: TeachingCandidate, item: TeachingCandidateItem): number {
  const sqlMatches = (candidate.sanctionedSql !== null) === item.expectSanctionedSql;
  const modelsMatch = item.requiredModels.every(model => candidate.modelsReferenced.includes(model));
  return (Number(sqlMatches) + Number(modelsMatch)) / 2;
}

export async function scoreRubric(
  text: string,
  rubric: string[],
  judge: (text: string, fact: string) => Promise<boolean>,
): Promise<number> {
  if (!rubric.length) return 1;
  let matches = 0;
  for (const fact of rubric) {
    try {
      if (await judge(text, fact)) matches++;
    } catch {
      // A judge error scores this fact as false.
    }
  }
  return matches / rubric.length;
}

// Medium-strength signal: numeric grounding and question relevance carry equal weight.
export async function scoreSummaryOverride(
  summary: string,
  item: SummaryOverrideItem,
  judge: (text: string, fact: string) => Promise<boolean>,
): Promise<number> {
  const numericScore = scoreSummaryNumbers(summary, item.rows);
  const rubricScore = await scoreRubric(summary, ['answers the question asked'], judge);
  return (numericScore + rubricScore) / 2;
}
