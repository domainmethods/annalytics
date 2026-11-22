import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { availableLabelers, checkTemplateRelations, executeTemplateSql } from '../../../scripts/template-validation/label-quorum.js';
import * as runner from '../../../src/execution/runner.js';
import { NODE_IDS, type NodeId } from '../../../src/agents/nodeProfiles.js';
import { initBigQuery } from '../../../src/validation/dryRun.js';
import { fixtureMentionsDefect, labelNode, runLabelQuorum, type LabelRunDeps } from '../../../scripts/template-validation/labelQuorum.js';
import { hashItemInput, loadFixture, loadItems } from '../../../scripts/template-validation/items.js';
import { resultsEquivalent } from '../../../scripts/template-validation/resultEquivalence.js';
import { buildRefreshRows, writeRefreshReport } from '../../../scripts/template-validation/refreshReport.js';
import { loadLabelers, runLabeler, type SpawnFn } from '../../../scripts/template-validation/labelers.js';

const mockCreateQueryJob = vi.hoisted(() => vi.fn());
vi.mock('@google-cloud/bigquery', () => ({
  BigQuery: class { createQueryJob = mockCreateQueryJob; },
}));

const version = 'tv-v1';
const labelers = loadLabelers().slice(0, 2);
const draft = { category: 'simple', text: 'How many orders were placed?' };
const route = { expectedRoute: 'analytics_pipeline' };
const options = {
  nodes: ['slackIntake'] as const,
  allowSingleFamily: false,
  drafter: 'claude',
  targetCounts: { slackIntake: 1 },
};
const claude = (value: unknown) => ({
  code: 0,
  stdout: JSON.stringify({ type: 'result', subtype: 'success', structured_output: value, model: 'claude-reported' }),
});

let root: string;
let deps: LabelRunDeps;
const run = (overrides: Partial<Parameters<typeof runLabelQuorum>[0]> = {}) =>
  runLabelQuorum({ ...options, nodes: [...options.nodes], ...overrides }, deps);

