import { z } from 'zod';
import type { NodeId } from '../../src/agents/nodeProfiles.js';
import { ITEM_SCHEMAS } from './items.js';
import { TV_DATASET, TV_TABLES } from './warehouse.js';

export const PROMPT_VERSION = 'tv-label-v1';
export const CATEGORIES = ITEM_SCHEMAS.slackIntake.shape.category.options;
export type Category = (typeof CATEGORIES)[number];

const string = z.string();
const strings = z.array(string);
const cell = z.union([string, z.number(), z.boolean(), z.null()]);
const grid = z.array(z.array(cell)).min(1);
const escalation = ITEM_SCHEMAS.teachingCandidate.shape.context.extend({
  failedSql: string.nullable(),
  supervisorNotes: string.nullable(),
});

const drafts = {
  slackIntake: ITEM_SCHEMAS.slackIntake.pick({ text: true }),
  followUpClassifier: ITEM_SCHEMAS.followUpClassifier.pick({ thread: true, message: true }),
  ambiguityClassifier: ITEM_SCHEMAS.ambiguityClassifier.pick({ input: true }),
  clarification: ITEM_SCHEMAS.clarification.pick({ question: true }),
  teachingCandidate: z.object({ resolutionFixture: string }),
  sqlGenerator: ITEM_SCHEMAS.sqlGenerator.pick({ question: true }),
  supervisor: ITEM_SCHEMAS.supervisor.pick({ question: true, candidateSql: true }),
  dbtStatus: ITEM_SCHEMAS.dbtStatus.pick({ question: true, runHistoryFixture: true }),
  chart: ITEM_SCHEMAS.chart.pick({ question: true, columnNames: true }).extend({ sampleRows: grid }),
  summaryOverride: ITEM_SCHEMAS.summaryOverride.pick({ question: true, sql: true, totalRows: true })
    .extend({ columnNames: strings, rows: grid }),
  metaQuestion: ITEM_SCHEMAS.metaQuestion.pick({ question: true, contextFixture: true }),
  discrepancy: ITEM_SCHEMAS.discrepancy.pick({ complaint: true, contextFixture: true }),
};

export function draftItemSchema(node: NodeId) {
  return drafts[node].extend({ category: ITEM_SCHEMAS.slackIntake.shape.category });
}

export function draftBatchSchema(node: NodeId, count: number) {
  return z.object({ items: z.array(draftItemSchema(node)).length(count) });
}

const defect = z.enum(['wrong join', 'missing filter', 'wrong grain', 'wrong aggregation', 'wrong time window']);
const labels = {
  slackIntake: ITEM_SCHEMAS.slackIntake.pick({ expectedRoute: true }),
  followUpClassifier: ITEM_SCHEMAS.followUpClassifier.pick({ expectedIntent: true }),
  ambiguityClassifier: ITEM_SCHEMAS.ambiguityClassifier.pick({ expectedType: true }),
  clarification: ITEM_SCHEMAS.clarification.pick({ expectedSuspend: true }),
  teachingCandidate: ITEM_SCHEMAS.teachingCandidate.pick({ expectSanctionedSql: true, requiredModels: true }),
  sqlGenerator: ITEM_SCHEMAS.sqlGenerator.pick({ referenceSql: true }),
  supervisor: ITEM_SCHEMAS.supervisor.pick({ expectedVerdict: true }),
  dbtStatus: ITEM_SCHEMAS.dbtStatus.pick({ requiredFacts: true }),
  chart: z.object({ allowedMarks: z.array(z.enum(['bar', 'line', 'point', 'area', 'rect', 'tick', 'boxplot'])) }),
  summaryOverride: z.object({ usable: z.boolean() }),
  metaQuestion: ITEM_SCHEMAS.metaQuestion.pick({ rubric: true }),
  discrepancy: ITEM_SCHEMAS.discrepancy.pick({ rubric: true }).extend({ defect }),
};

export function labelBatchSchema(node: NodeId, count: number) {
  return z.object({ labels: z.array(labels[node]).length(count) });
}

const responseContext = z.object({
  responseId: string,
  threadTs: string,
  statusMsgTs: string,
  clarifiedQuestion: string,
  assumptions: strings,
  reasoningChain: string,
  generatedSql: string,
  explanation: string,
  tablesUsed: strings,
  confidence: z.enum(['high', 'medium', 'low']),
  primaryAgentConfidence: z.enum(['high', 'medium', 'low']),
  queryResults: z.object({
    rowCount: z.number().int().nonnegative(),
    columnNames: strings,
    bytesProcessed: z.number().int().nonnegative(),
  }),
  pipelineDurationMs: z.number().int().nonnegative(),
  traceId: string,
  createdAt: string,
  groundingCitations: z.array(z.object({ title: string, uri: string })).max(0),
  teachingsUsed: strings,
  supervisorVerdict: z.enum(['pass', 'fail_then_pass', 'exhausted']),
  supervisorNotes: string,
});

