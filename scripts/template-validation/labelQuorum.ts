import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import type { NodeId } from '../../src/agents/nodeProfiles.js';
import { loadLocalKnowledgeSummaries } from '../benchmarkInputs.js';
import { hashItemInput, ITEM_SCHEMAS, loadFixture, loadItems, scanTemplateSafety, type SqlGeneratorItem } from './items.js';
import type { LabelerConfig, runLabeler, SpawnFn } from './labelers.js';
import {
  CATEGORIES, draftBatchSchema, draftItemSchema, draftPrompt, fixtureSpecs, labelBatchSchema,
  labelPrompt, mutationBatchSchema, mutationPrompt, PROMPT_VERSION, templateRules, type Category, type FixtureNode,
} from './prompts.js';
import { agreeClosedSet, agreeRubric, agreeSql, validateQuorum, type QueryResultLike, type QuorumKind } from './quorum.js';
import { referenceIsOrdered, resultsEquivalent } from './resultEquivalence.js';
import { TV_ROOT } from './warehouse.js';

export interface LabelRunDeps {
  labelers: (LabelerConfig & { cliVersion?: string })[];
  runLabeler: typeof runLabeler;
  execute: (sql: string) => Promise<QueryResultLike | Error>;
  root: string;
  now: () => Date;
  spawn?: SpawnFn;
  cacheDir?: string;
}

export interface Provenance {
  version: string;
  createdAt: string;
  quorumKind: QuorumKind;
  reducedQuorum: boolean;
  singleFamily: boolean;
  drafter: string;
  members: { id: string; family: string; cliVersion: string; requestedModel: string; reportedModels: string[] }[];
  perNode: Record<string, { drafted: number; accepted: number; quarantined: number; dropRateByCategory: Record<string, number> }>;
}

const BATCH_SIZE = 20;
type Input = { category: Category } & Record<string, unknown>;
type Draft = { input: Input; expectedVerdict?: 'PASS' | 'FAIL'; mutationOf?: string };
type Quarantined = { item: Input; labels: Record<string, unknown> };
type Fixtures = Record<string, unknown>;
type DraftedFixtures = { files: Fixtures; defects: Record<string, string> };

function assertSafe(value: unknown, location: string): void {
  const violations = scanTemplateSafety(JSON.stringify(value));
  if (violations.length) {
    throw new Error(`Template safety violation in ${location} (${violations.length} findings)`);
  }
}

function batches<T>(values: T[]): T[][] {
  return Array.from({ length: Math.ceil(values.length / BATCH_SIZE) },
    (_, index) => values.slice(index * BATCH_SIZE, (index + 1) * BATCH_SIZE));
}

function readVersion(root: string): string {
  return readFileSync(join(root, 'VERSION'), 'utf8').trim();
}

function createLabelClient(deps: LabelRunDeps, version: string) {
  const cacheDir = join(deps.cacheDir ?? join(TV_ROOT, '.cache'), createHash('sha256').update(version).digest('hex'));
  const reportedModels = new Map<string, Set<string>>();
  async function request<T>(
    cfg: LabelerConfig, node: NodeId, batch: number, inputs: unknown[], prompt: string, schema: z.ZodType<T>,
  ): Promise<T> {
    const cacheKey = createHash('sha256')
      .update(JSON.stringify([PROMPT_VERSION, node, batch, inputs.map(hashItemInput), prompt]))
      .digest('hex');
    const spawn = deps.spawn ?? (() => { throw new Error('A labeler spawn function is required on a cache miss'); });
    const response = await deps.runLabeler(cfg, { prompt, schema: z.toJSONSchema(schema), cacheKey },
      spawn, cacheDir);
    if (response.reportedModel) {
      const models = reportedModels.get(cfg.id) ?? new Set<string>();
      models.add(response.reportedModel);
      reportedModels.set(cfg.id, models);
    }
    return schema.parse(response.value);
  }
  return { request, reportedModels };
}
type LabelClient = ReturnType<typeof createLabelClient>;

async function executeSql(sql: string, deps: LabelRunDeps): Promise<QueryResultLike | Error> {
  try {
    return await deps.execute(sql);
  } catch {
    return new Error('Template SQL execution failed');
  }
}

