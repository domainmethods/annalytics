import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GoogleGenAI } from '@google/genai';
import { classifyQuestion } from '../../../src/agents/clarificationAgent.js';
import { generateForNode } from '../../../src/agents/modelGateway.js';
import { reviewSql } from '../../../src/agents/supervisorAgent.js';
import { qualityLoop } from '../../../src/qualityLoop.js';
import { executeQuery } from '../../../src/execution/runner.js';
import { validateSql } from '../../../src/validation/pipeline.js';
import { dryRunValidation, initBigQuery } from '../../../src/validation/dryRun.js';
import { loadLocalKnowledgeSummaries } from '../../../scripts/benchmarkInputs.js';
import { loadFixture } from '../../../scripts/template-validation/items.js';
import { createTemplateRunner, loadTemplateEnv, verifyCrossPass } from '../../../scripts/template-validation/runners.js';
import type { SweepProfile } from '../../../scripts/node-sweep-types.js';

const generateContent = vi.hoisted(() => vi.fn());
vi.mock('@google/genai', () => ({
  GoogleGenAI: class { models = { generateContent }; },
}));
vi.mock('../../../src/agents/clarificationAgent.js', () => ({ classifyQuestion: vi.fn() }));
vi.mock('../../../src/agents/supervisorAgent.js', () => ({ reviewSql: vi.fn() }));
vi.mock('../../../src/qualityLoop.js', () => ({ qualityLoop: vi.fn() }));
vi.mock('../../../src/execution/runner.js', () => ({ executeQuery: vi.fn(), initBigQueryClient: vi.fn() }));
vi.mock('../../../src/validation/dryRun.js', { spy: true });
vi.mock('../../../src/validation/pipeline.js', () => ({ validateSql: vi.fn() }));
vi.mock('../../../scripts/benchmarkInputs.js', { spy: true });
vi.mock('../../../scripts/template-validation/items.js', { spy: true });

const base = { id: 'test', category: 'simple', inputHash: '0'.repeat(64), agreement: { members: ['test'] } };
const referenceSql = 'SELECT 1 AS value';
const candidateSql = 'SELECT 1 AS value WHERE TRUE';
const result = { columnNames: ['value'], rows: [{ value: 1 }], totalRows: 1, truncated: false, bytesProcessed: 0, durationMs: 0 };
const question = 'How many orders?';
const context = {
  responseId: 'response', threadTs: '1', statusMsgTs: '2', clarifiedQuestion: question,
  assumptions: [], reasoningChain: 'Count orders', generatedSql: referenceSql, explanation: 'Counted order items',
  tablesUsed: [], confidence: 'high', primaryAgentConfidence: 'high',
  queryResults: { rowCount: 1, columnNames: ['value'], bytesProcessed: 0 },
  pipelineDurationMs: 100, traceId: 'trace', createdAt: '2026-11-18T00:00:00Z',
  groundingCitations: [], teachingsUsed: [], supervisorVerdict: 'pass', supervisorNotes: '',
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('GCP_PROJECT_ID', 'test-project');
  vi.mocked(initBigQuery).mockImplementation(() => {});
  vi.mocked(validateSql).mockResolvedValue({ valid: true, layer: 'all', bytesProcessed: 0 });
  vi.mocked(executeQuery).mockResolvedValue(result);
  vi.mocked(qualityLoop).mockResolvedValue({
    sqlResult: { sql: candidateSql, explanation: '', headline: '', confidence: 'high', reasoningChain: '', assumptions: [], tablesUsed: [], groundingCitations: [] },
    verdict: 'pass', supervisorNotes: '', finalConfidence: 'high', retryCount: 0, failureHistory: [],
  });
});

afterEach(() => vi.unstubAllEnvs());