// These keys are also the on-disk fixture basenames, with a 1-based suffix.
export const fixtureSpecs = {
  dbtStatus: {
    prefix: 'dbt-history',
    instruction: 'Each fixture is a nonempty array of dbt run-history entries with ISO UTC times, covering success, error and skipped statuses. Use unqualified model names from the supplied schema.',
    schema: z.array(z.object({
      model: z.enum(TV_TABLES),
      status: z.enum(['success', 'error', 'skipped']),
      executionTime: z.number().nonnegative(),
      runId: string,
      runStartedAt: string,
      errorMessage: string.nullable(),
    })).min(1),
  },
  metaQuestion: {
    prefix: 'meta-context',
    instruction: 'Each fixture is a past ResponseContext. Vary the assumptions, reasoning, schema choices and confidence so follow-up questions can be answered from the context. Use an ISO UTC createdAt.',
    schema: responseContext,
  },
  discrepancy: {
    prefix: 'discrepancy-context',
    instruction: 'Return a context and the planted defect for each fixture. The context is a past ResponseContext with exactly one seeded SQL defect: wrong join, missing filter, wrong grain, wrong aggregation or wrong time window. Give the original question and a plausible prior answer. No fixture field in the ResponseContext, including supervisorNotes, reasoning, caveats, or any other field, may describe, hint at, or name the defect. Record the defect only in the separate defect field. Use an ISO UTC createdAt.',
    schema: z.object({ context: responseContext, defect }),
  },
  teachingCandidate: {
    prefix: 'escalation-resolution',
    instruction: 'Each fixture is a resolved escalation. Include both reusable analyst corrections and responses with no reusable SQL guidance. Use null for absent failedSql or supervisorNotes.',
    schema: escalation,
  },
};

export type FixtureNode = keyof typeof fixtureSpecs;

export const templateRules =
  'Use only synthetic examples. Omit emails, project IDs and private data. ' +
  `Use BigQuery SELECT SQL over the documented views, with every physical table written as \`${TV_DATASET}.table\`. ` +
  'Use explicit time windows and deterministic sorting with LIMIT. Keep query results under 10,000 rows.';

/**
 * Nodes whose drafted inputs are messages a person types and whose tv-v1 drafts pasted SQL into them.
 * Their drafts get these rules instead of `templateRules`, whose SQL requirement led the drafter to paste
 * a query into every message. clarification and discrepancy also take typed text but barely leaked SQL, so they
 * stay on `templateRules`; the labeling cache is keyed on prompt text, and switching them would redraft and
 * relabel them. ambiguityClassifier also stays on `templateRules`, because its assistant turns carry the prior
 * SQL: its draft instruction keeps that SQL out of user turns instead (its first tv-v2 draft leaked SQL into
 * 36 of 38 user turns before that sentence existed).
 */
const PLAIN_LANGUAGE_DRAFT_NODES: ReadonlySet<NodeId> = new Set(['slackIntake', 'followUpClassifier', 'metaQuestion', 'chart', 'dbtStatus']);

const plainLanguageRules =
  'Use only synthetic examples. Omit emails, project IDs and private data. ' +
  'Write in plain language as a person would type it in Slack, and do not include SQL. ' +
  `If you name a physical table, write it as \`${TV_DATASET}.table\`. When a message asks for data, give the time window a person would state, and keep greetings and short follow-ups natural.`;

