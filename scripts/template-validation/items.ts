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

export function loadItems<N extends NodeId>(node: N, root = TV_ROOT): Item<N>[] {
  const path = join(root, 'items', node + '.jsonl');
  const schema = ITEM_SCHEMAS[node];
  const items: Item<N>[] = [];
  for (const [index, line] of readFileSync(path, 'utf8').split('\n').entries()) {
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
const scanToken = /`{3,}|`[^`\r\n]*`|"(?:\\.|[^"\\])*"|'(?:''|\\.|[^'\\])*'|\/\*[\s\S]*?\*\/|--[^\r\n]*|#[^\r\n]*|bigquery-public-data\b|[a-z0-9_]+|\s+|./gi;
const quotedPart = /bigquery-public-data(?=$|[.-])|[^.-]+|[.-]/gi;
const endFrom = /^(?:WHERE|GROUP|HAVING|QUALIFY|WINDOW|ORDER|LIMIT|UNION|INTERSECT|EXCEPT|;)$/i;

type ScanToken = {
  value: string;
  kind: 'name' | 'quoted' | 'syntax';
  spaceBefore: boolean;
  quotedHyphen?: true;
};

function decodeScanEscapes(text: string): string {
  return text.replace(/\\([nt"])/g, (_match, escaped: string) =>
    escaped === 'n' ? '\n' : escaped === 't' ? '\t' : '"',
  );
}

function tokenizeReferences(text: string, references: Set<string>): ScanToken[] {
  const tokens: ScanToken[] = [];
  let spaceBefore = false;
  // Decode line breaks before finding comments, but keep escaped quotes inside their literals.
  const input = text.replace(/\\([nt])|\\[\\"]/g, (escape, whitespace) =>
    whitespace ? decodeScanEscapes(escape) : escape,
  );
  for (const [value] of input.matchAll(scanToken)) {
    if (/^(?:\s|`{3})/.test(value)) {
      spaceBefore = true;
      continue;
    }
    if (/^(?:\/\*|--|#)/.test(value)) {
      const body = value.startsWith('/*') ? value.slice(2, -2) :
        value.startsWith('--') ? value.slice(2) : value.slice(1);
      collectReferences(decodeScanEscapes(body), references);
      spaceBefore = true;
      continue;
    }
    if (/^["']/.test(value) && value.length > 1) {
      // Scan serialized SQL independently of the surrounding JSON or SQL literal.
      collectReferences(decodeScanEscapes(value.slice(1, -1)), references);
    }
    if (value.startsWith('`') && value.length > 1) {
      for (const [part] of value.slice(1, -1).trim().matchAll(quotedPart)) {
        const kind = part === '.' || part === '-' || !part.trim() ? 'syntax' : 'quoted';
        tokens.push({ value: part.trim(), kind, spaceBefore, ...(part === '-' && { quotedHyphen: true }) });
        spaceBefore = false;
      }
    } else {
      const kind = /^[a-z0-9_]/i.test(value) ? 'name' : 'syntax';
      tokens.push({ value, kind, spaceBefore });
      spaceBefore = false;
    }
  }
  return tokens;
}

function isAllowedChain(segments: string[]): boolean {
  const [first, second] = segments;
  const tableIndex = first === TV_DATASET ? 1 :
    first.toLowerCase() === publicProject && second === 'thelook_ecommerce' ? 2 : -1;
  return tableIndex >= 0 &&
    (segments.length === tableIndex + 1 || segments.length === tableIndex + 2) &&
    TV_TABLES.some((table) => table === segments[tableIndex]);
}

function collectReferences(text: string, references: Set<string>): void {
  const tokens = tokenizeReferences(text, references);
  const fromLists = [false];
  let tablePosition = false;

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    const depth = fromLists.length - 1;
    if (token.kind !== 'syntax') {
      const hyphen = tokens[index - 1];
      const beforeHyphen = tokens[index - 2];
      const attachedPrefix = hyphen?.value === '-' && !hyphen.spaceBefore && !token.spaceBefore &&
        beforeHyphen && beforeHyphen.kind !== 'syntax' &&
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

      const segments = [previous.value];
      let quoted = previous.kind === 'quoted';

      while (tokens[index + 1]?.value === '.') {
        const dot = tokens[index + 1];
        const next = tokens[index + 2];
        if (!next || next.kind === 'syntax') break;
        if (!tablePosition && (dot.spaceBefore || next.spaceBefore) &&
            previous.kind !== 'quoted' && next.kind !== 'quoted') break;
        segments.push(next.value);
        quoted ||= next.kind === 'quoted';
        previous = next;
        index += 2;
      }

      if (segments.length >= 2) {
        const namesTable = tablePosition || quoted || segments[0].toLowerCase() === TV_DATASET;
        // Digit-only chains in free text are numeric literals.
        const hasIdentifier = segments.some((segment) => /[a-z_]/i.test(segment));
        const prefix = tablePrefix || attachedPrefix;
        if ((namesTable || (segments.length >= 3 && hasIdentifier)) &&
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
      if (depth > 0) fromLists.pop();
      else fromLists[0] = false;
      tablePosition = false;
    } else if (endFrom.test(token.value) || (tablePosition && /^(?:SELECT|WITH)$/i.test(token.value))) {
      fromLists[depth] = false;
      tablePosition = false;
    } else if (/^FROM$/i.test(token.value)) {
      fromLists[depth] = true;
      tablePosition = true;
    } else {
      tablePosition = /^JOIN$/i.test(token.value) || (token.value === ',' && fromLists[depth]);
    }
  }
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