function partialRoot(nodes: NodeId[] = ['slackIntake']): string {
  const currentVersion = readFileSync(join(root, 'VERSION'), 'utf8').trim();
  return join(deps.cacheDir!, createHash('sha256').update(currentVersion).digest('hex'), 'partial', [...nodes].sort().join('-'));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tv-quorum-test-'));
  writeFileSync(join(root, 'VERSION'), version + '\n');
  deps = {
    labelers,
    root,
    now: () => new Date('2026-11-18T12:00:00Z'),
    execute: vi.fn(async () => ({ columnNames: ['n'], rows: [{ n: 1 }] })),
    runLabeler: vi.fn(async (_cfg, { prompt }) => ({
      value: prompt.startsWith('Draft') ? { items: [draft] } : { labels: [route] },
      reportedModel: 'reported-model',
      cached: false,
    })),
    spawn: vi.fn<SpawnFn>(),
    cacheDir: join(root, 'cache'),
  };
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

it('accepts unanimous items and quarantines splits without exposing labels between calls', async () => {
  const split = { category: 'edge_case', text: 'Thanks, how did you get that?' };
  deps.runLabeler = vi.fn(async (cfg) => ({
    value: { labels: [route, cfg.id === 'claude' ? { expectedRoute: 'immediate_response' } : route] },
    cached: false,
  }));
  const result = await labelNode('slackIntake', [{ ...draft, expectedRoute: 'drafter-secret' }, split], deps);
  expect(result.accepted).toEqual([expect.objectContaining(route)]);
  expect(result.quarantined).toEqual([{
    item: expect.objectContaining(split),
    labels: { claude: { expectedRoute: 'immediate_response' }, codex: route },
  }]);
  for (const [, { prompt }] of vi.mocked(deps.runLabeler).mock.calls) {
    expect(prompt).toContain(split.text);
    expect(prompt).not.toMatch(/drafter-secret|"category"|"expectedRoute"/);
  }
});

it('keeps synthetic knowledge out of SQL drafting, mutation and blind labeling', async () => {
  mkdirSync(join(root, 'dbt'));
  writeFileSync(join(root, 'dbt', 'models.yml'), 'models: [orders]');
  mkdirSync(join(root, 'knowledge', 'references'), { recursive: true });
  writeFileSync(join(root, 'knowledge', 'references', 'revenue.yml'),
    readFileSync('benchmarks/template-validation/knowledge/references/thelook-metrics.yml', 'utf8'));

  const question = 'How many orders were placed?';
  const referenceSql = 'SELECT 1 AS n';
  const candidateSql = 'SELECT 2 AS n';
  deps.execute = vi.fn(async sql => ({ columnNames: ['n'], rows: [{ n: sql === referenceSql ? 1 : 2 }] }));
  deps.runLabeler = vi.fn(async (_cfg, { prompt }) => ({
    cached: false,
    value: prompt.startsWith('Draft') ? { items: [{ question, category: 'simple' }] }
      : prompt.startsWith('Mutate') ? { items: [{ mutations: [candidateSql] }] }
        : prompt.startsWith('Label each sqlGenerator') ? { labels: [{ referenceSql }] }
          : { labels: [{ expectedVerdict: 'PASS' }, { expectedVerdict: 'FAIL' }] },
  }));

  await run({ nodes: ['sqlGenerator', 'supervisor'], targetCounts: { sqlGenerator: 1, supervisor: 2 } });
  const prompts = vi.mocked(deps.runLabeler).mock.calls.map(([, { prompt }]) => prompt);
  expect(prompts).toEqual(expect.arrayContaining([
    expect.stringMatching(/^Draft 1 .* sqlGenerator/),
    expect.stringMatching(/^Mutate each/),
    expect.stringMatching(/^Label each sqlGenerator/),
    expect.stringMatching(/^Label each supervisor/),
  ]));
  for (const prompt of prompts) {
    expect(prompt).toContain('Warehouse schema:');
    expect(prompt).not.toContain('Local knowledge:');
  }
});

it('discards equivalent and invalid supervisor SQL mutations before blind labeling', async () => {
  const reference = 'SELECT 1 AS n';
  const broken = 'SELECT 2 AS n';
  deps.execute = vi.fn(async (sql) =>
    sql === 'invalid SQL' ? new Error('invalid') : { columnNames: ['n'], rows: [{ n: sql === broken ? 2 : 1 }] });
  deps.runLabeler = vi.fn(async (cfg, { prompt }) => ({
    cached: false,
    value: prompt.startsWith('Draft') ? { items: [{ category: 'simple', question: 'Return one.' }] }
      : prompt.startsWith('Mutate') ? { items: [{ mutations: cfg.id === 'claude' ? ['SELECT  1 AS n', broken] : ['invalid SQL', broken] }] }
      : prompt.includes('"candidateSql"')
        ? { labels: (JSON.parse(prompt.split('\n\n').at(-1)!) as { candidateSql: string }[])
          .map(({ candidateSql }) => ({ expectedVerdict: candidateSql === broken ? 'FAIL' : 'PASS' })) }
      : { labels: [{ referenceSql: reference }] },
  }));
  await run({ nodes: ['supervisor', 'sqlGenerator'], targetCounts: { sqlGenerator: 1, supervisor: 2 } });
  expect(loadItems('supervisor', partialRoot(['sqlGenerator', 'supervisor'])).sort((a, b) => a.candidateSql.localeCompare(b.candidateSql))).toEqual([
    expect.objectContaining({ candidateSql: reference, expectedVerdict: 'PASS' }),
    expect.objectContaining({ candidateSql: broken, expectedVerdict: 'FAIL', mutationOf: loadItems('sqlGenerator', partialRoot(['sqlGenerator', 'supervisor']))[0].id }),
  ]);
  expect(deps.execute).toHaveBeenCalledWith('invalid SQL');
  expect(deps.execute).toHaveBeenCalledWith('SELECT  1 AS n');
  const blindPrompt = vi.mocked(deps.runLabeler).mock.calls.find(([, { prompt }]) =>
    prompt.startsWith('Label') && prompt.includes('"candidateSql"'))![1].prompt;
  expect(blindPrompt).not.toContain('mutationOf');
});

it('aborts before publishing any output when an accepted item violates template safety', async () => {
  vi.mocked(deps.runLabeler).mockImplementation(async (_cfg, { prompt }) => ({
    cached: false,
    value: prompt.startsWith('Draft') ? { items: [{ ...draft, text: 'Ask private@example.com' }] } : { labels: [route] },
  }));
  await expect(run()).rejects.toThrow(/template safety/i);
  for (const name of ['items', 'quarantine', 'fixtures', 'provenance.json']) {
    expect(existsSync(join(root, name))).toBe(false);
  }
});

it('refuses to overwrite provenance at the same VERSION before drafting', async () => {
  writeFileSync(join(root, 'provenance.json'), JSON.stringify({ version }));
  await expect(run({ nodes: NODE_IDS })).rejects.toThrow('bump VERSION to relabel');
  expect(deps.runLabeler).not.toHaveBeenCalled();
});

it('resumes without spawning in the same VERSION and spawns again after a bump', async () => {
  deps.runLabeler = runLabeler;
  deps.spawn = vi.fn<SpawnFn>(async (cmd, args) => {
    if (cmd === 'claude') return claude({ labels: [route] });
    const value = args.some(arg => arg.startsWith('Draft')) ? { items: [draft] } : { labels: [route] };
    return {
      code: 0,
      stdout: [
        { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(value) } },
        { type: 'turn.completed' },
      ].map(event => JSON.stringify(event)).join('\n'),
    };
  });
  await run({ drafter: 'codex' });
  expect(deps.spawn).toHaveBeenCalledTimes(3);
  vi.mocked(deps.spawn).mockClear();
  await run({ drafter: 'codex' });
  expect(deps.spawn).not.toHaveBeenCalled();

  writeFileSync(join(root, 'VERSION'), 'tv-v2\n');
  await expect(run({ drafter: 'codex' })).resolves.toMatchObject({ version: 'tv-v2' });
  expect(deps.spawn).toHaveBeenCalledTimes(3);
});

it('records reduced quorum and reported models for two families', async () => {
  const result = await run();
  expect(result).toMatchObject({
    version, createdAt: '2026-11-18T12:00:00.000Z', quorumKind: 'reduced', reducedQuorum: true, singleFamily: false,
    members: labelers.map(({ id, family, model, isolation }) => ({ id, family, isolation, requestedModel: model, reportedModels: ['reported-model'] })),
    perNode: { slackIntake: { drafted: 1, accepted: 1, quarantined: 0, dropRateByCategory: { simple: 0 } } },
  });
  expect(JSON.parse(readFileSync(join(partialRoot(), 'provenance.json'), 'utf8'))).toEqual(result);
});

it('excludes an unavailable labeler before quorum validation', async () => {
  const spawn: SpawnFn = vi.fn(async (cmd) => ({ stdout: '1.2.3', code: cmd === 'claude' ? 0 : 1 }));
  deps.labelers = await availableLabelers(labelers, spawn, vi.fn());
  expect(deps.labelers).toEqual([expect.objectContaining({ id: 'claude', cliVersion: '1.2.3' })]);
  await expect(run()).rejects.toThrow('--allow-single-family');
  expect(deps.runLabeler).not.toHaveBeenCalled();
});