function unanimousFacts(values: string[][]): string[] {
  const normalized = values.map(facts => facts.map(fact => fact.trim()).filter(Boolean));
  const proposed = [...new Set(normalized.flat())];
  return agreeRubric(proposed, normalized.map(facts => proposed.map(fact => facts.includes(fact))));
}

async function agreedFields(
  node: NodeId, draft: Draft, labels: Record<string, unknown>[], deps: LabelRunDeps,
): Promise<Record<string, unknown> | undefined> {
  if (node === 'sqlGenerator') {
    const sqls = labels.map(label => label.referenceSql as string);
    for (const sql of sqls) assertSafe(sql, node);
    const verdict = await agreeSql(sqls, sql => executeSql(sql, deps));
    return verdict.agreed ? { referenceSql: verdict.reference } : undefined;
  }

  const result: Record<string, unknown> = {};
  for (const key of Object.keys(labels[0])) {
    const values = labels.map(label => label[key]);
    if (Array.isArray(values[0])) {
      const facts = unanimousFacts(values as string[][]);
      if (!facts.length && key !== 'requiredModels') return undefined;
      if (key === 'requiredModels' && !facts.length && values.some(value => (value as string[]).length)) return undefined;
      result[key] = facts;
      continue;
    }
    const agreement = agreeClosedSet(values as (string | boolean)[]);
    if (!agreement.agreed) return undefined;
    result[key] = agreement.value;
  }
  if (node === 'supervisor' && draft.expectedVerdict && result.expectedVerdict !== draft.expectedVerdict) return undefined;
  if (node === 'summaryOverride' && result.usable !== true) return undefined;
  if (node === 'discrepancy' && draft.input.defect !== undefined && result.defect !== draft.input.defect) return undefined;
  return result;
}

function fixtureNames(inputs: Input[]): string[] {
  return inputs.flatMap(input => [input.runHistoryFixture, input.contextFixture])
    .filter((name): name is string => typeof name === 'string');
}

function referencedFixtures(inputs: Input[], fixtures: Fixtures, root: string): Fixtures {
  return Object.fromEntries([...new Set(fixtureNames(inputs))].map(name =>
    [name, Object.hasOwn(fixtures, name) ? fixtures[name] : loadFixture(name, root)]));
}

async function labelDrafts(
  node: NodeId, drafts: Draft[], deps: LabelRunDeps, client: LabelClient,
  context = '', fixtures: Fixtures = {}, seeds: Input[] = [],
) {
  const accepted = [];
  const quarantined: Quarantined[] = [];
  const memberIds = deps.labelers.map(member => member.id);
  const seen = new Set(seeds.map(hashItemInput));
  for (const [index, batch] of batches(drafts).entries()) {
    const inputs = batch.map(draft => draft.input);
    const facts = referencedFixtures(inputs, fixtures, deps.root);
    const promptContext = Object.keys(facts).length ? context + '\nFixtures:\n' + JSON.stringify(facts) : context;
    const blindInputs = inputs.map(({ category: _category, defect: _defect, ...input }) => input);
    const prompt = labelPrompt(node, blindInputs, promptContext);
    const schema = labelBatchSchema(node, batch.length);
    const replies = [];
    for (const cfg of deps.labelers) {
      const reply = await client.request(cfg, node, index, inputs, prompt, schema);
      replies.push(reply.labels);
    }
    for (const [itemIndex, draft] of batch.entries()) {
      const labels = replies.map(reply => reply[itemIndex]);
      const fields = await agreedFields(node, draft, labels, deps);
      const inputHash = hashItemInput(draft.input);
      if (!fields || seen.has(inputHash)) {
        quarantined.push({ item: draft.input, labels: Object.fromEntries(memberIds.map((id, i) => [id, labels[i]])) });
        continue;
      }
      const item = ITEM_SCHEMAS[node].parse({
        ...draft.input, ...fields, mutationOf: draft.mutationOf, inputHash,
        id: `${node}-${inputHash.slice(0, 16)}`, agreement: { members: memberIds },
      });
      assertSafe(item, node);
      seen.add(inputHash);
      accepted.push(item);
    }
  }
  return { accepted, quarantined };
}

