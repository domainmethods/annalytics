import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { AmbiguityClassifierInput, AmbiguityType } from '../../src/agents/ambiguityClassifier.js';
import type { FollowUpIntent } from '../../src/agents/followUpClassifier.js';
import type { NodeId } from '../../src/agents/nodeProfiles.js';
import type { SlackIntakeRoute } from '../../src/agents/slackIntakeAgent.js';
import type { EscalationTeachingContext } from '../../src/teachings/candidateGenerator.js';
import type { CorpusEntry } from '../benchmark-types.js';
import { TV_DATASET, TV_ROOT, TV_TABLES } from './warehouse.js';

const strings = z.array(z.string());
const question = z.string();
const rows = z.array(z.record(z.string(), z.unknown()));
const fixtureName = z.string().regex(/^[\w-]+(?:\.[\w-]+)*$/i, 'Invalid fixture name');
const thread = z.array(z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string(),
}));
const ambiguityInput = z.object({
  question,
  ambiguities: strings,
  clarifyingQuestions: strings,
  threadContext: thread,
}) satisfies z.ZodType<AmbiguityClassifierInput>;
const teachingContext = z.object({
  escalationId: z.string(),
  originalQuestion: z.string(),
  clarifiedQuestion: z.string(),
  humanResponse: z.string(),
  failedSql: z.string().optional(),
  supervisorNotes: z.string().optional(),
}) satisfies z.ZodType<Omit<EscalationTeachingContext, 'apiKey'>>;

const item = z.object({
  id: z.string().min(1),
  category: z.enum(['simple', 'join', 'aggregate', 'time_series', 'ambiguous', 'edge_case']) satisfies z.ZodType<CorpusEntry['category']>,
  inputHash: z.string().regex(/^[a-f0-9]{64}$/),
  agreement: z.object({ members: z.array(z.string().min(1)).min(1) }),
  source: z.literal('manual').optional(),
});

const contextRubric = {
  contextFixture: fixtureName,
  rubric: strings,
};

export const ITEM_SCHEMAS = {
  slackIntake: item.extend({
    text: z.string(),
    expectedRoute: z.enum(['immediate_response', 'analytics_pipeline']) satisfies z.ZodType<SlackIntakeRoute>,
  }),
  followUpClassifier: item.extend({
    thread,
    message: z.string(),
    expectedIntent: z.enum(['new_query', 'refinement', 'meta_question', 'discrepancy']) satisfies z.ZodType<FollowUpIntent>,
  }),
  ambiguityClassifier: item.extend({
    input: ambiguityInput,
    expectedType: z.enum(['user_intent', 'org_knowledge']) satisfies z.ZodType<AmbiguityType>,
  }),
  clarification: item.extend({ question, expectedSuspend: z.boolean() }),
  teachingCandidate: item.extend({
    context: teachingContext,
    expectSanctionedSql: z.boolean(),
    requiredModels: strings,
  }),
  sqlGenerator: item.extend({ question, referenceSql: z.string() }),
  supervisor: item.extend({
    question,
    candidateSql: z.string(),
    expectedVerdict: z.enum(['PASS', 'FAIL']),
    mutationOf: z.string().optional(),
  }),
  dbtStatus: item.extend({ question, runHistoryFixture: fixtureName, requiredFacts: strings }),
  chart: item.extend({ question, columnNames: strings, sampleRows: rows, allowedMarks: strings }),
  summaryOverride: item.extend({ question, sql: z.string(), rows, totalRows: z.number().int().nonnegative() }),
  metaQuestion: item.extend({ question, ...contextRubric }),
  discrepancy: item.extend({ complaint: z.string(), ...contextRubric, defect: z.string() }),
} satisfies Record<NodeId, z.ZodType>;

export type Item<N extends NodeId> = z.infer<(typeof ITEM_SCHEMAS)[N]>;
export type SlackIntakeItem = Item<'slackIntake'>;
export type FollowUpClassifierItem = Item<'followUpClassifier'>;
export type AmbiguityClassifierItem = Item<'ambiguityClassifier'>;
export type ClarificationItem = Item<'clarification'>;
export type TeachingCandidateItem = Item<'teachingCandidate'>;
export type SqlGeneratorItem = Item<'sqlGenerator'>;
export type SupervisorItem = Item<'supervisor'>;
export type DbtStatusItem = Item<'dbtStatus'>;
export type ChartItem = Item<'chart'>;
export type SummaryOverrideItem = Item<'summaryOverride'>;
export type MetaQuestionItem = Item<'metaQuestion'>;
export type DiscrepancyItem = Item<'discrepancy'>;