it('records agreement members and counts manual seeds toward the target', async () => {
  const seed = loadItems('slackIntake')[0];
  mkdirSync(join(root, 'items'));
  writeFileSync(join(root, 'items', 'slackIntake.jsonl'), JSON.stringify(seed) + '\n');
  await run({ targetCounts: { slackIntake: 2 } });
  expect(loadItems('slackIntake', partialRoot())).toEqual([
    seed,
    expect.objectContaining({ ...draft, ...route, inputHash: hashItemInput(draft), agreement: { members: ['claude', 'codex'] } }),
  ]);
});

const history = [{
  model: 'orders', status: 'success', executionTime: 1, runId: 'synthetic-1',
  runStartedAt: '2026-01-01T09:00:00Z', errorMessage: null,
}];

it('drafts fixture content before its dependent node and keeps only unanimous facts', async () => {
  const expectedFact = 'orders';
  deps.runLabeler = vi.fn(async (cfg, { prompt }) => ({
    cached: false,
    value: prompt.startsWith('Draft fixtures') ? { fixtures: [history] }
      : prompt.startsWith('Draft') ? { items: [{ category: 'time_series', question: 'Did orders build?', runHistoryFixture: 'dbt-history-1' }] }
      : { labels: [{ requiredFacts: [expectedFact, cfg.id] }] },
  }));
  await run({ nodes: ['dbtStatus'], targetCounts: { dbtStatus: 1 } });
  const calls = vi.mocked(deps.runLabeler).mock.calls;
  expect(calls[0][1].prompt).toMatch(/^Draft fixtures.*dbt/i);
  expect(calls[1][1].prompt).toContain(history[0].runId);
  expect(calls[2][1].prompt).toContain(history[0].runId);
  expect(loadFixture('dbt-history-1', partialRoot(['dbtStatus']))).toEqual([expect.objectContaining({ model: 'orders' })]);
  expect(loadItems('dbtStatus', partialRoot(['dbtStatus']))[0].requiredFacts).toEqual([expectedFact]);
});

it('aborts before publishing any node if a drafted fixture violates template safety', async () => {
  deps.runLabeler = vi.fn(async (_cfg, { prompt }) => ({
    cached: false,
    value: prompt.startsWith('Draft fixtures')
      ? { fixtures: [[{ ...history[0], errorMessage: 'private@example.com' }]] }
      : prompt.startsWith('Draft') ? { items: [draft] } : { labels: [route] },
  }));
  await expect(run({ nodes: ['slackIntake', 'dbtStatus'], targetCounts: { slackIntake: 1, dbtStatus: 1 } }))
    .rejects.toThrow(/template safety/i);
  expect(existsSync(join(root, 'items'))).toBe(false);
  expect(existsSync(join(root, 'fixtures'))).toBe(false);
});

it('drafts and labels 20 inputs at a time and spreads them across categories', async () => {
  const messages = Array.from({ length: 40 }, (_, i) => ({ ...draft, text: `Count orders for region ${i}.` }));
  let nextDraft = 0;
  deps.runLabeler = vi.fn(async (_cfg, { prompt }) => {
    if (prompt.startsWith('Draft 20')) {
      const items = messages.slice(nextDraft, nextDraft + 20);
      nextDraft += 20;
      return { cached: false, value: { items } };
    }
    return { cached: false, value: { labels: Array.from({ length: 20 }, () => route) } };
  });
  const provenance = await run({ targetCounts: {} });
  expect(provenance.perNode.slackIntake).toMatchObject({ drafted: 40, accepted: 40, quarantined: 0 });
  expect(Object.keys(provenance.perNode.slackIntake.dropRateByCategory)).toHaveLength(6);
  expect(deps.runLabeler).toHaveBeenCalledTimes(6);
});

const relationSql = 'SELECT * FROM tv_thelook.orders';
const projectId = 'test-project';
const approvedView = { projectId, datasetId: 'tv_thelook', tableId: 'orders' };
const sourceTable = { projectId: 'bigquery-public-data', datasetId: 'thelook_ecommerce', tableId: 'orders' };

it('accepts exact TheLook lineage for a query that names an approved view', () => {
  expect(checkTemplateRelations(relationSql, projectId, {
    referencedTables: [sourceTable], referencedLogicalViews: [approvedView],
  })).toBeUndefined();
  expect(checkTemplateRelations(relationSql, projectId, { referencedTables: [sourceTable] })).toBeUndefined();
  expect(checkTemplateRelations(relationSql, projectId, { referencedLogicalViews: [approvedView] })).toBeUndefined();
  expect(checkTemplateRelations(relationSql, projectId, { referencedTables: [approvedView] })).toBeUndefined();
  expect(checkTemplateRelations(
    'WITH selected AS (SELECT * FROM `tv_thelook.orders`) SELECT * FROM selected',
    projectId, { referencedTables: [sourceTable] },
  )).toBeUndefined();
});

it.each([
  { ...sourceTable, projectId: 'other-project' },
  { ...sourceTable, datasetId: 'elsewhere' },
  { ...sourceTable, tableId: 'unknown' },
  { ...approvedView, projectId: 'other-project' },
  { ...approvedView, projectId: undefined },
])('rejects off-allowlist metadata %j', table => {
  expect(checkTemplateRelations(relationSql, projectId, {
    referencedTables: [sourceTable, table], referencedLogicalViews: [approvedView],
  })).toBeInstanceOf(Error);
});

