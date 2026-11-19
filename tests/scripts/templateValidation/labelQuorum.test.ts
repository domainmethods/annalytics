import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { availableLabelers } from '../../../scripts/template-validation/label-quorum.js';
import { labelNode, runLabelQuorum, type LabelRunDeps } from '../../../scripts/template-validation/labelQuorum.js';
import { hashItemInput, loadFixture, loadItems } from '../../../scripts/template-validation/items.js';
import { loadLabelers, runLabeler, type SpawnFn } from '../../../scripts/template-validation/labelers.js';

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
afterEach(() => rmSync(root, { recursive: true, force: true }));

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

it('resumes using cached drafts and labels without spawning again', async () => {
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