const teachingInput = ITEM_SCHEMAS.teachingCandidate.pick({ context: true, category: true });
const chartInput = ITEM_SCHEMAS.chart.pick({ question: true, category: true, sampleRows: true, columnNames: true });
const summaryInput = ITEM_SCHEMAS.summaryOverride.pick({ question: true, category: true, rows: true, totalRows: true, sql: true });
const discrepancyInput = draftItemSchema('discrepancy').extend({ defect: ITEM_SCHEMAS.discrepancy.shape.defect.optional() });

export async function labelNode(
  node: NodeId, drafts: unknown[], deps: LabelRunDeps,
): Promise<{ accepted: unknown[]; quarantined: { item: unknown; labels: Record<string, unknown> }[] }> {
  const { members } = validateQuorum(deps.labelers.filter(cfg => cfg.enabled !== false), true);
  const usable = { ...deps, labelers: members };
  const schema = node === 'teachingCandidate' ? teachingInput : node === 'chart' ? chartInput
    : node === 'summaryOverride' ? summaryInput : node === 'discrepancy' ? discrepancyInput : draftItemSchema(node);
  return labelDrafts(node, drafts.map(item => ({ input: schema.parse(item) })), usable, createLabelClient(usable, readVersion(deps.root)),
    await templateContext(node, deps.root));
}

async function templateContext(node: NodeId, root: string): Promise<string> {
  const modelsPath = join(root, 'dbt', 'models.yml');
  const schema = existsSync(modelsPath) ? 'Warehouse schema:\n' + readFileSync(modelsPath, 'utf8') : '';
  const knowledge = ['clarification', 'sqlGenerator', 'supervisor', 'ambiguityClassifier'].includes(node)
    ? await loadLocalKnowledgeSummaries(join(root, 'knowledge')) : [];
  return [schema, knowledge.length ? 'Local knowledge:\n' + JSON.stringify(knowledge) : ''].filter(Boolean).join('\n\n');
}

export function fixtureMentionsDefect(fixture: object, defect: string): boolean {
  const normalize = (text: string) => text.toLowerCase().replace(/\s+/g, ' ').trim();
  const normalizedDefect = normalize(defect);
  // Normalize values before JSON turns tabs and line breaks into escape sequences.
  const serialized = JSON.stringify(fixture, (_key, value: unknown) =>
    typeof value === 'string' ? normalize(value) : value);
  return normalizedDefect.length > 0 && normalize(serialized).includes(normalizedDefect);
}

async function draftFixtures(
  node: FixtureNode, count: number, drafter: LabelerConfig, context: string, client: LabelClient, reserved: Set<string>,
): Promise<DraftedFixtures> {
  const { prefix, instruction, schema } = fixtureSpecs[node];
  const fixtureCount = node === 'teachingCandidate' ? count : Math.min(count, 6);
  const names: string[] = [];
  for (let index = 1; names.length < fixtureCount; index++) {
    const name = `${prefix}-${index}`;
    if (!reserved.has(name)) names.push(name);
  }
  const files: Fixtures = {};
  const defects: Record<string, string> = {};
  for (const [index, batch] of batches(names).entries()) {
    const prompt = [
      `Draft fixtures for ${node}. Return one fixture per name in order: ${batch.join(', ')}.`,
      templateRules, instruction, context,
    ].join('\n\n');
    const fixtureBatchSchema = z.object({ fixtures: z.array(schema as z.ZodType).length(batch.length) });
    const result = await client.request(drafter, node, index, batch, prompt, fixtureBatchSchema);
    for (const [i, name] of batch.entries()) {
      const fixture = result.fixtures[i];
      assertSafe(fixture, name);
      if (node === 'discrepancy') {
        const { context, defect } = fixture as z.infer<typeof fixtureSpecs.discrepancy.schema>;
        if (fixtureMentionsDefect(context, defect)) continue;
        files[name] = context;
        defects[name] = defect;
      } else {
        files[name] = fixture;
      }
    }
  }
  return { files, defects };
}