it('rejects direct sources, foreign views and missing relation evidence', () => {
  const metadata = { referencedTables: [sourceTable], referencedLogicalViews: [approvedView] };
  expect(checkTemplateRelations('SELECT * FROM `bigquery-public-data.thelook_ecommerce.orders`', projectId, metadata))
    .toBeInstanceOf(Error);
  expect(checkTemplateRelations('SELECT * FROM `other-project.tv_thelook.orders`', projectId, metadata))
    .toBeInstanceOf(Error);
  expect(checkTemplateRelations('SELECT * FROM orders', projectId, metadata)).toBeInstanceOf(Error);
  expect(checkTemplateRelations(relationSql, projectId, {
    ...metadata, referencedLogicalViews: [{ ...approvedView, projectId: 'other-project' }],
  })).toBeInstanceOf(Error);
  expect(checkTemplateRelations(relationSql, projectId, {})).toBeInstanceOf(Error);
  expect(checkTemplateRelations("SELECT 'FROM' AS label", projectId, {})).toBeUndefined();
});

it('uses dry-run table and view metadata before executing and blocks federated SQL up front', async () => {
  initBigQuery(projectId);
  const dryRunJob = (referencedLogicalViews: typeof approvedView[]) => ({
    metadata: { statistics: { totalBytesProcessed: '100', query: {
      statementType: 'SELECT', referencedTables: [sourceTable], referencedLogicalViews,
    } } },
  });
  mockCreateQueryJob.mockReset().mockResolvedValueOnce([dryRunJob([{ ...approvedView, projectId: 'other-project' }])])
    .mockResolvedValueOnce([dryRunJob([approvedView])]);
  const execute = vi.spyOn(runner, 'executeQuery').mockResolvedValue({
    columnNames: ['n'], rows: [], truncated: false, bytesProcessed: 0, totalRows: 0,
  });
  await expect(executeTemplateSql('SELECT * FROM eXtErNaL_QuErY("c", "SELECT 1")', projectId)).resolves.toBeInstanceOf(Error);
  expect(mockCreateQueryJob).not.toHaveBeenCalled();
  await expect(executeTemplateSql(relationSql, projectId)).resolves.toBeInstanceOf(Error);
  expect(execute).not.toHaveBeenCalled();

  await expect(executeTemplateSql(relationSql, projectId)).resolves.not.toBeInstanceOf(Error);
  expect(mockCreateQueryJob.mock.calls).toEqual([
    [{ query: relationSql, dryRun: true, useLegacySql: false }],
    [{ query: relationSql, dryRun: true, useLegacySql: false }],
  ]);
  expect(execute).toHaveBeenCalledWith(relationSql, { maxRows: 10_000, timeoutMs: 60_000, maxBytes: 1024 ** 3 });
});

it.each(['sqlGenerator', 'supervisor'] as const)('does not publish an empty %s set after warehouse failures', async node => {
  const sql = 'SELECT 1';
  const reference = {
    id: 'reference', category: 'simple', question: 'Return one.', referenceSql: sql,
    inputHash: hashItemInput({ question: 'Return one.' }), agreement: { members: ['manual'] },
  };
  if (node === 'supervisor') {
    mkdirSync(join(root, 'items'));
    writeFileSync(join(root, 'items', 'sqlGenerator.jsonl'), JSON.stringify(reference) + '\n');
  }
  deps.execute = vi.fn(async () => new Error('warehouse unavailable'));
  deps.runLabeler = vi.fn(async (_cfg, { prompt }) => ({
    cached: false,
    value: prompt.startsWith('Draft') ? { items: [{ category: 'simple', question: reference.question }] }
      : { labels: [{ referenceSql: sql }] },
  }));

  await expect(run({ nodes: [node], targetCounts: { [node]: 1 } })).rejects.toThrow(/tv:setup|warehouse/i);
  for (const name of [`items/${node}.jsonl`, 'quarantine', 'fixtures', 'provenance.json']) {
    expect(existsSync(join(root, name))).toBe(false);
  }
});

it('reserves fixture filenames used by retained items with or without an extension', async () => {
  mkdirSync(join(root, 'items'));
  mkdirSync(join(root, 'fixtures'));
  const seedInput = { category: 'simple', question: 'Did orders fail?', runHistoryFixture: 'dbt-history-1.json' };
  const seed = {
    ...seedInput, id: 'seed', inputHash: hashItemInput(seedInput),
    agreement: { members: ['manual'] }, requiredFacts: ['error'],
  };
  const originalFixture = [{ ...history[0], status: 'error' }];
  writeFileSync(join(root, 'fixtures', 'dbt-history-1.json'), JSON.stringify(originalFixture));
  writeFileSync(join(root, 'items', 'dbtStatus.jsonl'), JSON.stringify(seed) + '\n');
  deps.runLabeler = vi.fn(async (_cfg, { prompt }) => ({
    cached: false,
    value: prompt.startsWith('Draft fixtures') ? { fixtures: [history] }
      : prompt.startsWith('Draft') ? {
        items: [{ ...seedInput, question: 'Did orders succeed?', runHistoryFixture: 'dbt-history-2' }],
      } : { labels: [{ requiredFacts: ['success'] }] },
  }));

  await run({ nodes: ['dbtStatus'], targetCounts: { dbtStatus: 2 } });
  expect(loadFixture('dbt-history-1', root)).toEqual(originalFixture);
  expect(loadFixture('dbt-history-2', partialRoot(['dbtStatus']))).toEqual(history);
  expect(loadItems('dbtStatus', partialRoot(['dbtStatus']))).toEqual([seed, expect.objectContaining({ runHistoryFixture: 'dbt-history-2' })]);
});

