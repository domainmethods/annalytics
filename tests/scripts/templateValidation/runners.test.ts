import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { classifyQuestion } from '../../../src/agents/clarificationAgent.js';
import { reviewSql } from '../../../src/agents/supervisorAgent.js';
import { qualityLoop } from '../../../src/qualityLoop.js';
import { executeQuery } from '../../../src/execution/runner.js';
import { validateSql } from '../../../src/validation/pipeline.js';
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
vi.mock('../../../src/validation/dryRun.js', () => ({ initBigQuery: vi.fn() }));
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
  vi.mocked(validateSql).mockResolvedValue({ valid: true, layer: 'all', bytesProcessed: 0 });
  vi.mocked(executeQuery).mockResolvedValue(result);
  vi.mocked(qualityLoop).mockResolvedValue({
    sqlResult: { sql: candidateSql, explanation: '', headline: '', confidence: 'high', reasoningChain: '', assumptions: [], tablesUsed: [], groundingCitations: [] },
    verdict: 'pass', supervisorNotes: '', finalConfidence: 'high', retryCount: 0, failureHistory: [],
  });
});

afterEach(() => vi.unstubAllEnvs());

describe('template corpus runners', () => {
  it('loads only template knowledge and never passes a file search store to qualityLoop', async () => {
    vi.stubEnv('FILE_SEARCH_STORE_ID', 'x');
    const env = await loadTemplateEnv('test');
    expect(env.knowledge.length).toBeGreaterThan(0);
    expect(loadLocalKnowledgeSummaries).toHaveBeenCalledExactlyOnceWith('benchmarks/template-validation/knowledge');
    expect(env.tables.every(table => table.name.startsWith('tv_thelook.'))).toBe(true);
    await createTemplateRunner('sqlGenerator', [{ ...base, question: 'A question', referenceSql }], env)();
    const [options] = vi.mocked(qualityLoop).mock.calls[0];
    expect(options.fileSearchStoreId).toBeUndefined();
    expect(options.knowledgeSummaries).toEqual(env.knowledge);
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
      { id: 'throw', clarificationPassed: false, overallScore: 0, sqlGenMetric: 0, error: expect.any(String) },
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
    expect(run.perEntry[0]).toMatchObject({ sqlGenMetric: 0, overallScore: 0, error: expect.stringContaining('validation') });
    expect(vi.mocked(executeQuery).mock.calls.map(([sql]) => sql)).toEqual([referenceSql]);
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

it('reverts the supervisor when the paired SQL metric drops more than epsilon and restores overrides', async () => {
  const original = '{}';
  vi.stubEnv('NODE_PROFILE_OVERRIDES', original);
  const profile: SweepProfile = { tier: 'flash', version: '3', thinkingLevel: 'low' };
  const picks = { sqlGenerator: profile, supervisor: profile };
  const run = vi.fn(async () => {
    expect(JSON.parse(process.env.NODE_PROFILE_OVERRIDES!)).toEqual(picks);
    return { perEntry: [{ id: 'test', clarificationPassed: false, overallScore: 0.8, sqlGenMetric: 0.8 }], nodeUsage: new Map() };
  });
  expect(await verifyCrossPass(run, picks, 0.9, 0.05)).toEqual({ revertSupervisor: true, metric: 0.8 });
  expect(await verifyCrossPass(run, picks, 0.85, 0.05)).toEqual({ revertSupervisor: false, metric: 0.8 });
  expect(process.env.NODE_PROFILE_OVERRIDES).toBe(original);
});
