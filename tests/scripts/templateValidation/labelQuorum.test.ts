import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { availableLabelers, checkTemplateRelations, executeTemplateSql } from '../../../scripts/template-validation/label-quorum.js';
import * as runner from '../../../src/execution/runner.js';
import { initBigQuery } from '../../../src/validation/dryRun.js';
import { labelNode, runLabelQuorum, type LabelRunDeps } from '../../../scripts/template-validation/labelQuorum.js';
import { hashItemInput, loadFixture, loadItems } from '../../../scripts/template-validation/items.js';
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
  expect(loadItems('supervisor', root).sort((a, b) => a.candidateSql.localeCompare(b.candidateSql))).toEqual([
    expect.objectContaining({ candidateSql: reference, expectedVerdict: 'PASS' }),
    expect.objectContaining({ candidateSql: broken, expectedVerdict: 'FAIL', mutationOf: loadItems('sqlGenerator', root)[0].id }),
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
  await expect(run()).rejects.toThrow('bump VERSION to relabel');
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
  rmSync(join(root, 'provenance.json'));
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
    members: labelers.map(({ id, family, model }) => ({ id, family, requestedModel: model, reportedModels: ['reported-model'] })),
    perNode: { slackIntake: { drafted: 1, accepted: 1, quarantined: 0, dropRateByCategory: { simple: 0 } } },
  });
  expect(JSON.parse(readFileSync(join(root, 'provenance.json'), 'utf8'))).toEqual(result);
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
  expect(loadItems('slackIntake', root)).toEqual([
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
  expect(loadFixture('dbt-history-1', root)).toEqual([expect.objectContaining({ model: 'orders' })]);
  expect(loadItems('dbtStatus', root)[0].requiredFacts).toEqual([expectedFact]);
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
const allowedTable = { datasetId: 'tv_thelook', tableId: 'orders' };
const foreignTable = { datasetId: 'elsewhere', tableId: 'orders' };

it('checks every dry-run reference and rejects missing metadata for FROM', () => {
  expect(checkTemplateRelations(relationSql, [allowedTable])).toBeUndefined();
  expect(checkTemplateRelations(relationSql, [allowedTable, foreignTable])).toBeInstanceOf(Error);
  expect(checkTemplateRelations(relationSql, [])).toBeInstanceOf(Error);
  expect(checkTemplateRelations(relationSql, undefined)).toBeInstanceOf(Error);
  expect(checkTemplateRelations("SELECT 'FROM' AS label", [])).toBeUndefined();
});

it('blocks foreign dry-run references before executing and rejects federated SQL before validation', async () => {
  initBigQuery('test-project');
  const dryRunJob = (referencedTables: typeof allowedTable[]) => ({
    metadata: { statistics: { totalBytesProcessed: '100', query: { statementType: 'SELECT', referencedTables } } },
  });
  mockCreateQueryJob.mockReset().mockResolvedValueOnce([dryRunJob([foreignTable])])
    .mockResolvedValueOnce([dryRunJob([allowedTable])]);
  const execute = vi.spyOn(runner, 'executeQuery').mockResolvedValue({
    columnNames: [], rows: [], truncated: false, bytesProcessed: 0, totalRows: 0,
  });
  await expect(executeTemplateSql('SELECT * FROM eXtErNaL_QuErY("c", "SELECT 1")')).resolves.toBeInstanceOf(Error);
  expect(mockCreateQueryJob).not.toHaveBeenCalled();
  await expect(executeTemplateSql(relationSql)).resolves.toBeInstanceOf(Error);
  expect(execute).not.toHaveBeenCalled();

  await expect(executeTemplateSql(relationSql)).resolves.not.toBeInstanceOf(Error);
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
  expect(loadFixture('dbt-history-2', root)).toEqual(history);
  expect(loadItems('dbtStatus', root)).toEqual([seed, expect.objectContaining({ runHistoryFixture: 'dbt-history-2' })]);
});

it('stores the planted discrepancy defect outside the context and checks blind labels against it', async () => {
  const context = {
    responseId: 'fixture-1', threadTs: '1', statusMsgTs: '2', clarifiedQuestion: 'Count only returned orders.',
    assumptions: [], reasoningChain: 'Count matching rows.', generatedSql: 'SELECT COUNT(*) FROM tv_thelook.orders',
    explanation: 'Counted orders.', tablesUsed: ['tv_thelook.orders'], confidence: 'high', primaryAgentConfidence: 'high',
    queryResults: { rowCount: 1, columnNames: ['n'], bytesProcessed: 100 }, pipelineDurationMs: 100,
    traceId: 'fixture-trace', createdAt: '2026-01-01T00:00:00Z', groundingCitations: [],
    teachingsUsed: [], supervisorVerdict: 'pass', supervisorNotes: '',
  };
  let diagnosed = 'missing filter';
  deps.runLabeler = vi.fn(async (_cfg, { prompt }) => ({
    cached: false,
    value: prompt.startsWith('Draft fixtures') ? { fixtures: [{ context, defect: 'missing filter' }] }
      : prompt.startsWith('Draft') ? {
        items: [{ category: 'edge_case', complaint: 'That count looks high.', contextFixture: 'discrepancy-context-1' }],
      } : { labels: [{ defect: diagnosed, rubric: ['COUNT(*)'] }] },
  }));
  const discrepancy = { nodes: ['discrepancy'] as ['discrepancy'], targetCounts: { discrepancy: 1 } };
  await run(discrepancy);
  expect(loadFixture('discrepancy-context-1', root)).toEqual(context);
  expect(loadItems('discrepancy', root)).toEqual([expect.objectContaining({ defect: 'missing filter' })]);
  const blindPrompts = vi.mocked(deps.runLabeler).mock.calls.filter(([, { prompt }]) => prompt.startsWith('Label'));
  expect(blindPrompts).toHaveLength(2);
  for (const [, { prompt }] of blindPrompts) {
    expect(prompt).toContain(context.generatedSql);
    expect(prompt).not.toMatch(/missing filter|"defect"/);
  }

  writeFileSync(join(root, 'VERSION'), 'tv-v2\n');
  diagnosed = 'wrong grain';
  await run(discrepancy);
  expect(loadItems('discrepancy', root)).toEqual([]);
  expect(readFileSync(join(root, 'quarantine', 'discrepancy.jsonl'), 'utf8')).toContain('"defect":"missing filter"');
});