export function templateTargetCount(node: NodeId): number {
  return node === 'sqlGenerator' || node === 'supervisor' ? 100 : 40;
}

export function hashItemFile(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex');
}

export function loadItems<N extends NodeId>(node: N, root = TV_ROOT, frozenDigest?: string): Item<N>[] {
  const path = join(root, 'items', node + '.jsonl');
  const schema = ITEM_SCHEMAS[node];
  const items: Item<N>[] = [];
  const bytes = readFileSync(path);
  if (frozenDigest !== undefined && hashItemFile(bytes) !== frozenDigest) {
    throw new Error(`Template corpus for ${node} does not match its frozen item digest`);
  }
  for (const [index, line] of bytes.toString('utf8').split('\n').entries()) {
    if (!line.trim()) continue;
    try {
      items.push(schema.parse(JSON.parse(line)) as Item<N>);
    } catch (cause) {
      throw new Error(`${path}:${index + 1}: invalid validation item`, { cause });
    }
  }
  return items;
}

export function loadFixture(name: string, root = TV_ROOT): unknown {
  fixtureName.parse(name);
  const filename = name.endsWith('.json') ? name : name + '.json';
  return JSON.parse(readFileSync(join(root, 'fixtures', filename), 'utf8'));
}

const publicProject = 'bigquery-public-data';
// BigQuery function namespaces: `SAFE.DIVIDE(a, b)` is a function call, not a table-valued function.
const FUNCTION_NAMESPACES = new Set(['SAFE', 'NET', 'HLL_COUNT', 'KEYS', 'AEAD', 'DETERMINISTIC', 'ML', 'AI', 'OBJ']);
const quotedPart = /bigquery-public-data(?=$|[.-])|[^.-]+|[.-]/gi;
const endFrom = /^(?:WHERE|GROUP|HAVING|QUALIFY|WINDOW|ORDER|LIMIT|UNION|INTERSECT|EXCEPT|;)$/i;

type ScanToken = {
  value: string;
  kind: 'name' | 'quoted' | 'syntax';
  spaceBefore: boolean;
  // A comment sat in the gap before this token (a comment is not a sentence break).
  commentBefore?: true;
  // A Markdown code fence sat in the gap before this token (a fence never splits a table path).
  fenceBefore?: true;
  quotedHyphen?: true;
};