function unpackRows(columns: string[], rows: unknown[][]): Record<string, unknown>[] {
  if (new Set(columns).size !== columns.length || columns.length === 0 ||
      rows.some(row => row.length !== columns.length)) {
    throw new Error('Drafted result rows must align with distinct columnNames');
  }
  return rows.map(row => Object.fromEntries(columns.map((column, index) => [column, row[index]])));
}

function hydrateDraft(node: NodeId, input: Input, fixtures: Fixtures): Input {
  for (const key of ['runHistoryFixture', 'contextFixture', 'resolutionFixture']) {
    if (key in input && !Object.hasOwn(fixtures, input[key] as string)) {
      throw new Error(`${node} draft references an unknown fixture`);
    }
  }
  if (node === 'teachingCandidate') {
    const context = fixtures[input.resolutionFixture as string] as Record<string, unknown>;
    return teachingInput.parse({
      category: input.category,
      context: Object.fromEntries(Object.entries(context).filter(([, value]) => value !== null)),
    });
  }
  if (node === 'chart') {
    return { ...input, sampleRows: unpackRows(input.columnNames as string[], input.sampleRows as unknown[][]) };
  }
  if (node === 'summaryOverride') {
    return summaryInput.parse({ ...input, rows: unpackRows(input.columnNames as string[], input.rows as unknown[][]) });
  }
  return input;
}

function categorySlots(count: number, seeds: Input[]): Category[] {
  const assigned = new Map(CATEGORIES.map(category => [category, seeds.filter(seed => seed.category === category).length]));
  return Array.from({ length: count }, () => {
    const category = CATEGORIES.reduce((least, next) => assigned.get(next)! < assigned.get(least)! ? next : least);
    assigned.set(category, assigned.get(category)! + 1);
    return category;
  });
}

async function draftInputs(
  node: NodeId, slots: Category[], drafter: LabelerConfig, context: string,
  { files: fixtures, defects }: DraftedFixtures, client: LabelClient,
): Promise<Draft[]> {
  if (node === 'discrepancy' && !Object.keys(fixtures).length) return [];
  const drafts: Draft[] = [];
  const fixtureContext = Object.keys(fixtures).length ? context + '\nFixtures:\n' + JSON.stringify(fixtures) : context;
  const priorInputs: Input[] = [];
  for (const [index, batch] of batches(slots).entries()) {
    const prior = priorInputs.length ? 'Avoid repeats of prior inputs:\n' + JSON.stringify(priorInputs) : '';
    const prompt = draftPrompt(node, batch, fixtureContext, prior);
    const result = await client.request(drafter, node, index, batch, prompt, draftBatchSchema(node, batch.length));
    for (const [i, item] of result.items.entries()) {
      const input = { ...item, category: batch[i] };
      const hydrated = hydrateDraft(node, input, fixtures);
      if (node === 'discrepancy') hydrated.defect = defects[hydrated.contextFixture as string];
      drafts.push({ input: hydrated });
      priorInputs.push(input);
    }
  }
  return drafts;
}

