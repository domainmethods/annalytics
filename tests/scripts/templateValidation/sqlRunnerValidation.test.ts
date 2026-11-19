import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { executeQuery } from '../../../src/execution/runner.js';
import { executeTemplateSql } from '../../../scripts/template-validation/label-quorum.js';
import { createTemplateRunner, loadTemplateEnv } from '../../../scripts/template-validation/runners.js';

const { createQueryJob, generateContent } = vi.hoisted(() => ({
  createQueryJob: vi.fn(), generateContent: vi.fn(),
}));
vi.mock('@google-cloud/bigquery', () => ({ BigQuery: class { createQueryJob = createQueryJob; } }));
vi.mock('@google/genai', () => ({ GoogleGenAI: class { models = { generateContent }; } }));
vi.mock('../../../src/execution/runner.js', () => ({ executeQuery: vi.fn(), initBigQueryClient: vi.fn() }));

const projectId = 'test-project';
const item = {
  id: 'sql-test', category: 'simple', question: 'Count the orders.', referenceSql: 'SELECT 1 AS total',
  inputHash: '0'.repeat(64), agreement: { members: ['test'] },
};
const unknownSql = 'SELECT COUNT(*) AS total FROM nonexistent';
const approvedSql = 'SELECT COUNT(*) AS total FROM tv_thelook.orders';
const job = (query = {}) => [{ metadata: { statistics: {
  totalBytesProcessed: '0', query: { statementType: 'SELECT', ...query },
} } }];
const modelSql = (sql: string) => ({ text: JSON.stringify({
  sql, explanation: '', headline: '', tables_used: [], confidence: 'high', assumptions: [], reasoning_chain: '',
}) });

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('GCP_PROJECT_ID', projectId);
  vi.mocked(executeQuery).mockResolvedValue({
    rows: [{ total: 1 }], columnNames: ['total'], totalRows: 1, bytesProcessed: 0, truncated: false,
  });
});

afterEach(() => vi.unstubAllEnvs());

it.each([
  { sql: unknownSql, category: 'candidate', code: 'sql-lineage', approved: false },
  { sql: approvedSql, category: 'warehouse', code: 'sql-validation', approved: true },
])('classifies a missing relation in the quality loop and final check as $category', async ({ sql, category, code, approved }) => {
  const env = await loadTemplateEnv('test');
  createQueryJob.mockImplementation(async ({ query }) => {
    if (query === item.referenceSql) return job();
    throw Object.assign(new Error('No such table'), { errors: [{ reason: 'notFound' }] });
  });
  generateContent.mockResolvedValue(modelSql(sql));

  const { perEntry } = await createTemplateRunner('sqlGenerator', [item], env)();
  expect(perEntry[0]).toMatchObject({ overallScore: 0, exhausted: true, failure: { category, code } });
  expect(generateContent).toHaveBeenCalledTimes(3);
  expect(createQueryJob.mock.calls.filter(([request]) => request.query === sql)).toHaveLength(approved ? 3 : 0);

  await expect(executeTemplateSql(sql, projectId)).resolves.toMatchObject({
    code, warehouseFailure: approved,
  });
  expect(createQueryJob.mock.calls.filter(([request]) => request.query === sql)).toHaveLength(approved ? 4 : 0);
  expect(vi.mocked(executeQuery).mock.calls.map(([query]) => query)).toEqual([item.referenceSql]);
});

it.each([false, true])('retains a backendError when the retry returns malformed output: %s', async malformed => {
  const env = await loadTemplateEnv('test');
  const approvedLineage = [{ projectId, datasetId: 'tv_thelook', tableId: 'orders' }];
  createQueryJob
    .mockResolvedValueOnce(job())
    .mockRejectedValueOnce(Object.assign(new Error('warehouse at https://private.invalid unavailable'), { errors: [{ reason: 'backendError' }] }))
    .mockResolvedValueOnce(job({ referencedLogicalViews: approvedLineage }));
  generateContent.mockResolvedValueOnce(modelSql(approvedSql));
  if (malformed) {
    generateContent.mockResolvedValueOnce({ text: 'malformed JSON' });
  } else {
    generateContent.mockResolvedValueOnce(modelSql(approvedSql))
      .mockResolvedValueOnce({ text: '{"verdict":"PASS","confidence":"high","issues":[],"suggestions":[],"teaching_compliance":"no_relevant_teaching"}' });
  }

  const { perEntry } = await createTemplateRunner('sqlGenerator', [item], env)();
  expect(generateContent).toHaveBeenCalledTimes(malformed ? 2 : 3);
  expect(perEntry[0]).toMatchObject({
    overallScore: 0, sqlGenMetric: 0, failure: { category: 'warehouse', code: 'sql-validation' },
  });
  expect(JSON.stringify(perEntry)).not.toContain('private.invalid');
  expect(vi.mocked(executeQuery).mock.calls.map(([sql]) => sql)).toEqual([item.referenceSql]);
});

it('rejects a dataset-qualified routine in a projection before creating any job', async () => {
  await loadTemplateEnv('test');
  createQueryJob.mockResolvedValue(job());

  await expect(executeTemplateSql('SELECT example_ds.example_fn(1)', projectId)).resolves.toMatchObject({
    code: 'sql-lineage',
  });
  expect(createQueryJob).not.toHaveBeenCalled();
  expect(executeQuery).not.toHaveBeenCalled();
});

it('blocks execution when dry-run metadata reports a routine', async () => {
  await loadTemplateEnv('test');
  createQueryJob.mockResolvedValue(job({
    referencedRoutines: [{ projectId, datasetId: 'tv_thelook', routineId: 'example_fn' }],
  }));

  await expect(executeTemplateSql('SELECT ABS(-1)', projectId)).resolves.toMatchObject({ code: 'sql-lineage' });
  expect(createQueryJob).toHaveBeenCalledExactlyOnceWith({
    query: 'SELECT ABS(-1)', dryRun: true, useLegacySql: false,
  });
  expect(executeQuery).not.toHaveBeenCalled();
});
