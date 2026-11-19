import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { main, type PerEntry } from '../../../scripts/node-sweep.js';
import { hashItemInput, loadItems } from '../../../scripts/template-validation/items.js';
import { createTemplateRunner, loadTemplateEnv } from '../../../scripts/template-validation/runners.js';
import { defaultProfileForNode } from '../../../src/agents/nodeProfiles.js';

const { generateContent } = vi.hoisted(() => ({ generateContent: vi.fn() }));
vi.mock('@google/genai', () => ({ GoogleGenAI: class { models = { generateContent }; } }));
vi.mock('node:fs/promises', { spy: true });
vi.mock('../../../scripts/template-validation/items.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../../scripts/template-validation/items.js')>(),
  loadItems: vi.fn(),
  hashValidationSet: () => 'test-hash',
}));
vi.mock('../../../scripts/template-validation/runners.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../../scripts/template-validation/runners.js')>(),
  createTemplateRunner: vi.fn(),
  loadTemplateEnv: vi.fn(),
}));

beforeEach(() => {
  if (typeof process.loadEnvFile === 'function') vi.spyOn(process, 'loadEnvFile').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it.each([
  'regression', 'reference outage', 'candidate rejection', 'default comparator', 'paired outage',
  'paired exhaustion', 'stable picked exhaustion',
] as const)(
  'writes the correct supervisor decision and failure evidence for %s',
  async scenario => {
    vi.stubEnv('GCP_PROJECT_ID', 'test-project');
    vi.stubEnv('GEMINI_API_KEY', 'test-key');
    const defaultSql = defaultProfileForNode('sqlGenerator');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const realFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.mocked(readFile).mockImplementation(async (path, options) => {
      if (String(path).endsWith('/VERSION')) return 'test';
      if (String(path).endsWith('/provenance.json')) return JSON.stringify({
        version: 'test', members: [],
        perNode: Object.fromEntries(['sqlGenerator', 'supervisor'].map(node => [node, {
          itemsSha256: 'a'.repeat(64), drafted: 100, accepted: 100, quarantined: 0, dropRateByCategory: {},
        }])),
      });
      return realFs.readFile(path, options);
    });
    vi.mocked(loadItems).mockImplementation(node => Array.from({ length: 100 }, (_, i) => ({
      id: `${node}-${i}`,
    })) as ReturnType<typeof loadItems>);
    vi.mocked(loadTemplateEnv).mockResolvedValue({
      apiKey: 'test', tables: [], knowledge: [], execute: vi.fn(), judge: vi.fn(),
    });
    let defaults = 0;
    vi.mocked(createTemplateRunner).mockImplementation(node => async () => {
      const overrides = JSON.parse(process.env.NODE_PROFILE_OVERRIDES ?? '{}');
      const sqlPick = !!overrides.sqlGenerator;
      const supervisorPick = !!overrides.supervisor;
      const paired = node === 'sqlGenerator' && supervisorPick;
      const baseline = node === 'sqlGenerator' && !sqlPick && !paired;
      if (baseline) defaults++;
      const comparesExhaustion = scenario === 'paired exhaustion' || scenario === 'stable picked exhaustion';
      const exhausted = baseline ? 12 : paired && scenario === 'paired exhaustion' ? 30 : 25;
      const count = node === 'supervisor' ? (supervisorPick ? 100 : 90)
        : paired ? (comparesExhaustion ? 95 : 85) : sqlPick ? (scenario === 'default comparator' ? 80 : 95) : 80;
      const failure: PerEntry['failure'] = scenario === 'reference outage' && baseline && defaults <= 2
        ? { category: 'reference', code: 'sql-execution' }
        : scenario === 'candidate rejection' && node === 'sqlGenerator' && sqlPick && !paired
          ? { category: 'candidate', code: 'sql-validation' }
          : scenario === 'paired outage' && paired
            ? { category: 'warehouse', code: 'sql-execution' }
            : undefined;
      return { perEntry: Array.from({ length: 100 }, (_, index) => ({
        id: String(index), clarificationPassed: false, overallScore: Number(index < count),
        sqlGenMetric: Number(index < count), ...(index === 99 && failure ? { failure } : {}),
        ...(node === 'sqlGenerator' && comparesExhaustion && { exhausted: index < exhausted }),
      })), nodeUsage: new Map() };
    });

    const dir = await mkdtemp(join(tmpdir(), 'template-cli-'));
    try {
      await main(['--corpus', 'template', '--node', 'supervisor', '--node', 'sqlGenerator'], dir);
      const jsonFile = (await realFs.readdir(dir)).find(file => file.endsWith('.json'))!;
      const jsonText = await readFile(join(dir, jsonFile), 'utf8');
      const json = JSON.parse(jsonText);
      const markdown = await readFile(join(dir, jsonFile.replace(/\.json$/, '.md')), 'utf8');
      const [sql, supervisor] = json.rows;
      expect(sql.node).toBe('sqlGenerator');
      expect(supervisor.node).toBe('supervisor');
      if (scenario === 'reference outage') {
        expect(sql).toMatchObject({ applicable: false, applicationReason: 'Infrastructure failures affected the comparison.' });
        expect(sql.failureCounts).toEqual([{
          profile: `${defaultSql.tier}/${defaultSql.version}@${defaultSql.thinkingLevel}`,
          category: 'reference', code: 'sql-execution', count: 2,
        }]);
        expect(markdown).toContain('reference / sql-execution');
      } else if (scenario === 'paired outage') {
        expect(supervisor).toMatchObject({ applicable: false, applicationReason: 'Infrastructure failures affected the comparison.' });
        expect(supervisor.failureCounts).toEqual([{
          profile: expect.stringContaining(' + '), category: 'warehouse', code: 'sql-execution', count: 1,
        }]);
        expect(sql.applicable).toBe(true);
      } else if (scenario === 'default comparator' || scenario === 'stable picked exhaustion') {
        expect(sql.applicable).toBe(scenario === 'stable picked exhaustion');
        expect(supervisor.applicable).toBe(true);
      } else {
        expect(sql).toMatchObject({ currentMetric: 0.8, recommendedMetric: 0.95, eps: 0.01, applicable: true });
        expect(supervisor).toMatchObject({ applicable: false, recommended: supervisor.current, recommendedMetric: 0.9 });
        if (scenario === 'candidate rejection') {
          expect(sql.failureCounts).toContainEqual(expect.objectContaining({ category: 'candidate', code: 'sql-validation' }));
          expect(markdown).toContain('candidate / sql-validation');
        }
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
      vi.mocked(readFile).mockReset();
    }
  },
);

it.each(['seed only', 'no node provenance', 'stale node digest'] as const)(
  'refuses to score an unfrozen selected node (%s)',
  async scenario => {
    vi.stubEnv('GEMINI_API_KEY', 'test-key');
    vi.mocked(loadTemplateEnv).mockClear().mockRejectedValue(new Error('scoring started'));
    const root = await mkdtemp(join(tmpdir(), 'template-unfrozen-'));
    const node = 'slackIntake';
    try {
      const input = { category: 'simple', text: 'Count the orders.' };
      await mkdir(join(root, 'items'));
      await writeFile(join(root, 'items', node + '.jsonl'), JSON.stringify({
        ...input, id: 'seed', expectedRoute: 'analytics_pipeline', inputHash: hashItemInput(input),
        agreement: { members: ['manual'] },
      }) + '\n');
      await writeFile(join(root, 'VERSION'), 'tv-v2\n');
      if (scenario !== 'seed only') {
        await writeFile(join(root, 'provenance.json'), JSON.stringify({
          version: 'tv-v2', members: [], perNode: scenario === 'stale node digest' ? {
            slackIntake: { itemsSha256: '0'.repeat(64) },
          } : {},
        }));
      }
      const realFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
      const realItems = await vi.importActual<typeof import('../../../scripts/template-validation/items.js')>(
        '../../../scripts/template-validation/items.js',
      );
      vi.mocked(readFile).mockImplementation((path, options) => realFs.readFile(join(root, String(path).split('/').at(-1)!), options));
      vi.mocked(loadItems).mockImplementation((selected, _root, ...rest) => realItems.loadItems(selected, root, ...rest));

      await expect(main(['--corpus', 'template', '--node', node], root)).rejects.toThrow(
        scenario === 'seed only' ? /validation set is not frozen/i : /frozen.*slackIntake|slackIntake.*frozen/i,
      );
      expect(loadTemplateEnv).not.toHaveBeenCalled();
    } finally {
      vi.mocked(readFile).mockReset();
      await rm(root, { recursive: true, force: true });
    }
  },
);

it.each([
  { status: 429, failedCall: 1, phase: 'calibration', previous: undefined },
  { status: 429, failedCall: 5, phase: 'stage 1', previous: '' },
  { status: 503, failedCall: 5, phase: 'stage 1', previous: '' },
])('aborts an SDK $status in $phase before another request or report write', async ({ status, failedCall, previous }) => {
  vi.stubEnv('GEMINI_API_KEY', 'test-key');
  vi.stubEnv('NODE_PROFILE_OVERRIDES', previous);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const node = 'slackIntake';
  const items = ['Count the orders.', 'Count the users.'].map((text, i) => ({
    id: String(i), category: 'simple', inputHash: hashItemInput(text), agreement: { members: ['test'] },
    text, expectedRoute: 'analytics_pipeline',
  }));
  vi.mocked(readFile).mockImplementation(async path => String(path).endsWith('/VERSION') ? 'test' : JSON.stringify({
    version: 'test', members: [], perNode: { slackIntake: { itemsSha256: 'a'.repeat(64), accepted: items.length } },
  }));
  vi.mocked(loadItems).mockReturnValue(items as ReturnType<typeof loadItems>);
  vi.mocked(loadTemplateEnv).mockResolvedValue({
    apiKey: 'test-key', tables: [], knowledge: [], execute: vi.fn(), judge: vi.fn(),
  });
  const real = await vi.importActual<typeof import('../../../scripts/template-validation/runners.js')>(
    '../../../scripts/template-validation/runners.js',
  );
  vi.mocked(createTemplateRunner).mockImplementation(real.createTemplateRunner);
  const profiles: (string | undefined)[] = [];
  generateContent.mockReset().mockImplementation(async () => {
    profiles.push(process.env.NODE_PROFILE_OVERRIDES);
    if (profiles.length === failedCall) throw Object.assign(new Error('sensitive provider response'), { status });
    return { text: '{"route":"analytics_pipeline","responseText":null,"reasoning":"Data request."}' };
  });
  const dir = await mkdtemp(join(tmpdir(), 'template-provider-abort-'));
  const date = new Date().toISOString().slice(0, 10);
  const fullReport = [`${date}-model-refresh.md`, `${date}-model-refresh.json`];
  try {
    for (const name of fullReport) await writeFile(join(dir, name), 'previous report');
    await expect(main(['--corpus', 'template', '--node', node], dir)).rejects.toMatchObject({
      status, message: expect.not.stringContaining('sensitive provider response'),
    });
    expect(generateContent).toHaveBeenCalledTimes(failedCall);
    if (failedCall > 1) expect(profiles.at(-1)).toContain('"slackIntake"');
    expect(process.env.NODE_PROFILE_OVERRIDES).toBe(previous);
    const realFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    expect((await readdir(dir)).sort()).toEqual([...fullReport].sort());
    for (const name of fullReport) expect(await realFs.readFile(join(dir, name), 'utf8')).toBe('previous report');
  } finally {
    vi.mocked(readFile).mockReset();
    await rm(dir, { recursive: true, force: true });
  }
});

async function templateLauncher(dir: string, env: NodeJS.ProcessEnv) {
  await Promise.all([
    copyFile('package.json', join(dir, 'package.json')),
    symlink(resolve('scripts'), join(dir, 'scripts'), 'dir'),
    symlink(resolve('node_modules'), join(dir, 'node_modules'), 'dir'),
  ]);
  return spawnSync('npm', ['run', 'sweep:template', '--', '--node', 'slackIntake'], {
    cwd: dir, encoding: 'utf8', timeout: 10_000, env: {
      ...process.env, GEMINI_API_KEY: 'test-key', MODEL_ID_OVERRIDES: undefined, NODE_PROFILE_OVERRIDES: undefined, ...env,
    },
  });
}

it.each([
  ['MODEL_ID_OVERRIDES', 'shell', '{"pro/3.1":"synthetic-unselected-id"}'],
  ['NODE_PROFILE_OVERRIDES', 'shell', '{"chart":{"thinkingLevel":"low","tier":"flash","version":"3"}}'],
  ['MODEL_ID_OVERRIDES', 'dotenv', '{"pro/3.1":"synthetic-unselected-id"}'],
  ['NODE_PROFILE_OVERRIDES', 'dotenv', '{"chart":{"thinkingLevel":"low","tier":"flash","version":"3"}}'],
])('refuses template mode with %s supplied by %s before reading the corpus', async (variable, source, value) => {
  const dir = await mkdtemp(join(tmpdir(), 'template-override-'));
  try {
    await writeFile(join(dir, '.env'), source === 'dotenv' ? `${variable}='${value}'\n` : '');
    const { status, stderr, stdout } = await templateLauncher(dir, source === 'shell' ? { [variable]: value } : {});
    expect(status).toBe(1);
    expect(stderr).toContain(variable);
    expect(stderr).not.toContain(value);
    expect(stderr).not.toMatch(/ENOENT|not frozen/i);
    expect(stdout).not.toContain(value);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('withholds an unpaired supervisor pick and preserves the existing full reports', async () => {
  vi.stubEnv('GEMINI_API_KEY', 'test-key');
  vi.stubEnv('NODE_PROFILE_OVERRIDES', undefined);
  vi.stubEnv('MODEL_ID_OVERRIDES', undefined);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const realFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  vi.mocked(readFile).mockImplementation(async (path, options) => {
    if (String(path).endsWith('/VERSION')) return 'test';
    if (String(path).endsWith('/provenance.json')) return JSON.stringify({
      version: 'test', members: [], perNode: { supervisor: {
        itemsSha256: 'a'.repeat(64), drafted: 50, accepted: 50, quarantined: 0, dropRateByCategory: {},
      } },
    });
    return realFs.readFile(path, options);
  });
  const items = Array.from({ length: 50 }, (_, i) => ({ id: `supervisor-${i}` }));
  vi.mocked(loadItems).mockReturnValue(items as ReturnType<typeof loadItems>);
  vi.mocked(loadTemplateEnv).mockResolvedValue({
    apiKey: 'test', tables: [], knowledge: [], execute: vi.fn(), judge: vi.fn(),
  });
  vi.mocked(createTemplateRunner).mockClear().mockImplementation(() => async () => {
    const score = process.env.NODE_PROFILE_OVERRIDES ? 1 : 0;
    return {
      perEntry: items.map(({ id }) => ({ id, clarificationPassed: false, overallScore: score, sqlGenMetric: score })),
      nodeUsage: new Map(),
    };
  });

  const dir = await mkdtemp(join(tmpdir(), 'template-supervisor-report-'));
  const full = join(dir, `${new Date().toISOString().slice(0, 10)}-model-refresh`);
  try {
    for (const ext of ['.md', '.json']) await writeFile(full + ext, 'existing full report');
    await main(['--corpus', 'template', '--node', 'supervisor'], dir);
    const names = await readdir(dir);
    const markdown = names.find(file => file.endsWith('-partial-supervisor.md'));
    const json = names.find(file => file.endsWith('-partial-supervisor.json'));
    expect(await readFile(full + '.md', 'utf8')).toBe('existing full report');
    expect(await readFile(full + '.json', 'utf8')).toBe('existing full report');
    expect(markdown).toBeDefined();
    expect(json).toBeDefined();
    expect(await readFile(join(dir, markdown!), 'utf8')).toContain('pending SQL comparator verification');
    expect(JSON.parse(await readFile(join(dir, json!), 'utf8')).rows).toMatchObject([{
      node: 'supervisor', currentMetric: 0, recommendedMetric: 1, applicable: false,
      applicationReason: 'pending SQL comparator verification',
    }]);
    expect(createTemplateRunner).toHaveBeenCalledExactlyOnceWith('supervisor', expect.any(Array), expect.any(Object));
  } finally {
    vi.mocked(readFile).mockReset();
    await rm(dir, { recursive: true, force: true });
  }
});

it('starts the template launcher with exported credentials and no dotenv file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'template-no-dotenv-'));
  try {
    const validationDir = join(dir, 'benchmarks', 'template-validation');
    await mkdir(validationDir, { recursive: true });
    await writeFile(join(validationDir, 'VERSION'), 'tv-v1\n');
    const { status, stderr } = await templateLauncher(dir, {});
    expect(status).toBe(1);
    expect(stderr).toContain('Template validation set is not frozen');
    expect(stderr).not.toContain('.env: not found');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