function decodeScanEscapes(text: string): string {
  return text.replace(/\\([nt"\\])/g, (_match, escaped: string) =>
    escaped === 'n' ? '\n' : escaped === 't' ? '\t' : escaped,
  );
}

function findStringEnd(text: string, start: number, delimiter: string, multiline: boolean, serialized: boolean) {
  const backslash = serialized ? '\\\\' : '\\';
  let sawDoubledBackslash = false;
  let index = start;
  while (index < text.length) {
    if (!multiline && (text[index] === '\r' || text[index] === '\n')) break;
    if (text.startsWith(backslash, index)) {
      sawDoubledBackslash ||= text[index + 1] === '\\';
      index += backslash.length;
      // A SQL escape consumes one character, which may itself be JSON-escaped.
      index += serialized && /\\[nt"\\]/.test(text.slice(index, index + 2)) ? 2 : 1;
    } else if (text.startsWith(delimiter, index)) {
      if (multiline || !text.startsWith(delimiter, index + delimiter.length)) {
        return { end: index, sawDoubledBackslash };
      }
      index += 2 * delimiter.length;
    } else {
      index++;
    }
  }
  return { end: -1, sawDoubledBackslash };
}

function tokenizeReferences(
  text: string, references: Set<string>, serializedApostrophes: boolean, ordinaryQuotes = false,
) {
  // Line comments stop at physical or JSON-escaped line breaks.
  const tokenPattern = /\s+|\\[nt]|`+|\/\*[\s\S]*?\*\/|(?:--|#)(?:[^\\\r\n]|\\[^n\r\n])*(?:\\(?!n))?|["']|\\"|\\\\|[A-Za-z0-9_]+|./y;
  const publicProjectToken = /bigquery-public-data\b/iy;
  const backtickSpan = /(`{1,2})(?!`)((?:[^`\\\r\n]|\\[^`n\r\n]|\\(?=`)|`(?!`))*?)\1(?!`)/y;
  const tokens: ScanToken[] = [];
  let ambiguousApostrophe = false;
  let ambiguousTripleQuote = false;
  let spaceBefore = false;
  let commentBefore = false;
  let fenceBefore = false;
  // Consume each delimited span before classifying any of its contents.
  for (let start = 0; start < text.length; start = tokenPattern.lastIndex) {
    publicProjectToken.lastIndex = start;
    const [value] = publicProjectToken.exec(text) ?? tokenPattern.exec(text)!;
    tokenPattern.lastIndex = start + value.length;
    if (/^(?:\s|\\[nt]|`{3})/.test(value)) {
      spaceBefore = true;
      fenceBefore ||= value.startsWith('`');
      continue;
    }
    if (/^(?:\/\*|--|#)/.test(value)) {
      const body = value.startsWith('/*') ? value.slice(2, -2) :
        value.startsWith('--') ? value.slice(2) : value.slice(1);
      collectReferences(body, references, false, ordinaryQuotes);
      spaceBefore = true;
      commentBefore = true;
      continue;
    }
    if (value === '"' || value === "'" || value === '\\"') {
      const triple = value.repeat(3);
      const multiline = !ordinaryQuotes && text.startsWith(triple, start);
      ambiguousTripleQuote ||= multiline;
      const delimiter = multiline ? triple : value;
      const contentsStart = start + delimiter.length;
      const first = findStringEnd(text, contentsStart, delimiter, multiline, value === '\\"');
      let end = first.end;
      if (value === "'" && first.sawDoubledBackslash && (serializedApostrophes || !ambiguousApostrophe)) {
        const serializedEnd = findStringEnd(text, contentsStart, delimiter, multiline, true).end;
        if (serializedApostrophes) end = serializedEnd;
        else ambiguousApostrophe = serializedEnd !== end;
      }
      // Resume at the contents if the opener has no matching close.
      tokenPattern.lastIndex = contentsStart;
      if (end !== -1) {
        // A JSON string can carry SQL. Scan it with its own table-position state.
        collectReferences(decodeScanEscapes(text.slice(contentsStart, end)), references, false, ordinaryQuotes);
        tokenPattern.lastIndex = end + delimiter.length;
      }
    }
    if (value.startsWith('`')) {
      backtickSpan.lastIndex = start;
      const span = backtickSpan.exec(text);
      if (span) {
        tokenPattern.lastIndex = backtickSpan.lastIndex;
        const body = decodeScanEscapes(span[2]).trim();
        const doubleBackticks = span[1] === '``';
        const nestedIdentifier = doubleBackticks ? /^`([^`]*)`$/.exec(body)?.[1] : undefined;
        // A double-backtick span may contain SQL. Dots with padding still join identifier segments.
        // A single-backtick span with parentheses is inline code such as `COUNT(i.id)`: BigQuery
        // table paths can't contain them, so scan it as SQL rather than as one quoted identifier.
        // (Spaces alone don't make it SQL: a spaced single-backtick body stays an identifier.)
        const inlineSql = !doubleBackticks && /[()]/.test(body);
        // A dotted path right before the first parenthesis, as in `dataset.table_fn(1)`, is still a
        // quoted identifier; only the text from the parenthesis on is scanned as SQL. A BigQuery
        // function namespace such as `SAFE.DIVIDE(a, b)` is a call, so the whole span is SQL.
        // Trade-off: other SQL around a two-part path (`ds.t WHERE id IN (1)`) is scanned as prose
        // SQL, where a two-part path outside table position is not flagged.
        const calleeMatch = inlineSql ? /^[\w-]+(?:\.[\w-]+)+(?=\()/.exec(body)?.[0] : undefined;
        const callee = calleeMatch !== undefined &&
          !FUNCTION_NAMESPACES.has(calleeMatch.split('.')[0].toUpperCase()) ? calleeMatch : undefined;
        const doubleBacktickSql = doubleBackticks && nestedIdentifier === undefined &&
          body.split('.').some((part) => /[\s`()]/.test(part.trim()));
        if (doubleBacktickSql || (inlineSql && callee === undefined)) {
          collectReferences(body, references, false, ordinaryQuotes);
        } else {
          if (callee !== undefined) collectReferences(body.slice(callee.length), references, false, ordinaryQuotes);
          for (const [part] of (nestedIdentifier ?? callee ?? body).matchAll(quotedPart)) {
            const kind = part === '.' || part === '-' || !part.trim() ? 'syntax' : 'quoted';
            tokens.push({ value: part.trim(), kind, spaceBefore, ...(fenceBefore && { fenceBefore: true }),
              ...(part === '-' && { quotedHyphen: true }) });
            spaceBefore = false;
            fenceBefore = false;
          }
          commentBefore = false;
          continue;
        }
      }
    }
    const kind = /^[a-z0-9_]/i.test(value) ? 'name' : 'syntax';
    tokens.push({ value: value === '\\\\' ? '\\' : value, kind, spaceBefore, ...(commentBefore && { commentBefore: true }),
      ...(fenceBefore && { fenceBefore: true }) });
    spaceBefore = false;
    fenceBefore = false;
    commentBefore = false;
  }
  return { tokens, ambiguousApostrophe, ambiguousTripleQuote };
}