describe('template corpus runners', () => {
  it('loads template knowledge but uses only schema inputs for SQL generation', async () => {
    vi.stubEnv('FILE_SEARCH_STORE_ID', 'x');
    const env = await loadTemplateEnv('test');
    expect(env.knowledge.length).toBeGreaterThan(0);
    expect(loadLocalKnowledgeSummaries).toHaveBeenCalledExactlyOnceWith('benchmarks/template-validation/knowledge');
    expect(env.tables.every(table => table.name.startsWith('tv_thelook.'))).toBe(true);
    await createTemplateRunner('sqlGenerator', [{ ...base, question: 'A question', referenceSql }], env)();
    const [options] = vi.mocked(qualityLoop).mock.calls[0];
    expect(options).toStrictEqual({
      question: 'A question', tables: env.tables, threadContext: [], apiKey: 'test',
    });
  });

  it('scores clarification suspend matches and records an agent throw without dropping the item', async () => {
    vi.mocked(classifyQuestion)
      .mockResolvedValueOnce({ confidence: 'low', resolved_question: '', clarifying_questions: [], ambiguities: [], assumptions: [], reasoning: '', route: 'data_query' })
      .mockRejectedValueOnce(new Error('agent unavailable'));
    const env = await loadTemplateEnv('test');
    const items = [{ ...base, question: 'Unclear', expectedSuspend: true }, { ...base, id: 'throw', question: 'Clear', expectedSuspend: false }];
    const run = await createTemplateRunner('clarification', items, env)();
    expect(run.perEntry).toMatchObject([
      { id: 'test', clarificationPassed: true, overallScore: 1, sqlGenMetric: 1 },
      { id: 'throw', clarificationPassed: false, overallScore: 0, sqlGenMetric: 0, failure: { category: 'candidate', code: 'agent-output' } },
    ]);
  });

  it('scores SQL equivalence on both axes, bypasses clarification and executes the reference on every pass', async () => {
    const env = await loadTemplateEnv('test');
    const judge = vi.fn();
    const run = createTemplateRunner('sqlGenerator', [{ ...base, question: 'A question', referenceSql }], { ...env, judge });
    expect((await run()).perEntry[0]).toMatchObject({ sqlGenMetric: 1, overallScore: 1 });
    vi.mocked(executeQuery).mockImplementation(async sql => sql === referenceSql ? result : { ...result, rows: [{ value: 2 }] });
    expect((await run()).perEntry[0]).toMatchObject({ sqlGenMetric: 0, overallScore: 0 });
    expect(validateSql).toHaveBeenCalledTimes(4);
    expect(vi.mocked(executeQuery).mock.calls.map(([sql]) => sql).filter(sql => sql === referenceSql)).toHaveLength(2);
    expect(classifyQuestion).not.toHaveBeenCalled();
    expect(judge).not.toHaveBeenCalled();
  });

  it('scores failed SQL validation as zero and never executes invalid candidate SQL', async () => {
    vi.mocked(validateSql).mockImplementation(async sql => sql === referenceSql
      ? { valid: true, layer: 'all', bytesProcessed: 0 } : { valid: false, layer: 'L1', error: 'blocked' });
    const env = await loadTemplateEnv('test');
    const run = await createTemplateRunner('sqlGenerator', [{ ...base, question: 'A question', referenceSql }], env)();
    expect(run.perEntry[0]).toMatchObject({ sqlGenMetric: 0, overallScore: 0, failure: { category: 'candidate', code: 'sql-validation' } });
    expect(vi.mocked(executeQuery).mock.calls.map(([sql]) => sql)).toEqual([referenceSql]);
  });

  it('keeps equivalence credit and records exhaustion on an exhausted loop', async () => {
    const quality = await qualityLoop({ question, tables: [], threadContext: [], apiKey: 'test' }, 'test', question, 1);
    vi.mocked(qualityLoop).mockResolvedValue({ ...quality, verdict: 'exhausted' });
    const env = await loadTemplateEnv('test');
    const run = await createTemplateRunner('sqlGenerator', [{ ...base, question, referenceSql }], env)();
    expect(run.perEntry[0]).toMatchObject({ sqlGenMetric: 1, exhausted: true });
  });

  it.each([
    ['slackIntake', { text: question, expectedRoute: 'analytics_pipeline' }],
    ['ambiguityClassifier', { input: { question, ambiguities: [], clarifyingQuestions: [], threadContext: [] }, expectedType: 'user_intent' }],
  ] as const)('scores %s SDK error fallbacks zero even when the label matches', async (node, fields) => {
    generateContent.mockRejectedValueOnce(new Error('provider at https://private.invalid'));
    const env = await loadTemplateEnv('test');
    const { perEntry } = await createTemplateRunner(node, [{ ...base, ...fields }], env)();
    expect(perEntry[0]).toEqual({
      id: 'test', clarificationPassed: false, overallScore: 0, sqlGenMetric: 0,
      failure: { category: 'provider', code: 'model-request' },
    });
  });

  it('scores a Slack intake timeout as a candidate failure without aborting the sweep', async () => {
    const env = await loadTemplateEnv('test');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      generateContent.mockReturnValueOnce(new Promise(() => {}));
      const pending = createTemplateRunner('slackIntake', [
        { ...base, text: question, expectedRoute: 'analytics_pipeline' },
      ], env)();
      await vi.advanceTimersByTimeAsync(8_001);
      const { perEntry } = await pending;
      expect(perEntry[0]).toMatchObject({
        overallScore: 0, failure: { category: 'candidate', code: 'intake-timeout' },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('credits deterministic Slack intake without calling the SDK', async () => {
    const env = await loadTemplateEnv('test');
    const { perEntry } = await createTemplateRunner('slackIntake', [
      { ...base, text: 'hi', expectedRoute: 'immediate_response' },
    ], env)();
    expect(perEntry[0]).toMatchObject({ overallScore: 1 });
    expect(generateContent).not.toHaveBeenCalled();
  });

  it.each([
    ['reference', referenceSql, 'sql-execution'],
    ['warehouse', candidateSql, 'sql-execution'],
  ] as const)('records a sanitized %s execution failure', async (category, failingSql, code) => {
    vi.mocked(executeQuery).mockImplementation(async sql => {
      if (sql === failingSql) throw new Error('private-project at https://private.invalid');
      return result;
    });
    const env = await loadTemplateEnv('test');
    const { perEntry } = await createTemplateRunner('sqlGenerator', [{ ...base, question, referenceSql }], env)();
    expect(perEntry[0]).toMatchObject({ overallScore: 0, failure: { category, code } });
    expect(JSON.stringify(perEntry)).not.toMatch(/private-project|private\.invalid/);
  });

  it.each([false, true])('preserves a provider outage after SQL validation fails (warehouse failure: %s)', async warehouseFailure => {
    const quality = await qualityLoop({ question, tables: [], threadContext: [], apiKey: 'test' }, 'test', question, 1);
    generateContent.mockRejectedValueOnce(new Error('provider unavailable'));
    vi.mocked(dryRunValidation).mockResolvedValueOnce({ valid: false, layer: 'L3-dryrun', warehouseFailure: true });
    vi.mocked(qualityLoop).mockImplementation(async (_opts, _key, _question, _maxBytes, callbacks) => {
      await generateForNode('sqlGenerator', new GoogleGenAI({ apiKey: 'test' }), { contents: question })
        .catch(() => undefined);
      if (warehouseFailure) await callbacks?.validateAttempt?.(candidateSql, 0);
      return quality;
    });
    vi.mocked(validateSql).mockImplementation(async sql => sql === referenceSql
      ? { valid: true, layer: 'all', bytesProcessed: 0 } : { valid: false, layer: 'L1', error: 'blocked' });

    const env = await loadTemplateEnv('test');
    const { perEntry } = await createTemplateRunner('sqlGenerator', [{ ...base, question, referenceSql }], env)();
    expect(generateContent).toHaveBeenCalledOnce();
    expect(validateSql).toHaveBeenCalledTimes(warehouseFailure ? 1 : 2);
    expect(perEntry[0]).toMatchObject({
      overallScore: 0, sqlGenMetric: 0, failure: { category: 'provider', code: 'model-request' },
    });
  });

  it('records a judge provider failure even though the rubric scorer handles rejected facts', async () => {
    generateContent.mockResolvedValueOnce({ text: 'There was 1 order.' })
      .mockRejectedValueOnce(new Error('https://private.invalid'));
    const env = await loadTemplateEnv('test');
    const { perEntry } = await createTemplateRunner('summaryOverride', [{
      ...base, question, sql: referenceSql, rows: result.rows, totalRows: 1,
    }], env)();
    expect(perEntry[0]).toMatchObject({ overallScore: 0, failure: { category: 'provider', code: 'judge-request' } });
    expect(JSON.stringify(perEntry)).not.toContain('private.invalid');
  });

  it('scores the isolated supervisor verdict against the supplied label', async () => {
    vi.mocked(reviewSql).mockResolvedValue({ verdict: 'FAIL', confidence: 'high', issues: [], suggestions: [], teaching_compliance: 'no_relevant_teaching' });
    const env = await loadTemplateEnv('test');
    const run = await createTemplateRunner('supervisor', [{ ...base, question: 'A question', candidateSql, expectedVerdict: 'FAIL' }], env)();
    expect(run.perEntry[0]).toMatchObject({ overallScore: 1, sqlGenMetric: 1 });
    expect(reviewSql).toHaveBeenCalledWith(expect.objectContaining({ generatedSql: candidateSql }));
    expect(qualityLoop).not.toHaveBeenCalled();
  });

  it.each([
    { node: 'slackIntake', fields: { text: question, expectedRoute: 'analytics_pipeline' },
      answer: { route: 'analytics_pipeline', responseText: null, reasoning: 'Asks for data' } },
    { node: 'followUpClassifier', fields: { thread: [], message: 'What about May?', expectedIntent: 'refinement' },
      answer: { intent: 'refinement', reasoning: 'Changes date range' } },
    { node: 'ambiguityClassifier', fields: { input: { question, ambiguities: [], clarifyingQuestions: [], threadContext: [] }, expectedType: 'org_knowledge' },
      answer: { type: 'org_knowledge', question: 'What counts as an order?', domain: 'commerce', reasoning: 'Needs a definition' } },
    { node: 'teachingCandidate', fields: { context: { escalationId: 'e', originalQuestion: question, clarifiedQuestion: question, humanResponse: 'Use orders' },
      expectSanctionedSql: true, requiredModels: ['orders'] },
      answer: { sanctionedSql: referenceSql, modelsReferenced: ['orders'], questionPatterns: [], reasoning: 'Uses orders', tags: [] } },
    { node: 'dbtStatus', fields: { question: 'When did orders run?', runHistoryFixture: 'history', requiredFacts: ['orders', 'success'] },
      answer: 'orders finished successfully', fixture: [{ model: 'orders', status: 'success', executionTime: 1,
        runId: 'run', runStartedAt: '2026-11-18T00:00:00Z', errorMessage: null }] },
    { node: 'chart', fields: { question, columnNames: ['value'], sampleRows: result.rows, allowedMarks: ['bar'] },
      answer: { chartTitle: 'Orders', chartType: 'bar',
        vegaLiteSpec: { mark: 'bar', data: { values: [] }, encoding: { y: { field: 'value', type: 'quantitative' } } } } },
    { node: 'metaQuestion', fields: { question: 'What did you count?', contextFixture: 'context', rubric: ['explains what was counted'] },
      answer: 'I counted order items.', fixture: context },
    { node: 'discrepancy', fields: { complaint: 'The count is too high', contextFixture: 'context', defect: 'wrong grain', rubric: ['proposes checking order count'] },
      answer: { diagnosticSql: candidateSql, explanation: 'Wrong grain. Count distinct orders.' }, fixture: context },
  ] as const)('scores $node through the agent and records its usage', async ({ node, fields, answer, fixture }) => {
    const env = await loadTemplateEnv('test');
    const judge = vi.fn().mockResolvedValue(true);
    if (fixture) vi.mocked(loadFixture).mockReturnValueOnce(fixture);
    generateContent.mockResolvedValueOnce({
      text: typeof answer === 'string' ? answer : JSON.stringify(answer),
      usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2, thoughtsTokenCount: 1 },
    });
    const run = await createTemplateRunner(node, [{ ...base, ...fields }], { ...env, judge })();
    expect(run.perEntry[0]).toMatchObject({ overallScore: 1, sqlGenMetric: 1 });
    expect(run.nodeUsage.get(node)).toEqual({ latencies: [expect.any(Number)], inputTokens: 4, outputTokens: 3 });
    if (node === 'discrepancy') {
      expect(executeQuery).toHaveBeenCalledWith(candidateSql, expect.any(Object));
      expect(judge.mock.calls.map(([, fact]) => fact)).toEqual(['wrong grain', 'proposes checking order count']);
    } else {
      expect(judge).toHaveBeenCalledTimes(node === 'metaQuestion' ? 1 : 0);
    }
  });

  it('scores summary numbers and question relevance with the configured judge', async () => {
    vi.stubEnv('GEMINI_JUDGE_MODEL', 'test-judge');
    generateContent.mockResolvedValueOnce({ text: 'There was 1 order.' }).mockResolvedValueOnce({ text: 'false' });
    const env = await loadTemplateEnv('test');
    const run = await createTemplateRunner('summaryOverride', [{
      ...base, question, sql: referenceSql, rows: result.rows, totalRows: 1,
    }], env)();
    expect(run.perEntry[0]).toMatchObject({ overallScore: 0.5, sqlGenMetric: 0.5 });
    const [rubricRequest] = generateContent.mock.calls[1];
    expect(rubricRequest.model).toBe('test-judge');
    expect(JSON.parse(rubricRequest.contents)).toEqual({
      text: `Question: ${question}\nSummary: There was 1 order.`,
      fact: 'answers the question asked',
    });
  });
});

it('reverts the supervisor for increased exhaustion at unchanged equivalence', async () => {
  const supervisor: SweepProfile = { tier: 'flash', version: '3', thinkingLevel: 'low' };
  const run = async () => ({
    perEntry: [
      { id: 'a', clarificationPassed: false, overallScore: 1, sqlGenMetric: 1, exhausted: true },
      { id: 'b', clarificationPassed: false, overallScore: 1, sqlGenMetric: 1, exhausted: false },
    ],
    nodeUsage: new Map(),
  });
  expect(await verifyCrossPass(run, { supervisor }, 1, 0.05, 0.4))
    .toMatchObject({ revertSupervisor: true, metric: 1, exhaustionRate: 0.5 });
  expect(await verifyCrossPass(run, { supervisor }, 1, 0.05, 0.45))
    .toMatchObject({ revertSupervisor: false, metric: 1, exhaustionRate: 0.5 });
});

it('reverts the supervisor when the paired SQL metric drops more than epsilon and restores overrides', async () => {
  const original = '{}';
  vi.stubEnv('NODE_PROFILE_OVERRIDES', original);
  const profile: SweepProfile = { tier: 'flash', version: '3', thinkingLevel: 'low' };
  const picks = { sqlGenerator: profile, supervisor: profile };
  const run = vi.fn(async () => {
    expect(JSON.parse(process.env.NODE_PROFILE_OVERRIDES!)).toEqual(picks);
    return { perEntry: [{ id: 'test', clarificationPassed: false, overallScore: 0.8, sqlGenMetric: 0.8 }], nodeUsage: new Map() };
  });
  expect(await verifyCrossPass(run, picks, 0.9, 0.05)).toMatchObject({ revertSupervisor: true, metric: 0.8 });
  expect(await verifyCrossPass(run, picks, 0.85, 0.05)).toMatchObject({ revertSupervisor: false, metric: 0.8 });
  expect(process.env.NODE_PROFILE_OVERRIDES).toBe(original);
});

it('aborts on a transient judge error when retries are disabled, without making requests for the next item', async () => {
  generateContent.mockResolvedValueOnce({ text: 'There was 1 order.' })
    .mockRejectedValueOnce(Object.assign(new Error('provider response'), { status: 504 }));
  const env = await loadTemplateEnv('test');
  const item = { ...base, question, sql: referenceSql, rows: result.rows, totalRows: 1 };
  await expect(createTemplateRunner('summaryOverride', [item, { ...item, id: 'next' }], env, { retryDelaysMs: [] })())
    .rejects.toMatchObject({ status: 504 });
  expect(generateContent).toHaveBeenCalledTimes(2);
});

it('retries an item after a transient provider failure and keeps only the successful attempt', async () => {
  generateContent.mockRejectedValueOnce(Object.assign(new Error('provider response'), { status: 503 }))
    .mockResolvedValue({ text: 'There was 1 order.' });
  const env = { ...await loadTemplateEnv('test'), judge: vi.fn().mockResolvedValue(true) };
  const item = { ...base, question, sql: referenceSql, rows: result.rows, totalRows: 1 };
  const sleeps: number[] = [];
  const logs: string[] = [];
  const run = await createTemplateRunner('summaryOverride', [item], env, {
    sleep: async ms => { sleeps.push(ms); }, log: message => { logs.push(message); },
  })();
  expect(sleeps).toEqual([10_000]);
  expect(logs).toEqual([expect.stringContaining('[retry] summaryOverride/')]);
  expect(run.perEntry).toHaveLength(1);
  expect(run.perEntry[0].failure).toBeUndefined();
  // The failed attempt's generation is discarded: one usage record for one successful attempt.
  expect(run.nodeUsage.get('summaryOverride')?.latencies).toHaveLength(1);
});

it('discards the generation usage of an attempt whose judge call failed transiently', async () => {
  generateContent.mockResolvedValue({ text: 'There was 1 order.' });
  const judge = vi.fn().mockRejectedValueOnce(Object.assign(new Error('provider response'), { status: 503 }))
    .mockResolvedValue(true);
  const env = { ...await loadTemplateEnv('test'), judge };
  const item = { ...base, question, sql: referenceSql, rows: result.rows, totalRows: 1 };
  const run = await createTemplateRunner('summaryOverride', [item], env, { sleep: async () => {}, log: () => {} })();
  expect(generateContent).toHaveBeenCalledTimes(2);
  expect(run.perEntry[0].failure).toBeUndefined();
  expect(run.nodeUsage.get('summaryOverride')?.latencies).toHaveLength(1);
});

it('gives up after the configured retries', async () => {
  generateContent.mockRejectedValue(Object.assign(new Error('provider response'), { status: 429 }));
  const env = await loadTemplateEnv('test');
  const item = { ...base, question, sql: referenceSql, rows: result.rows, totalRows: 1 };
  const sleeps: number[] = [];
  await expect(createTemplateRunner('summaryOverride', [item], env, {
    retryDelaysMs: [1, 2], sleep: async ms => { sleeps.push(ms); }, log: () => {},
  })()).rejects.toMatchObject({ status: 429 });
  expect(sleeps).toEqual([1, 2]);
  expect(generateContent).toHaveBeenCalledTimes(3);
});
