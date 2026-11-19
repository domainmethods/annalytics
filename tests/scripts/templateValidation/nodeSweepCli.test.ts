import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { main, type PerEntry } from '../../../scripts/node-sweep.js';
import { hashItemInput, loadItems } from '../../../scripts/template-validation/items.js';
import { createTemplateRunner, loadTemplateEnv } from '../../../scripts/template-validation/runners.js';
import { defaultProfileForNode } from '../../../src/agents/nodeProfiles.js';

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

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it.each([
  'regression', 'reference outage', 'candidate rejection', 'default comparator', 'paired outage',
  'paired exhaustion', 'stable picked exhaustion', 'unsafe model override',
] as const)(
  'writes the correct supervisor decision and failure evidence for %s',
  async scenario => {
    vi.stubEnv('GCP_PROJECT_ID', 'test-project');
    vi.stubEnv('GEMINI_API_KEY', 'test-key');
    const unsafeUrl = 'https://private.invalid/v1';
    const unsafeProject = 'projects/private-project/locations/us/models/test';
    const defaultSql = defaultProfileForNode('sqlGenerator');
    if (scenario === 'unsafe model override') {
      vi.stubEnv('MODEL_ID_OVERRIDES', JSON.stringify({
        'flash/3': `${unsafeUrl}/${unsafeProject}`,
        [`${defaultSql.tier}/${defaultSql.version}`]: `${unsafeUrl}/${unsafeProject}-default`,
      }));
    }
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const realFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.mocked(readFile).mockImplementation(async (path, options) => {
      if (String(path).endsWith('/VERSION')) return 'test';
      if (String(path).endsWith('/provenance.json')) return JSON.stringify({
        version: 'test', members: [],
        perNode: Object.fromEntries(['sqlGenerator', 'supervisor'].map(node => [node, { itemsSha256: 'a'.repeat(64) }])),
      });
      return realFs.readFile(path, options);
    });
    vi.mocked(loadItems).mockImplementation(node => [{ id: node }] as ReturnType<typeof loadItems>);
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
      const exhausted = baseline ? 5 : paired && scenario === 'paired exhaustion' ? 12 : 10;
      const count = node === 'supervisor' ? (supervisorPick ? 40 : 36)
        : paired ? (comparesExhaustion ? 38 : 34) : sqlPick ? (scenario === 'default comparator' ? 32 : 38) : 32;
      const failure: PerEntry['failure'] = scenario === 'reference outage' && baseline && defaults <= 2
        ? { category: 'reference', code: 'sql-execution' }
        : (scenario === 'candidate rejection' || (scenario === 'unsafe model override' &&
          overrides.sqlGenerator?.tier === 'flash' && overrides.sqlGenerator.version === '3')) &&
          node === 'sqlGenerator' && sqlPick && !paired
          ? { category: 'candidate', code: 'sql-validation' }
          : scenario === 'paired outage' && paired
            ? { category: 'warehouse', code: 'sql-execution' }
            : undefined;
      return { perEntry: Array.from({ length: 40 }, (_, index) => ({
        id: String(index), clarificationPassed: false, overallScore: Number(index < count),
        sqlGenMetric: Number(index < count), ...(index === 39 && failure ? { failure } : {}),
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
      } else if (scenario === 'unsafe model override') {
        for (const row of [sql, supervisor]) {
          expect(row).toMatchObject({ applicable: false, applicationReason: 'measured under local model override' });
        }
        expect(sql.failureCounts).toContainEqual({
          profile: 'flash/3@high', category: 'candidate', code: 'sql-validation', count: 1,
        });
        expect(sql.recommended).not.toBe('flash/3@high');
        expect(markdown).toContain('measured under local model override');
        for (const report of [markdown, jsonText]) {
          expect(report).not.toContain(unsafeUrl);
          expect(report).not.toContain(unsafeProject);
          expect(report).toContain('flash/3@high');
        }
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