async function supervisorDrafts(
  references: SqlGeneratorItem[], count: number, deps: LabelRunDeps, context: string, client: LabelClient,
): Promise<Draft[]> {
  if (!count) return [];
  const passing: Draft[] = [];
  const failing: Draft[] = [];
  const seen = new Set<string>();
  const add = (target: Draft[], draft: Draft) => {
    const hash = hashItemInput(draft.input);
    if (!seen.has(hash)) {
      seen.add(hash);
      target.push(draft);
    }
  };
  const passTarget = Math.ceil(count / 2);
  for (const [index, batch] of batches(references).entries()) {
    const verified = [];
    for (const reference of batch) {
      assertSafe(reference, 'supervisor reference');
      const result = await executeSql(reference.referenceSql, deps);
      if (result instanceof Error) continue;
      verified.push({ reference, result });
      const { category, question, referenceSql } = reference;
      if (passing.length < passTarget) add(passing, { input: { category, question, candidateSql: referenceSql }, expectedVerdict: 'PASS' });
    }
    if (!verified.length) continue;
    if (passing.length + failing.length >= count) break;
    const inputs = verified.map(({ reference }) => ({ question: reference.question, referenceSql: reference.referenceSql }));
    const prompt = mutationPrompt(inputs, context);
    const mutationInputs = inputs.map(({ question, referenceSql }) => ({ question, candidateSql: referenceSql }));
    const replies = [];
    for (const member of deps.labelers) {
      const reply = await client.request(member, 'supervisor', index, mutationInputs, prompt, mutationBatchSchema(verified.length));
      replies.push(reply.items);
    }
    for (const [i, { reference, result }] of verified.entries()) {
      const { id, question, category, referenceSql } = reference;
      for (let mutation = 0; mutation < 2; mutation++) {
        for (const reply of replies) {
          const candidateSql = reply[i].mutations[mutation]?.trim();
          if (!candidateSql) continue;
          assertSafe(candidateSql, 'supervisor mutation');
          const input = { category, question, candidateSql };
          if (passing.length + failing.length >= count || seen.has(hashItemInput(input))) continue;
          const candidate = await executeSql(candidateSql, deps);
          if (candidate instanceof Error || resultsEquivalent(result, candidate, { ordered: referenceIsOrdered(referenceSql) })) continue;
          add(failing, { input, expectedVerdict: 'FAIL', mutationOf: id });
        }
      }
    }
    if (passing.length + failing.length >= count && passing.length >= passTarget) break;
  }
  // The hash order keeps the label prompt stable without revealing the verdict by position.
  return [...passing, ...failing.slice(0, count - passing.length)].sort((a, b) =>
    hashItemInput(a.input).localeCompare(hashItemInput(b.input)));
}

function refuseOverwrite(path: string, version: string): void {
  if (existsSync(path) && JSON.parse(readFileSync(path, 'utf8')).version === version) {
    throw new Error('Template validation set already exists, bump VERSION to relabel');
  }
}