const discrepancyContext = {
  responseId: 'fixture-1', threadTs: '1', statusMsgTs: '2', clarifiedQuestion: 'Count only returned orders.',
  assumptions: [], reasoningChain: 'Count matching rows.', generatedSql: 'SELECT COUNT(*) FROM tv_thelook.orders',
  explanation: 'Counted orders.', tablesUsed: ['tv_thelook.orders'], confidence: 'high', primaryAgentConfidence: 'high',
  queryResults: { rowCount: 1, columnNames: ['n'], bytesProcessed: 100 }, pipelineDurationMs: 100,
  traceId: 'fixture-trace', createdAt: '2026-01-01T00:00:00Z', groundingCitations: [],
  teachingsUsed: [], supervisorVerdict: 'pass', supervisorNotes: '',
};

it('stores the planted discrepancy defect outside the context and checks blind labels against it', async () => {
  const context = discrepancyContext;
  let diagnosed = 'missing filter';
  deps.runLabeler = vi.fn(async (_cfg, { prompt }) => ({
    cached: false,
    value: prompt.startsWith('Draft fixtures') ? {
      fixtures: [{ context, defect: 'missing filter' }, { context, defect: 'missing filter' }],
    } : prompt.startsWith('Draft') ? {
      items: ['That count looks high.', 'Why is the total so large?'].map((complaint, index) => ({
        category: 'edge_case', complaint, contextFixture: `discrepancy-context-${index + 1}`,
      })),
    } : { labels: [diagnosed, 'missing filter'].map(defect => ({ defect, rubric: ['COUNT(*)'] })) },
  }));
  const discrepancy = { nodes: ['discrepancy'] as ['discrepancy'], targetCounts: { discrepancy: 2 } };
  await run(discrepancy);
  expect(loadFixture('discrepancy-context-1', partialRoot(['discrepancy']))).toEqual(context);
  expect(loadItems('discrepancy', partialRoot(['discrepancy'])).map(item => item.defect)).toEqual(['missing filter', 'missing filter']);
  const blindPrompts = vi.mocked(deps.runLabeler).mock.calls.filter(([, { prompt }]) => prompt.startsWith('Label'));
  expect(blindPrompts).toHaveLength(2);
  for (const [, { prompt }] of blindPrompts) {
    expect(prompt).toContain(context.generatedSql);
    expect(prompt).not.toMatch(/missing filter|"defect"/);
  }

  writeFileSync(join(root, 'VERSION'), 'tv-v2\n');
  diagnosed = 'wrong grain';
  await run(discrepancy);
  expect(loadItems('discrepancy', partialRoot(['discrepancy']))).toEqual([expect.objectContaining({ contextFixture: 'discrepancy-context-2' })]);
  expect(readFileSync(join(partialRoot(['discrepancy']), 'quarantine', 'discrepancy.jsonl'), 'utf8')).toContain('"defect":"missing filter"');
});

it('detects planted defect text in any fixture field after case and whitespace normalization', () => {
  expect(fixtureMentionsDefect({ supervisorNotes: 'Diagnosis: MISSING\t\n FILTER.' }, ' missing  filter ')).toBe(true);
  expect(fixtureMentionsDefect({ details: { caveats: ['Possible wrong\u00a0grain'] } }, 'WRONG GRAIN')).toBe(true);
  expect(fixtureMentionsDefect({ reasoningChain: 'Count matching rows.' }, 'missing filter')).toBe(false);
});

it('drops a fixture that gives the answer in supervisorNotes before either blind labeler sees it', async () => {
  const leakingContext = { ...discrepancyContext, supervisorNotes: 'The query has a missing filter.' };
  deps.runLabeler = vi.fn(async (_cfg, { prompt }) => ({
    cached: false,
    value: prompt.startsWith('Draft fixtures') ? {
      fixtures: [
        { context: leakingContext, defect: 'missing filter' },
        { context: discrepancyContext, defect: 'missing filter' },
      ],
    } : prompt.startsWith('Draft') ? {
      items: ['That count looks high.', 'Why is the total so large?'].map(complaint => ({
        category: 'edge_case', complaint, contextFixture: 'discrepancy-context-2',
      })),
    } : { labels: Array.from({ length: 2 }, () => ({ defect: 'missing filter', rubric: ['COUNT(*)'] })) },
  }));

  await run({ nodes: ['discrepancy'], targetCounts: { discrepancy: 2 } });

  const prompts = vi.mocked(deps.runLabeler).mock.calls.map(([, { prompt }]) => prompt);
  expect(prompts[0]).toMatch(/no fixture field.*(?:describe|hint|name)/i);
  expect(prompts[1]).not.toContain('discrepancy-context-1');
  const blind = prompts.filter(prompt => prompt.startsWith('Label'));
  expect(blind).toHaveLength(2);
  for (const prompt of blind) expect(prompt).not.toMatch(/missing\s+filter/i);
  expect(existsSync(join(partialRoot(['discrepancy']), 'fixtures', 'discrepancy-context-1.json'))).toBe(false);
  expect(loadFixture('discrepancy-context-2', partialRoot(['discrepancy']))).toEqual(discrepancyContext);
  expect(loadItems('discrepancy', partialRoot(['discrepancy']))).toHaveLength(2);
});

