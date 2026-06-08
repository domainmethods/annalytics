import { describe, it, expect, vi, beforeEach } from 'vitest';

// createRunCorpusOnce is the single Gemini/BigQuery-touching seam. Mock its three
// external collaborators so we can drive the clarification-gate branch, the
// bypass-clarification override, and the null-SQL judge short-circuit with zero
// credentials and zero network calls. (benchmarkSupport scorers are pure → real.)
vi.mock('../../src/agents/clarificationAgent.js', () => ({ classifyQuestion: vi.fn() }));
vi.mock('../../src/qualityLoop.js', () => ({ qualityLoop: vi.fn() }));
vi.mock('../../scripts/benchmark-judge-core.js', () => ({ judgeSingleResult: vi.fn() }));

import { createRunCorpusOnce } from '../../scripts/node-sweep.js';
import { classifyQuestion } from '../../src/agents/clarificationAgent.js';
import { qualityLoop } from '../../src/qualityLoop.js';
import { judgeSingleResult } from '../../scripts/benchmark-judge-core.js';
import type { CorpusEntry } from '../../scripts/benchmark-types.js';

const clar = (confidence: 'high' | 'medium' | 'low') => ({
  route: 'data_query' as const,
  confidence,
  reasoning: '',
  ambiguities: [],
  assumptions: [],
  clarifying_questions: [],
  resolved_question: 'resolved',
  bqml_hint: null,
});

const goodQuality = {
  sqlResult: { sql: 'SELECT count(*) FROM analytics.t' },
  finalConfidence: 'high' as const,
  verdict: 'pass' as const,
  retryCount: 0,
  supervisorNotes: '',
  bytesProcessed: 1,
};

const goodJudge = {
  corpusId: 'e1',
  scores: { correctness: 5, efficiency: 5, readability: 5, teachingCompliance: 5, safety: 5 },
  overallScore: 5,
  rationale: '',
  flaggedForReview: false,
};

const entry: CorpusEntry = {
  id: 'e1',
  question: 'how many rows?',
  category: 'simple',
  source: 'manual',
  expectedTables: ['analytics.t'],
  expectedSqlContains: ['count'],
};

const baseDeps = () => ({
  ai: {} as never,
  apiKey: 'k',
  corpus: [entry],
  tables: [],
  knowledgeSummaries: [],
  knownBenchmarkTables: ['analytics.t'],
  judgeModel: 'judge-model',
});

beforeEach(() => vi.clearAllMocks());

describe('createRunCorpusOnce clarification gate', () => {
  it('bypass=false + LOW skips the quality loop AND the judge, flooring overallScore', async () => {
    vi.mocked(classifyQuestion).mockResolvedValue(clar('low'));

    const res = await createRunCorpusOnce(baseDeps())();

    expect(qualityLoop).not.toHaveBeenCalled();
    // null generatedSql short-circuit: no wasted judge LLM call.
    expect(judgeSingleResult).not.toHaveBeenCalled();
    expect(res.perEntry[0].overallScore).toBe(1); // deterministic 1–5 floor
    // tableSel=false, sqlShape=false (null SQL), correctness floor 1/5 → mean(0,0,0.2).
    expect(res.perEntry[0].sqlGenMetric).toBeCloseTo(0.2 / 3, 6);
  });

  it('bypass=true + LOW runs the quality loop and judges (gate ignored, metric still measurable)', async () => {
    vi.mocked(classifyQuestion).mockResolvedValue(clar('low'));
    vi.mocked(qualityLoop).mockResolvedValue(goodQuality as never);
    vi.mocked(judgeSingleResult).mockResolvedValue(goodJudge as never);

    const res = await createRunCorpusOnce({ ...baseDeps(), bypassClarification: true })();

    expect(qualityLoop).toHaveBeenCalledTimes(1);
    expect(judgeSingleResult).toHaveBeenCalledTimes(1);
    expect(res.perEntry[0].overallScore).toBe(5);
    // classifyQuestion is still called under bypass so clarification stays measurable.
    expect(classifyQuestion).toHaveBeenCalledTimes(1);
  });

  it('bypass=false + HIGH runs the quality loop and judges normally', async () => {
    vi.mocked(classifyQuestion).mockResolvedValue(clar('high'));
    vi.mocked(qualityLoop).mockResolvedValue(goodQuality as never);
    vi.mocked(judgeSingleResult).mockResolvedValue(goodJudge as never);

    const res = await createRunCorpusOnce(baseDeps())();

    expect(qualityLoop).toHaveBeenCalledTimes(1);
    expect(judgeSingleResult).toHaveBeenCalledTimes(1);
    expect(res.perEntry[0].overallScore).toBe(5);
  });
});