function isAllowedChain(segments: string[]): boolean {
  const [first, second] = segments;
  const tableIndex = first === TV_DATASET ? 1 :
    first.toLowerCase() === publicProject && second === 'thelook_ecommerce' ? 2 : -1;
  return tableIndex >= 0 &&
    (segments.length === tableIndex + 1 || segments.length === tableIndex + 2) &&
    TV_TABLES.some((table) => table === segments[tableIndex]);
}

/**
 * True when the FROM at `index` is the keyword inside EXTRACT(part FROM expr): exactly one
 * date-part name (optionally WEEK(<weekday>)) between `EXTRACT(` and the FROM. Any other
 * FROM, including prose such as "extract (from x.y)", still starts a table list.
 */
function isExtractKeywordFrom(tokens: ScanToken[], index: number): boolean {
  if (!/^FROM$/i.test(tokens[index]?.value ?? '') || tokens[index].kind !== 'name') return false;
  let part = index - 1;
  if (tokens[part]?.value === ')' && tokens[part - 1]?.kind === 'name' && tokens[part - 2]?.value === '(') {
    part -= 3;
  }
  return tokens[part]?.kind === 'name' && tokens[part - 1]?.value === '(' &&
    /^EXTRACT$/i.test(tokens[part - 2]?.value ?? '');
}

function collectReferences(
  text: string, references: Set<string>, serializedApostrophes = false, ordinaryQuotes = false,
): void {
  const { tokens, ambiguousApostrophe, ambiguousTripleQuote } =
    tokenizeReferences(text, references, serializedApostrophes, ordinaryQuotes);
  const fromLists = [false];
  let tablePosition = false;

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    const depth = fromLists.length - 1;
    if (token.kind !== 'syntax') {
      const hyphen = tokens[index - 1];
      const beforeHyphen = tokens[index - 2];
      const hyphenAttached = hyphen?.value === '-' && !hyphen.spaceBefore && !token.spaceBefore &&
        beforeHyphen && beforeHyphen.kind !== 'syntax';
      const attachedPrefix = hyphenAttached &&
        (hyphen.quotedHyphen || token.value.toLowerCase() === publicProject)
        ? beforeHyphen.value + '-' : '';

      let previous = token;
      let tablePrefix = '';
      while (tablePosition) {
        const separator = tokens[index + 1];
        const next = tokens[index + 2];
        if (separator?.value !== '-' || separator.spaceBefore || !next || next.spaceBefore ||
            next.kind === 'syntax') break;
        tablePrefix += previous.value + '-';
        previous = next;
        index += 2;
      }

      const chainStart = index;
      const segments = [previous.value];
      let quoted = previous.kind === 'quoted';

      while (tokens[index + 1]?.value === '.') {
        const dot = tokens[index + 1];
        const next = tokens[index + 2];
        if (!next || next.kind === 'syntax' || dot.fenceBefore || next.fenceBefore) break;
        const unquotedPair = previous.kind !== 'quoted' && next.kind !== 'quoted';
        if (!tablePosition && (dot.spaceBefore || next.spaceBefore) && unquotedPair) break;
        // In table position, "from some_column. SQL:" ends a sentence: the dot is attached,
        // whitespace (not a comment) follows, and the next word is capitalized. A spaced
        // `dataset . table`, a wrapped `dataset.\n  table` and `dataset. table` still join.
        // Deliberate gap: `FROM dataset. Table` (capitalized after the dot) is not flagged.
        if (tablePosition && !dot.spaceBefore && next.spaceBefore && !next.commentBefore &&
            unquotedPair && /^[A-Z]/.test(next.value)) break;
        segments.push(next.value);
        quoted ||= next.kind === 'quoted';
        previous = next;
        index += 2;
      }

      if (segments.length >= 2) {
        const standaloneNumber = !hyphenAttached && segments.every((segment) => /^\d+$/.test(segment));
        const prefix = tablePrefix || attachedPrefix;
        // An unquoted run of digits ("from 13.0%") is a number, not a table name.
        const bareNumber = standaloneNumber && !quoted && !prefix;
        const namesTable = (tablePosition && !bareNumber) || quoted || segments[0].toLowerCase() === TV_DATASET;
        // "Permission bigquery.tables.update denied" names an IAM permission, not a table.
        const iamPermission = !namesTable && !prefix && segments.length === 3 && segments[0] === 'bigquery' &&
          /^permissions?$/i.test(tokens[chainStart - 1]?.value ?? '');
        if ((namesTable || (segments.length >= 3 && !standaloneNumber && !iamPermission)) &&
            (prefix || !isAllowedChain(segments))) {
          references.add(prefix + segments.join('.'));
        }
        tablePosition = false;
        continue;
      }
    }

    if (token.kind === 'quoted') {
      tablePosition = false;
    } else if (token.value === '(') {
      fromLists.push(tablePosition);
    } else if (token.value === ')') {
      if (depth > 0) {
        fromLists.pop();
      } else fromLists[0] = false;
      tablePosition = false;
    // A SELECT at this depth starts a new query, so any open FROM list has ended. WITH only
    // ends one in table position, since `UNNEST(x) WITH OFFSET` sits inside a FROM list.
    } else if (endFrom.test(token.value) || /^SELECT$/i.test(token.value) ||
        (tablePosition && /^WITH$/i.test(token.value))) {
      fromLists[depth] = false;
      tablePosition = false;
    } else if (isExtractKeywordFrom(tokens, index)) {
      tablePosition = false;
    } else if (/^FROM$/i.test(token.value)) {
      fromLists[depth] = true;
      tablePosition = true;
    } else {
      tablePosition = /^JOIN$/i.test(token.value) || (token.value === ',' && fromLists[depth]);
    }
  }
  // JSON leaves apostrophe delimiters unchanged. Keep violations from both readings.
  if (ambiguousApostrophe) collectReferences(text, references, true, ordinaryQuotes);
  // A later opener can masquerade as a close and swallow part of the enclosing FROM list.
  if (ambiguousTripleQuote) collectReferences(text, references, serializedApostrophes, true);
}