export async function runLabelQuorum(
  opts: { nodes: NodeId[]; allowSingleFamily: boolean; drafter: string; targetCounts: Partial<Record<NodeId, number>> },
  deps: LabelRunDeps,
): Promise<Provenance> {
  const version = readVersion(deps.root);
  const provenancePath = join(deps.root, 'provenance.json');
  refuseOverwrite(provenancePath, version);
  const usable = deps.labelers.filter(cfg => cfg.enabled !== false);
  const drafter = usable.find(cfg => cfg.id === opts.drafter);
  if (!drafter) throw new Error(`Drafter ${opts.drafter} is unavailable`);
  const eligible = usable.filter(cfg => cfg.family !== drafter.family || cfg.id === drafter.id);
  const { members, kind } = validateQuorum(eligible, opts.allowSingleFamily);
  const quorumDeps = { ...deps, labelers: members };
  const client = createLabelClient(deps, version);
  const perNode: Provenance['perNode'] = {};
  const outputs = new Map<string, string>();
  const nodes = [...new Set(opts.nodes)].sort((a, b) => Number(a === 'supervisor') - Number(b === 'supervisor'));
  const retained = new Map([...new Set([...nodes, ...Object.keys(fixtureSpecs) as FixtureNode[]])].map(node => {
    const path = join(deps.root, 'items', `${node}.jsonl`);
    const items = existsSync(path) ? loadItems(node, deps.root) : [];
    return [node, nodes.includes(node) ? items.filter(item =>
      item.source === 'manual' || (item.agreement.members.length === 1 && item.agreement.members[0] === 'manual')) : items];
  }));
  const reserved = new Set(fixtureNames([...retained.values()].flat()).map(name => name.replace(/\.json$/, '')));
  const jsonLines = (items: unknown[]) => items.map(item => JSON.stringify(item) + '\n').join('');
  let references: SqlGeneratorItem[] | undefined;

  for (const node of nodes) {
    const relativePath = `items/${node}.jsonl`;
    const seeds = retained.get(node) ?? [];
    for (const seed of seeds) assertSafe(seed, node);
    const sqlNode = node === 'sqlGenerator' || node === 'supervisor';
    const target = opts.targetCounts[node] ?? (sqlNode ? 100 : 40);
    if (!Number.isSafeInteger(target) || target < 0) throw new Error(`Invalid target count for ${node}`);
    const count = Math.max(0, target - seeds.length);
    const context = count ? await templateContext(node, deps.root) : '';
    const fixtures = count && Object.hasOwn(fixtureSpecs, node)
      ? await draftFixtures(node as FixtureNode, count, drafter, context, client, reserved) : { files: {}, defects: {} };
    let drafts: Draft[];
    if (node === 'supervisor' && count) {
      if (!references && !existsSync(join(deps.root, 'items', 'sqlGenerator.jsonl'))) {
        throw new Error('Supervisor requires accepted sqlGenerator items. Check tv:setup and the template warehouse.');
      }
      drafts = await supervisorDrafts(references ?? loadItems('sqlGenerator', deps.root), count, quorumDeps, context, client);
    } else {
      drafts = await draftInputs(node, categorySlots(count, seeds), drafter, context, fixtures, client);
    }

    const { accepted, quarantined } = await labelDrafts(node, drafts, quorumDeps, client, context, fixtures.files, seeds);
    if (count > 0 && accepted.length === 0) {
      const cause = node === 'discrepancy' && drafts.length === 0
        ? 'All drafted fixtures rejected.'
        : sqlNode
          ? 'Check quorum agreement, tv:setup, and warehouse availability.'
          : 'Check quorum agreement and duplicate inputs.';
      throw new Error(`No new ${node} items were accepted. ${cause}`);
    }
    const allAccepted = [...seeds, ...accepted];
    assertSafe(quarantined, `${node} quarantine`);
    if (node === 'sqlGenerator') references = allAccepted.map(item => ITEM_SCHEMAS.sqlGenerator.parse(item));
    for (const [name, fixture] of Object.entries(fixtures.files)) {
      outputs.set(`fixtures/${name}.json`, JSON.stringify(fixture, null, 2) + '\n');
    }
    outputs.set(relativePath, jsonLines(allAccepted));
    outputs.set(`quarantine/${node}.jsonl`, jsonLines(quarantined));
    perNode[node] = {
      drafted: drafts.length, accepted: allAccepted.length, quarantined: quarantined.length,
      dropRateByCategory: Object.fromEntries(CATEGORIES.flatMap(category => {
        const drafted = drafts.filter(draft => draft.input.category === category).length;
        const dropped = quarantined.filter(({ item }) => item.category === category).length;
        return drafted ? [[category, dropped / drafted]] : [];
      })),
    };
  }

  const provenance: Provenance = {
    version, createdAt: deps.now().toISOString(), quorumKind: kind, reducedQuorum: kind === 'reduced',
    singleFamily: kind === 'single', drafter: drafter.id, perNode,
    members: members.map(member => ({
      id: member.id, family: member.family, requestedModel: member.model,
      cliVersion: usable.find(cfg => cfg.id === member.id)?.cliVersion ?? 'unknown',
      reportedModels: [...(client.reportedModels.get(member.id) ?? [])].sort(),
    })),
  };
  outputs.set('provenance.json', JSON.stringify(provenance, null, 2) + '\n');

  // Publish provenance last. A failed write leaves the run resumable from adapter caches.
  const lock = join(deps.root, '.label-quorum-publish');
  mkdirSync(lock);
  let staging: string | undefined;
  try {
    refuseOverwrite(provenancePath, version);
    if (readVersion(deps.root) !== version) {
      throw new Error('VERSION changed during labeling');
    }
    staging = mkdtempSync(join(deps.root, '.label-quorum-'));
    for (const [index, content] of [...outputs.values()].entries()) writeFileSync(join(staging, String(index)), content);
    for (const [index, name] of [...outputs.keys()].entries()) {
      const target = join(deps.root, name);
      mkdirSync(dirname(target), { recursive: true });
      renameSync(join(staging, String(index)), target);
    }
  } finally {
    if (staging) rmSync(staging, { recursive: true, force: true });
    rmSync(lock, { recursive: true, force: true });
  }
  return provenance;
}