it('abort preserves prior discrepancy items and publishes nothing when all drafted fixtures are rejected', async () => {
  const itemPath = join(root, 'items', 'discrepancy.jsonl');
  const prior = { category: 'simple', complaint: 'This total seems high.', contextFixture: 'prior-context' };
  const itemBytes = JSON.stringify({
    ...prior, id: 'prior-item', inputHash: hashItemInput(prior), agreement: { members: ['claude', 'codex'] },
    defect: 'missing filter', rubric: ['COUNT(*)'],
  }) + '\n';
  mkdirSync(join(root, 'items'));
  writeFileSync(itemPath, itemBytes);
  const provenancePath = join(root, 'provenance.json');
  const priorProvenance = JSON.stringify({ version: 'tv-v0' }) + '\n';
  writeFileSync(provenancePath, priorProvenance);
  deps.runLabeler = vi.fn(async (_cfg, { prompt }) => ({
    cached: false,
    value: prompt.startsWith('Draft fixtures') ? {
      fixtures: [{ context: { ...discrepancyContext, supervisorNotes: 'Missing filter' }, defect: 'missing filter' }],
    } : prompt.startsWith('Draft') ? { items: [draft] } : { labels: [route] },
  }));

  await expect(run({
    nodes: ['slackIntake', 'discrepancy'], targetCounts: { slackIntake: 1, discrepancy: 1 },
  })).rejects.toThrow(/discrepancy.*all drafted fixtures rejected/i);
  const discrepancyCalls = vi.mocked(deps.runLabeler).mock.calls.filter(([, { prompt }]) => prompt.includes('discrepancy'));
  expect(discrepancyCalls).toHaveLength(1);
  expect(discrepancyCalls[0][1].prompt).toMatch(/^Draft fixtures/);
  for (const path of ['fixtures', 'quarantine', 'items/slackIntake.jsonl']) {
    expect(existsSync(join(root, path))).toBe(false);
  }
  expect(readFileSync(itemPath, 'utf8')).toBe(itemBytes);
  expect(readFileSync(provenancePath, 'utf8')).toBe(priorProvenance);
});

it('aborts when a closed-set node has a positive remaining target and no unanimous labels', async () => {
  const seed = loadItems('slackIntake')[0];
  const itemPath = join(root, 'items', 'slackIntake.jsonl');
  const itemBytes = JSON.stringify(seed) + '\n';
  mkdirSync(join(root, 'items'));
  writeFileSync(itemPath, itemBytes);
  deps.runLabeler = vi.fn(async (cfg, { prompt }) => ({
    cached: false,
    value: prompt.startsWith('Draft') ? { items: [draft] } : {
      labels: [cfg.id === 'claude' ? route : { expectedRoute: 'immediate_response' }],
    },
  }));

  await expect(run({ targetCounts: { slackIntake: 2 } })).rejects.toThrow(/slackIntake.*quorum/i);
  expect(readFileSync(itemPath, 'utf8')).toBe(itemBytes);
  expect(existsSync(join(root, 'provenance.json'))).toBe(false);
});

it('strips workload credentials from real CLI subprocesses while preserving their own login', () => {
  const configDir = join(root, 'benchmarks', 'template-validation');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, 'labelers.json'), JSON.stringify([labelers[0]]));
  const credentialNames = [
    'GOOGLE_APPLICATION_CREDENTIALS', 'CLOUDSDK_CONFIG', 'GOOGLE_CLOUD_PROJECT', 'GCLOUD_PROJECT', 'GCP_PROJECT_ID',
    'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'SLACK_BOT_TOKEN', 'WHATSAPP_ACCESS_TOKEN', 'DBT_WEBHOOK_SECRET',
    'AWS_ACCESS_KEY_ID', 'OPENAI_API_KEY',
  ];
  const names = ['HOME', 'CLAUDE_CODE_OAUTH_TOKEN', ...credentialNames];
  const observedPath = join(root, 'env.json');
  writeFileSync(join(root, 'claude'), [
    `#!${process.execPath}`,
    `require('node:fs').writeFileSync(${JSON.stringify(observedPath)}, JSON.stringify(Object.fromEntries(`,
    `  ${JSON.stringify(names)}.map(name => [name, process.env[name]])`,
    ')));',
    "console.log('fake CLI version');",
  ].join('\n'), { mode: 0o700 });

  const result = spawnSync(process.execPath, [
    '--import', resolve('node_modules/tsx/dist/loader.mjs'), resolve('scripts/template-validation/label-quorum.ts'),
  ], {
    cwd: root, encoding: 'utf8',
    env: {
      ...Object.fromEntries(credentialNames.map(name => [name, 'synthetic-credential'])),
      PATH: root, HOME: root, CLAUDE_CODE_OAUTH_TOKEN: 'synthetic-cli-login',
    },
  });
  expect(result.stderr).toContain('--allow-single-family');
  expect(JSON.parse(readFileSync(observedPath, 'utf8'))).toEqual({
    HOME: root, CLAUDE_CODE_OAUTH_TOKEN: 'synthetic-cli-login',
  });
});

