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

const MONTH_NAME = /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/.source;
const MONTH_BEFORE = new RegExp(`${MONTH_NAME}[.,]?\\s+$`, 'i');
const MONTH_AFTER = new RegExp(`^,?\\s+${MONTH_NAME}`, 'i');
const MAY_WITH_PREPOSITION = /\b(?:in|on|since|during|by|until|through|per)\s+may\s+$/i;
const NUMBER_SCALES: Record<string, number> = { k: 1e3, m: 1e6, b: 1e9 };
const YEAR = /(?:19\d{2}|20\d{2}|2100)/.source;
const DAY = /(?:0?[1-9]|[12]\d|3[01])/.source;
const ISO_DATE = `${YEAR}${/-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?/.source}`;
const NUMBER_CONTINUATION = /(?:[,.](?=\d)|%|[kmb](?!\w))/.source;
const MAY_DATE = `(?:may\\s+${DAY},?\\s+${YEAR}|${DAY}\\s+may,?\\s+${YEAR}|${YEAR},?\\s+may(?:\\s+${DAY}|(?=\\s+${DAY}${NUMBER_CONTINUATION})))(?!${NUMBER_CONTINUATION})`;
const NUMBER_CLAIM = /((?:[-+]\$?|\$[-+]?)?(?:(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?|\.\d+))(e[+-]?\d+)?([kmb%]?)/;
const SUMMARY_TOKENS = new RegExp(`(?<![\\w.])(?:${ISO_DATE}|${MAY_DATE}|${NUMBER_CLAIM.source})(?!\\w|\\.\\d)`, 'gi');
const BARE_YEAR = new RegExp(`^${YEAR}$`);

export function scoreSummaryNumbers(summary: string, rows: Record<string, unknown>[]): number {
  if (!summary.trim()) return 0;

  const rowNumbers = rows.flatMap(Object.values)
    .filter(value => typeof value === 'number' || (typeof value === 'string' && value.trim() !== ''))
    .map(Number)
    .filter(Number.isFinite);
  // Skip ISO dates and timestamps whole. Skip bare years beside English months,
  // with a day or preceding date preposition required for May. A year-first May
  // prefix leaves a following formatted number intact. Exponents and suffixes
  // scale the displayed precision, including for fractional percentages.
  // Skip "January 2024" and "2024-01-15T00:00:00Z", and keep 12% in "2024 May 12%".
  let matches = 0;
  let count = 0;
  for (const match of summary.matchAll(SUMMARY_TOKENS)) {
    const [token, magnitude, exponent = '', suffix] = match;
    if (magnitude === undefined) continue;
    // A signed, grouped, or suffixed number is a value even beside a month name.
    const index = match.index!;
    if (BARE_YEAR.test(token)) {
      const before = summary.slice(0, index);
      const after = summary.slice(index + token.length);
      if (MONTH_BEFORE.test(before) || MONTH_AFTER.test(after) || MAY_WITH_PREPOSITION.test(before)) continue;
    }

    count++;
    const displayed = Number(magnitude.replace(/[$,]/g, ''));
    const scale = Number(`1${exponent}`) * (NUMBER_SCALES[suffix.toLowerCase()] ?? 1);
    const precision = Math.min(magnitude.split('.')[1]?.length ?? 0, 100);
    const matchesValue = (value: number) => Number.isFinite(value) && (
      Math.abs(value - displayed) <= 1e-6 * Math.max(Math.abs(value), Math.abs(displayed)) ||
      Number(value.toFixed(precision)) === displayed
    );

    if (Number.isFinite(displayed) && Number.isFinite(scale) && scale > 0 && rowNumbers.some(value =>
      matchesValue(value / scale) || (suffix === '%' && matchesValue(value / (scale / 100))),
    )) matches++;
  }
  return count === 0 ? 1 : matches / count;
}

// dbt run statuses as a conversational answer words them.
// A status word naming a rate ("pass rate", "error rate was 0%") reports a metric, not a status.
const NOT_A_RATE = /(?!\s+rates?\b)/.source;
const statusPattern = (words: string) => new RegExp(`\\b(?:${words})\\b${NOT_A_RATE}`, 'g');
const STATUS_WORDS = new Map<string, RegExp>([
  ['success', statusPattern('success(?:es|ful(?:ly)?)?|succeed(?:ed|s)?|pass(?:ed|es|ing)?')],
  ['error', statusPattern('error(?:ed|ing|s)?|fail(?:ed|s|ing|ures?)?')],
  ['skipped', statusPattern('skip(?:ped|ping|s)?')],
  ['warn', statusPattern('warn(?:ed|s|ings?)?')],
]);
// A negator up to two words before a status ("none failed", "no errors", "didn't skip")
// denies it. Sentence punctuation ends the window.
// A standalone 0 ("5 passed, 0 failed", "*0* failed") negates too; 0 in 10, 2.0, model-0, or WARN=0 does not.
const NEGATED = /(?:\b(?:none\s+of(?:\s+(?:the|these|those))?|no|none|nothing|not|never|without|zero|\w+n['’]t)|(?<=^|\s)[([*`"'“‘]*0[*`"'”’]*)\s+(?:[\w'’]+\s+){0,2}$/;

// A zero count after the status ("ERROR=0", "errors: none") denies it too.
const ZERO_COUNT = /^[*`"'”’]*\s*[:=][*`"'”’]*\s*[*`"'“‘]*(?:0|none|zero)(?!\w|\.\d)/;

function mentionsStatus(text: string, pattern: RegExp): boolean {
  for (const match of text.matchAll(pattern)) {
    const after = text.slice(match.index + match[0].length);
    if (!NEGATED.test(text.slice(0, match.index)) && !ZERO_COUNT.test(after)) return true;
  }
  return false;
}
// Only :00 seconds parse; a fact with other seconds falls back to whole-word matching.
const ISO_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::00)?(?:\.0+)?Z$/i;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTH_NAMES = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];

// A UTC timestamp counts when the answer names its date and its time of day in any common form.
function mentionsTimestamp(text: string, fact: string): boolean {
  const match = ISO_TIMESTAMP.exec(fact);
  if (!match) return false;
  const [, year, month, day, hour, minute] = match;
  const monthIndex = Number(month) - 1;
  const d = String(Number(day));
  // September also abbreviates as "Sept".
  const abbreviation = monthIndex === 8 ? 'sept?' : MONTHS[monthIndex];
  const monthWord = `(?:${abbreviation}\\.?|${MONTH_NAMES[monthIndex]})`;
  const date = new RegExp([
    `\\b${monthWord}\\s+0?${d}(?:st|nd|rd|th)?\\b`,
    `\\b0?${d}(?:st|nd|rd|th)?\\s+(?:of\\s+)?${monthWord}\\b`,
    `\\b${year}-${month}-${day}(?:\\b|(?=t\\d))`,
    `\\b0?${Number(month)}/0?${d}\\b`,
  ].join('|'));
  const h = Number(hour);
  const hour24 = h < 10 ? `0?${h}` : String(h);
  const h12 = h % 12 === 0 ? 12 : h % 12;
  const hour12 = h12 < 10 ? `0?${h12}` : String(h12);
  const am = '(?:a\\.m\\.|am)(?!\\w)';
  const pm = '(?:p\\.m\\.|pm)(?!\\w)';
  const meridiem = h < 12 ? am : pm;
  const seconds = '(?::\\d{2}(?:\\.\\d+)?)?';
  const clock = [
    // A 24-hour time, unless a meridiem follows it (then the 12-hour branch decides).
    `(?:\\b|(?<=\\dt))${hour24}:${minute}${seconds}(?![:.]?\\d)(?!\\s*(?:${am}|${pm}))`,
    `\\b${hour12}:${minute}${seconds}\\s*${meridiem}`,
  ];
  if (minute === '00') clock.push(`\\b${hour12}\\s*${meridiem}`);
  return date.test(text) && new RegExp(clock.join('|')).test(text);
}

// Whole-word containment, so "success" doesn't match inside "unsuccessful".
function containsWord(text: string, word: string): boolean {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<!\\w)${escaped}(?!\\w)`).test(text);
}

function mentionsFact(text: string, fact: string): boolean {
  const wanted = fact.toLowerCase();
  const status = STATUS_WORDS.get(wanted);
  if (status) return mentionsStatus(text, status);
  if (containsWord(text, wanted)) return true;
  if (wanted.includes('_') && containsWord(text, wanted.replaceAll('_', ' '))) return true;
  return mentionsTimestamp(text, fact);
}

export function scoreFacts(text: string, requiredFacts: string[]): number {
  const normalized = text.toLowerCase();
  return requiredFacts.length === 0 ? 1
    : requiredFacts.filter(fact => mentionsFact(normalized, fact)).length / requiredFacts.length;
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
  if (!summary.trim()) return 0;
  const numericScore = scoreSummaryNumbers(summary, item.rows);
  const context = `Question: ${item.question}\nSummary: ${summary}`;
  const rubricScore = await scoreRubric(context, ['answers the question asked'], judge);
  return (numericScore + rubricScore) / 2;
}
