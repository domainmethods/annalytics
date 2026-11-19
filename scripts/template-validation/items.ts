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
import { TV_DATASET, TV_ROOT } from './warehouse.js';

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

const sqlComment = /--[^\n]*|\/\*[\s\S]*?\*\//;
const dotTrivia = `(?:[\\s]|(?:${sqlComment.source}))*`;
const separator = `${dotTrivia}\\.${dotTrivia}`;
const quotedName = /`[\w.*-]+`/.source;
const identifier = /[a-z_](?:[\w-]*\w)?/.source;
const tableSegment = `(?:${quotedName}|[\\w*](?:[\\w*-]*[\\w*])?)`;
const name = `(?:${quotedName}|${identifier})`;
const sqlName = `(?:${quotedName}|[a-z_](?:\\w|-(?!-))*)`;
const sqlTableSegment = `(?:${quotedName}|[\\w*](?:[\\w*]|-(?!-))*)`;
const sqlTablePath = `${sqlName}(?:${separator}${sqlTableSegment})*`;
const textTablePath = new RegExp(`(?<![\\w.-])${name}(?:${separator}${tableSegment})*`, 'gi');
const pathTrivia = new RegExp(`(${quotedName})|(${sqlComment.source})|\\s+`, 'g');
const endFrom = /^(?:WHERE|GROUP|ORDER|LIMIT|HAVING|QUALIFY|WINDOW|UNION|INTERSECT|EXCEPT|;)$/i;

function normalizeTablePath(path: string, onComment?: (content: string) => void): string {
  return path.replace(pathTrivia, (_match, quoted?: string, comment?: string) => {
    if (comment) onComment?.(comment.slice(2));
    return quoted ? quoted.slice(1, -1) : '';
  });
}

function collectTextTables(text: string, tables: Set<string>): void {
  for (const [path] of text.matchAll(textTablePath)) {
    const reference = normalizeTablePath(path, (comment) => {
      collectTextTables(comment, tables);
      if (/\b(?:FROM|JOIN)\b/i.test(comment)) collectSqlTables(comment, tables);
    });
    const count = reference.split('.').length;
    if (count >= 3) {
      // A period followed by whitespace also ends an abbreviation or a sentence.
      if (/^v?\d+(?:\.\d+){2,}$/i.test(path) ||
          /^(?:[a-z]\.){2,}\s+[a-z]+$/i.test(path) ||
          /^(?:[A-Z][a-z]+\.\s+){2,}[A-Z][a-z]+$/.test(path)) continue;
      tables.add(reference);
    } else if (count === 2 && path.includes('`')) {
      if (/^(?:`[\w-]+`\.\s+[A-Z][a-z]+|[A-Za-z]+\.\s+`[\w-]+`)$/.test(path)) continue;
      tables.add(reference);
    }
  }
}

function isAllowedTable(reference: string): boolean {
  return reference.startsWith(TV_DATASET + '.') ||
    reference.startsWith('bigquery-public-data.thelook_ecommerce.');
}

function collectSqlTables(text: string, tables: Set<string>): void {
  const tokens = text.match(new RegExp(
    sqlComment.source + '|' + /'(?:''|\\.|[^'\\])*'|"(?:\\.|[^"\\])*"/.source +
      '|' + sqlTablePath + '|[(),;]',
    'gi',
  )) ?? [];
  const fromLists = [false];
  let expectsTable = false;
  for (const token of tokens) {
    const depth = fromLists.length - 1;
    if (/^(?:--|\/\*|['"])/.test(token)) {
      if (/\b(?:FROM|JOIN)\b/i.test(token)) {
        const content = token.startsWith('--') ? token.slice(2) :
          token.startsWith('/*') ? token.slice(2, -2) : token.slice(1, -1);
        collectSqlTables(content.replace(/\\n/g, '\n').replace(/\\[rt]/g, ' ').replace(/\\"/g, '"'), tables);
      }
      continue;
    }
    if (token === '(') {
      fromLists.push(expectsTable);
      continue;
    } else if (token === ')') {
      if (depth > 0) fromLists.pop();
      else fromLists[0] = false;
    } else if (endFrom.test(token)) {
      fromLists[depth] = false;
    } else if (/^FROM$/i.test(token)) {
      fromLists[depth] = true;
      expectsTable = true;
      continue;
    } else if (/^JOIN$/i.test(token) || (token === ',' && fromLists[depth])) {
      expectsTable = true;
      continue;
    } else if (expectsTable) {
      if (/^(?:SELECT|WITH)$/i.test(token)) fromLists[depth] = false;
      const reference = normalizeTablePath(token);
      if (reference.includes('.')) tables.add(reference);
    }
    expectsTable = false;
  }
}

export function scanTemplateSafety(text: string): string[] {
  const emails = text.match(/[\w.!#$%&'*+/=?^`{|}~-]+@[a-z\d-]+(?:\.[a-z\d-]+)+/gi) ?? [];
  const projects = text.match(/\bprojects\/[a-z\d][a-z\d-]*/gi) ?? [];
  const tables = new Set<string>();

  // shortcut: lexical scan, use a parser if dialect-specific table syntax needs coverage
  collectSqlTables(text, tables);
  collectTextTables(text, tables);

  const foreignRefs = [...tables].filter((reference) => !isAllowedTable(reference));
  return [
    ...emails.map((email) => `Email address: ${email}`),
    ...projects.map((project) => `GCP resource: ${project}`),
    ...foreignRefs.map((reference) => `Foreign table reference: ${reference}`),
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