it('keeps unequal empty projections distinct through the template executor', async () => {
  initBigQuery(projectId);
  runner.initBigQueryClient(projectId);
  mockCreateQueryJob.mockReset().mockImplementation(async ({ query }) => [{
    metadata: { statistics: { totalBytesProcessed: '0', query: { statementType: 'SELECT' } } },
    getQueryResults: async () => [[], null, {
      jobComplete: true, totalRows: '0',
      schema: { fields: [
        { name: 'a', type: 'INTEGER' },
        ...(query.includes('AS b') ? [{ name: 'b', type: 'INTEGER' }] : []),
      ] },
    }],
    getMetadata: async () => [{ statistics: { totalBytesProcessed: '0' } }],
  }]);
  const reference = await executeTemplateSql('SELECT 1 AS a WHERE FALSE', projectId);
  const candidate = await executeTemplateSql('SELECT 1 AS a, 2 AS b WHERE FALSE', projectId);
  expect(reference).toMatchObject({ columnNames: ['a'], rows: [] });
  expect(candidate).toMatchObject({ columnNames: ['a', 'b'], rows: [] });
  if (reference instanceof Error || candidate instanceof Error) throw new Error('Expected empty query evidence');
  expect(resultsEquivalent(reference, candidate, { ordered: false })).toBe(false);
});

it('rejects empty template execution without schema evidence', async () => {
  initBigQuery(projectId);
  runner.initBigQueryClient(projectId);
  mockCreateQueryJob.mockReset().mockResolvedValue([{
    metadata: { statistics: { totalBytesProcessed: '0', query: { statementType: 'SELECT' } } },
    getQueryResults: async () => [[], null, { jobComplete: true, totalRows: '0' }],
    getMetadata: async () => [{ statistics: { totalBytesProcessed: '0' } }],
  }]);
  await expect(executeTemplateSql('SELECT 1 AS a WHERE FALSE', projectId)).resolves.toMatchObject({
    code: 'sql-execution', warehouseFailure: true,
  });
});

it('quarantines each item in a malformed member batch and keeps other member labels', async () => {
  const second = { ...draft, text: 'How many orders shipped?' };
  deps.runLabeler = runLabeler;
  deps.spawn = async cmd => cmd === 'claude'
    ? claude({ labels: [route, route] })
    : { code: 0, stdout: '{"type":"item.completed","unfinished":"synthetic-output' };

  await expect(labelNode('slackIntake', [draft, second], deps)).resolves.toEqual({
    accepted: [],
    quarantined: [draft, second].map(item => ({
      item, labels: { claude: route, codex: { failure: 'invalid-response' } },
    })),
  });
});

it('preserves sanitized quarantine in the ignored cache when a malformed batch prevents freezing', async () => {
  deps.runLabeler = runLabeler;
  deps.spawn = async (cmd, args) => cmd === 'claude'
    ? claude(args.some(arg => arg.startsWith('Draft')) ? { items: [draft] } : { labels: [route] })
    : { code: 0, stdout: 'Incomplete synthetic output' };

  await expect(run()).rejects.toThrow('No new slackIntake items were accepted');
  expect(existsSync(join(root, 'provenance.json'))).toBe(false);
  const [quarantinePath] = readdirSync(deps.cacheDir!, { recursive: true, encoding: 'utf8' })
    .filter(path => path.endsWith('quarantine/slackIntake.jsonl'));
  expect(quarantinePath).toBeDefined();
  expect(JSON.parse(readFileSync(join(deps.cacheDir!, quarantinePath), 'utf8'))).toMatchObject({
    labels: { claude: route, codex: { failure: 'invalid-response' } },
  });
});

it('propagates labeler setup errors before it can record quarantine', async () => {
  deps.runLabeler = runLabeler;
  deps.spawn = async () => { throw new Error('Missing CLI executable'); };
  await expect(labelNode('slackIntake', [draft], deps)).rejects.toThrow('Missing CLI executable');
});

it.each([false, true])('keeps partial labels out of the root set with prior frozen provenance: %s', async olderFrozen => {
  const original = JSON.stringify(loadItems('slackIntake')[0]) + '\n';
  const path = join(root, 'items', 'slackIntake.jsonl');
  mkdirSync(join(root, 'items'));
  writeFileSync(path, original);
  const prior = JSON.stringify({ version: 'tv-v0', perNode: {
    slackIntake: { itemsSha256: createHash('sha256').update(original).digest('hex') },
  } });
  const provenancePath = join(root, 'provenance.json');
  if (olderFrozen) writeFileSync(provenancePath, prior);

  const labeled = await run({ targetCounts: { slackIntake: 2 } });
  expect(loadItems('slackIntake', partialRoot(), labeled.perNode.slackIntake.itemsSha256)).toHaveLength(2);
  expect(readFileSync(path, 'utf8')).toBe(original);
  if (olderFrozen) expect(readFileSync(provenancePath, 'utf8')).toBe(prior);
  else expect(existsSync(provenancePath)).toBe(false);
  await expect(run({ targetCounts: { slackIntake: 2 } })).resolves.toMatchObject({ version });
});

const fullLabelOptions = {
  nodes: NODE_IDS,
  targetCounts: { ...Object.fromEntries(NODE_IDS.map(node => [node, 0])), slackIntake: 1 },
  allowSingleFamily: true,
};

it('resumes a full publish from cached batches after a dead writer left staged files', async () => {
  const dead = spawnSync(process.execPath, ['-e', '']);
  expect(dead.status).toBe(0);
  const interrupted = join(root, '.cache', 'publish', String(dead.pid));
  mkdirSync(interrupted, { recursive: true });
  writeFileSync(join(interrupted, '0'), 'abandoned staged content');

  deps.labelers = [labelers[0]];
  deps.runLabeler = runLabeler;
  deps.spawn = vi.fn<SpawnFn>(async (_cmd, args) =>
    claude(args.some(arg => arg.startsWith('Draft')) ? { items: [draft] } : { labels: [route] }));
  await run({ allowSingleFamily: true });
  vi.mocked(deps.spawn).mockClear();

  mkdirSync(join(root, 'items'));
  writeFileSync(join(root, 'items', 'slackIntake.jsonl'), JSON.stringify({
    ...draft, ...route, id: 'interrupted', inputHash: hashItemInput(draft), agreement: { members: ['claude'] },
  }) + '\n');

  const frozen = await run(fullLabelOptions);
  expect(deps.spawn).not.toHaveBeenCalled();
  expect(loadItems('slackIntake', root, frozen.perNode.slackIntake.itemsSha256)[0].id).not.toBe('interrupted');
  expect(JSON.parse(readFileSync(join(root, 'provenance.json'), 'utf8'))).toEqual(frozen);
  expect(existsSync(interrupted)).toBe(false);
  expect(readdirSync(root).filter(name => name.startsWith('.label-quorum-'))).toEqual([]);
});