const draftInstructions: Record<NodeId, string> = {
  slackIntake: 'Draft Slack messages covering lightweight bot interactions and requests for warehouse analytics. Include borderline messages.',
  followUpClassifier: 'Draft thread histories and final replies covering new queries, refinements, questions about the prior answer and reports of conflicting figures. Write each assistant turn as the bot\'s short answer summary with its figures.',
  ambiguityClassifier: 'Draft ambiguous questions with ambiguity descriptions, possible clarifying questions and thread context. Include cases resolved by organization knowledge and cases that require asking the user. ' +
    'Leave every ambiguity open: the thread context must not answer the clarifying question. ' +
    'Describe the competing readings without naming or hinting at who resolves them; avoid phrases such as "the organization\'s definition" or "the standard metric". ' +
    'Vary organization-knowledge cases across source-of-truth tables, required filters, exclusion rules, ownership decisions and metric definitions. ' +
    'Write user turns in plain language and put any SQL only in assistant turns.',
  clarification: 'Include clear, underspecified and knowledge-dependent questions. Every ambiguous-category slot should be ambiguous with the schema alone and clear when the supplied ReferenceCard is applied. Use the remaining slots for a mix of questions that should proceed and questions that should suspend.',
  teachingCandidate: 'Choose a supplied escalation-resolution filename (without .json) for each draft. Each fixture can be used once.',
  sqlGenerator: 'Draft answerable analytics questions with enough detail to specify an equivalent result. Each question must be answerable from the documented schema alone. Avoid organization-specific definitions.',
  supervisor: 'Use the accepted generator references and the mutation prompt.',
  dbtStatus: 'Ask about particular models, runs and times in the supplied run-history fixtures. ' +
    'Ask only what the run history itself answers: statuses, errors, skips, retries, start times and durations. ' +
    'Do not ask for rows, counts or values from the tables the models build. ' +
    'For a join slot, ask about two or more models or runs together. Use the supplied fixture keys without .json.',
  chart: 'Draft a question and a small plausible result grid. Each row is an array of scalar values in columnNames order.',
  summaryOverride: 'Draft a question, its SQL and a small plausible result grid. Each row is an array of scalar values in columnNames order. Include totalRows.',
  metaQuestion: 'Ask a follow-up about assumptions, reasoning, confidence, or the SQL in a supplied ResponseContext. The fixture already holds the SQL, so refer to it rather than pasting it. Use the supplied fixture keys without .json.',
  discrepancy: 'Write a user complaint that can be diagnosed from a supplied prior ResponseContext and its SQL. Use the supplied fixture keys without .json.',
};

const labelInstructions: Record<NodeId, string> = {
  slackIntake: 'Use immediate_response for greetings, thanks and bot help. Use analytics_pipeline for requests that need warehouse data or dbt status.',
  followUpClassifier: 'Use new_query for unrelated data requests, refinement for revisions to the previous query, meta_question for questions about how the answer was produced, and discrepancy for challenges to its correctness.',
  ambiguityClassifier: 'Choose org_knowledge if a stable organization definition can resolve the ambiguity. Choose user_intent if the user must decide.',
  clarification: 'Set expectedSuspend when answering requires asking the user for clarification. Apply the supplied local knowledge before making that decision.',
  teachingCandidate: 'Set expectSanctionedSql when the human response provides or authorizes a reusable SQL approach. List requiredModels as fully qualified dataset.table names for that approach. Use an empty list when none are required.',
  sqlGenerator: 'Independently write valid BigQuery SELECT SQL that answers each question using only the documented schema.',
  supervisor: 'Return PASS when the SQL answers the question correctly using the documented schema. Return FAIL when it has a semantic defect.',
  dbtStatus: 'List requiredFacts as separate literal model names, status tokens and ISO UTC timestamps copied verbatim from the relevant records.',
  chart: 'List every allowed mark that would faithfully encode the supplied columns and rows and answer the question.',
  summaryOverride: 'Set usable if the question and query have coherent rows that support a factual summary with no invented numbers.',
  metaQuestion: 'Give a rubric of required facts as short verbatim excerpts from the context, one per fact.',
  discrepancy: 'Locate the central SQL defect and give a rubric of required diagnostic facts. Use separate short verbatim SQL fragments or column identifiers when possible.',
};

/**
 * `examples` are retained items (a promoted node's frozen set, or a relabeled node's manual items),
 * stripped to their draft fields. Without them a promotion drafter matches neither the frozen items'
 * structure nor their difficulty.
 */
export function draftPrompt(node: NodeId, categories: Category[], context: string, priorInputs: string, examples: unknown[] = []): string {
  return [
    `Draft ${categories.length} distinct ${node} item inputs, one per slot in category order ${JSON.stringify(categories)}.`,
    PLAIN_LANGUAGE_DRAFT_NODES.has(node) ? plainLanguageRules : templateRules, draftInstructions[node],
    'Return the input fields only. Omit proposed labels, IDs and answers.',
    examples.length ? 'Match the structure, style and difficulty of these existing items without repeating them:\n' + JSON.stringify(examples) : '',
    context, priorInputs,
  ].filter(Boolean).join('\n\n');
}

export function labelPrompt(node: NodeId, inputs: unknown[], context: string): string {
  return [
    `Label each ${node} input independently. Return exactly one label per input in the same order.`,
    templateRules, labelInstructions[node], context, JSON.stringify(inputs),
  ].filter(Boolean).join('\n\n');
}

export function mutationBatchSchema(count: number) {
  return z.object({ items: z.array(z.object({ mutations: strings.max(2) })).length(count) });
}

export function mutationPrompt(references: { question: string; referenceSql: string }[], context: string): string {
  return [
    'Mutate each reference SQL query. Return one item per reference, in order, with two distinct valid queries that answer the question incorrectly. Use realistic changes such as a wrong join key, missing filter or wrong grain.',
    templateRules, context, JSON.stringify(references),
  ].join('\n\n');
}