export function hasSqlFrom(sql: string): boolean {
  const { tokens } = tokenizeReferences(sql, new Set(), false);
  return tokens.some(token => token.kind === 'name' && token.value.toUpperCase() === 'FROM');
}

export function scanTemplateSafety(text: string): string[] {
  const emails = text.match(/[\w.!#$%&'*+/=?^`{|}~-]+@[a-z\d-]+(?:\.[a-z\d-]+)+/gi) ?? [];
  const projects = text.match(/\bprojects\/[a-z\d][a-z\d-]*/gi) ?? [];
  const references = new Set<string>();
  collectReferences(text, references);
  return [
    ...emails.map((email) => `Email address: ${email}`),
    ...projects.map((project) => `GCP resource: ${project}`),
    ...Array.from(references, (reference) => `Foreign table reference: ${reference}`),
  ];
}

const nonInputFields = new Set([
  ...Object.keys(item.shape),
  'expectedRoute', 'expectedIntent', 'expectedType', 'expectedSuspend',
  'expectSanctionedSql', 'requiredModels', 'referenceSql', 'expectedVerdict', 'mutationOf',
  'requiredFacts', 'allowedMarks', 'rubric', 'defect',
]);

export function hashItemInput(value: unknown): string {
  const input = value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).filter(([key]) => !nonInputFields.has(key)))
    : value;
  const canonical = JSON.stringify(input, (_key, field) => {
    if (!field || typeof field !== 'object' || Array.isArray(field)) return field;
    return Object.fromEntries(Object.keys(field).sort().map((key) => [key, field[key]]));
  });
  return createHash('sha256').update(canonical).digest('hex');
}

function listFiles(root: string, directory: string, suffix?: string): string[] {
  const absolute = join(root, directory);
  if (!existsSync(absolute)) return [];
  const entries = readdirSync(absolute, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory() && !suffix) return listFiles(root, path);
    return entry.isFile() && (!suffix || entry.name.endsWith(suffix)) ? [path] : [];
  });
}

export function hashValidationSet(root = TV_ROOT): string {
  const paths = [
    'VERSION',
    ...listFiles(root, 'items', '.jsonl'),
    ...listFiles(root, 'knowledge'),
    ...listFiles(root, 'fixtures'),
    ...listFiles(root, 'dbt', '.json'),
  ].sort();
  const hash = createHash('sha256');
  for (const path of paths) {
    const bytes = readFileSync(join(root, path));
    // Frame each file with its path and byte count so file boundaries are unambiguous.
    hash.update(JSON.stringify([path, bytes.length])).update(bytes);
  }
  return hash.digest('hex');
}