it('leaves an active publisher lock intact and still allows scratch labeling', async () => {
  const active = join(root, '.cache', 'publish', String(process.ppid));
  mkdirSync(active, { recursive: true });

  await expect(run()).resolves.toMatchObject({ version });
  await expect(run(fullLabelOptions)).rejects.toThrow(/publish.*in progress/i);
  expect(existsSync(active)).toBe(true);
  expect(existsSync(join(root, 'provenance.json'))).toBe(false);
});

it('rejects a non-executed fixture with an ambiguous triple-quoted FROM list at publication', async () => {
  const generatedSql = `SELECT * FROM tv_thelook.orders o
JOIN tv_thelook.users u ON u.note = """First line
Second line
, private_dataset.customers c
WHERE c.note = """Another
note"""`;
  deps.runLabeler = vi.fn(async (_cfg, { prompt }) => ({
    cached: false,
    value: prompt.startsWith('Draft fixtures') ? {
      fixtures: [{ context: { ...discrepancyContext, generatedSql }, defect: 'missing filter' }],
    } : prompt.startsWith('Draft') ? {
      items: [{ category: 'simple', complaint: 'This seems high.', contextFixture: 'discrepancy-context-1' }],
    } : { labels: [{ defect: 'missing filter', rubric: ['filter orders'] }] },
  }));
  await expect(run({
    ...fullLabelOptions, targetCounts: { ...fullLabelOptions.targetCounts, slackIntake: 0, discrepancy: 1 },
  })).rejects.toThrow(/Template safety violation.*discrepancy-context-1/);
  expect(deps.execute).not.toHaveBeenCalled();
  for (const name of ['items', 'fixtures', 'quarantine', 'provenance.json']) {
    expect(existsSync(join(root, name))).toBe(false);
  }
});

it.each(['reportedModel', 'cliVersion'])('rejects unsafe CLI %s before publishing any artifacts', async field => {
  const foreign = 'projects/synthetic-unapproved/locations/us/models/example';
  if (field === 'cliVersion') deps.labelers = labelers.map(cfg => ({ ...cfg, cliVersion: foreign }));
  else vi.mocked(deps.runLabeler).mockImplementation(async (_cfg, { prompt }) => ({
    cached: false, reportedModel: foreign,
    value: prompt.startsWith('Draft') ? { items: [draft] } : { labels: [route] },
  }));
  await expect(run(fullLabelOptions)).rejects.toThrow('Template safety violation in provenance.json');
  for (const name of ['items', 'fixtures', 'quarantine', 'provenance.json']) {
    expect(existsSync(join(root, name))).toBe(false);
  }
});

it('reports a 1-of-40 chart corpus as underfilled even when its candidate scores perfectly', async () => {
  let draftIndex = 0;
  let codexBatches = 0;
  deps.runLabeler = vi.fn(async (cfg, { prompt }) => {
    if (prompt.startsWith('Draft')) {
      return { cached: false, value: {
        items: Array.from({ length: 20 }, () => ({
          category: 'simple', question: `Plot the count for order group ${++draftIndex}.`,
          columnNames: ['count'], sampleRows: [[7]],
        })),
      } };
    }
    const keepFirst = cfg.id === 'codex' && codexBatches++ === 0;
    return { cached: false, value: {
      labels: Array.from({ length: 20 }, (_, i) => ({
        allowedMarks: cfg.id === 'claude' || (keepFirst && i === 0) ? ['bar'] : ['line'],
      })),
    } };
  });
  const provenance = await run({ nodes: ['chart'], targetCounts: {} });
  const baseline = { label: 'DEFAULT', metric: 1, e2e: 1, p95LatencyMs: 1, cost: 1 };
  const chosen = { ...baseline, label: 'flash-lite/3.5@minimal', cost: 0.5 };
  const chosenRung = { tier: 'flash-lite', version: '3.5', thinkingLevel: 'minimal' } as const;
  const rows = buildRefreshRows([{
    nodeId: 'chart', baseline, chosen, chosenRung, stage1Winner: chosenRung,
    stage1: [chosen], stage2: [chosen], e2eCritical: false,
  }], new Map([['chart', 0.01]]), provenance);
  await writeRefreshReport(root, rows, { setVersion: version, setHash: 'test', date: '2026-11-18', provenance });
  const base = join(root, '2026-11-18-model-refresh');
  expect(JSON.parse(readFileSync(base + '.json', 'utf8')).rows).toMatchObject([{
    node: 'chart', acceptedCount: 1, dropRate: 0.975, applicable: false, applicationReason: 'underfilled corpus',
  }]);
  const markdown = readFileSync(base + '.md', 'utf8');
  expect(markdown).toContain('| Accepted | Drop rate |');
  expect(markdown.split('\n').find(line => line.startsWith('| chart |')))
    .toContain('| 1 | 97.5% | false | underfilled corpus |');
});
