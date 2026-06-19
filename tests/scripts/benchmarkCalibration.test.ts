import { describe, expect, it } from 'vitest';
import {
  evaluateBenchmarkCalibration,
  type BenchmarkCalibrationResult,
} from '../../scripts/benchmark-calibration.js';
import type {
  BenchmarkMetadata,
  BenchmarkResult,
  BenchmarkRun,
  JudgeResult,
} from '../../scripts/benchmark-types.js';

const metadata: BenchmarkMetadata = {
  runId: 'benchmark_2026-06-08T10-00-00-000Z',
  runStartedAt: '2026-06-08T10:00:00.000Z',
  gitSha: 'abc123',
  gitDirty: false,
  packageVersion: '1.0.0',
  corpusHash: 'corpus-hash',
  dbtManifestHash: null,
  dbtCatalogHash: null,
  geminiModel: 'gemini-3.1-flash-lite',
  judgeModel: 'gemini-3.1-pro-preview',
  fileSearchStoreId: 'fileSearchStores/revenue',
  gcpProjectId: 'template-test',
};

function result(
  corpusId: string,
  confidence: BenchmarkResult['confidence'],
): BenchmarkResult {
  return {
    corpusId,
    question: `Question ${corpusId}`,
    generatedSql: 'SELECT 1',
    confidence,
    qualityVerdict: 'pass',
    retryCount: 0,
    validationResults: { l1: true, l2: true, l3: true, l4: true },
    validationHistory: [],
    bytesProcessed: 10,
    supervisorNotes: 'ok',
    teachingCompliance: 'no_relevant_teaching',
    expectedTeachingIds: undefined,
    observedTeachingIds: [],
    teachingRetrievalPassed: null,
    expectedReferenceIds: undefined,
    observedReferenceIds: [],
    referenceRetrievalPassed: null,
    referenceProbeReferenceIds: [],
    sqlGroundingReferenceIds: [],
    referenceProbeCitations: [],
    referenceRetrievalSource: 'none',
    expectedTables: undefined,
    observedTables: [],
    tableSelectionPassed: null,
    expectedSqlContains: undefined,
    sqlShapePassed: null,
    expectedClarificationConfidence: undefined,
    clarificationPassed: null,
    latencyMs: { clarification: 1, generation: 1, validation: 0, supervisor: 0, total: 2 },
    groundingCitations: [],
  };
}

function judge(
  corpusId: string,
  correctness: number,
  flaggedForReview = false,
): JudgeResult {
  return {
    corpusId,
    scores: {
      correctness,
      efficiency: 4,
      readability: 4,
      teachingCompliance: 4,
      safety: 4,
    },
    overallScore: correctness,
    rationale: 'test',
    flaggedForReview,
  };
}

function run(
  groups: Record<BenchmarkResult['confidence'], Array<{ correctness: number; flagged?: boolean }>>,
): BenchmarkRun {
  const results: BenchmarkResult[] = [];
  const judgeResults: JudgeResult[] = [];
  for (const confidence of ['low', 'medium', 'high'] as BenchmarkResult['confidence'][]) {
    groups[confidence].forEach((item, index) => {
      const corpusId = `${confidence}-${index + 1}`;
      results.push(result(corpusId, confidence));
      judgeResults.push(judge(corpusId, item.correctness, item.flagged ?? false));
    });
  }
  return {
    runDate: '2026-06-08',
    metadata,
    corpusSize: results.length,
    results,
    judgeResults,
  };
}

function bucketMap(calibration: BenchmarkCalibrationResult) {
  return new Map(calibration.buckets.map(bucket => [bucket.confidence, bucket]));
}

describe('evaluateBenchmarkCalibration', () => {
  it('passes when wrong rates are monotonic low to high with enough samples', () => {
    const calibration = evaluateBenchmarkCalibration(run({
      low: [{ correctness: 1 }, { correctness: 2 }, { correctness: 2 }, { correctness: 5, flagged: true }, { correctness: 4 }],
      medium: [{ correctness: 2 }, { correctness: 4 }, { correctness: 4 }, { correctness: 5 }, { correctness: 5 }],
      high: [{ correctness: 5 }, { correctness: 5 }, { correctness: 4 }, { correctness: 4 }, { correctness: 5 }],
    }));

    expect(calibration.verdict).toEqual(expect.objectContaining({
      passed: true,
      reason: 'monotonic',
      correctnessWrongThreshold: 3,
      minSample: 5,
    }));
    expect(bucketMap(calibration).get('low')).toEqual(expect.objectContaining({
      total: 5,
      wrong: 4,
      wrongRate: 0.8,
      belowSample: false,
    }));
  });

  it('fails when high-confidence results are wrong more often than low-confidence results', () => {
    const calibration = evaluateBenchmarkCalibration(run({
      low: [{ correctness: 2 }, { correctness: 5 }, { correctness: 5 }, { correctness: 5 }, { correctness: 5 }],
      medium: [{ correctness: 5 }, { correctness: 5 }, { correctness: 5 }, { correctness: 5 }, { correctness: 5 }],
      high: [{ correctness: 1 }, { correctness: 2 }, { correctness: 2 }, { correctness: 5, flagged: true }, { correctness: 5 }],
    }));

    expect(calibration.verdict.passed).toBe(false);
    expect(calibration.verdict.reason).toBe('non_monotonic');
  });

  it('fails and marks buckets below the minimum sample floor', () => {
    const calibration = evaluateBenchmarkCalibration(run({
      low: [{ correctness: 1 }, { correctness: 2 }, { correctness: 2 }, { correctness: 2 }],
      medium: [{ correctness: 2 }, { correctness: 4 }, { correctness: 4 }, { correctness: 5 }, { correctness: 5 }],
      high: [{ correctness: 5 }, { correctness: 5 }, { correctness: 4 }, { correctness: 4 }, { correctness: 5 }],
    }));

    expect(calibration.verdict).toEqual(expect.objectContaining({
      passed: false,
      reason: 'insufficient_sample',
    }));
    expect(bucketMap(calibration).get('low')).toEqual(expect.objectContaining({
      total: 4,
      belowSample: true,
    }));
  });

  it('excludes correct abstentions (generatedSql null) from calibration buckets', () => {
    // Two low-confidence results: one correct abstention (generatedSql null,
    // judge marks it wrong) and one real answer (generatedSql 'SELECT 1',
    // judge correct). The abstention must count in neither total nor wrong.
    const answer = result('low-answer', 'low');
    const abstention: BenchmarkResult = { ...result('low-abstain', 'low'), generatedSql: null };
    const calibration = evaluateBenchmarkCalibration({
      runDate: '2026-06-08',
      metadata,
      corpusSize: 2,
      results: [abstention, answer],
      judgeResults: [
        judge('low-abstain', 1, true), // would be tallied wrong if not excluded
        judge('low-answer', 5),
      ],
    });

    const low = bucketMap(calibration).get('low');
    expect(low?.total).toBe(1); // only the real answer
    expect(low?.wrong).toBe(0); // abstention is neither total nor wrong
    expect(calibration.missingJudgeCorpusIds).not.toContain('low-abstain');
  });

  it('fails when any benchmark result is missing a judge result', () => {
    const calibration = evaluateBenchmarkCalibration({
      ...run({
        low: [{ correctness: 1 }, { correctness: 2 }, { correctness: 2 }, { correctness: 2 }, { correctness: 5 }],
        medium: [{ correctness: 2 }, { correctness: 4 }, { correctness: 4 }, { correctness: 5 }, { correctness: 5 }],
        high: [{ correctness: 5 }, { correctness: 5 }, { correctness: 4 }, { correctness: 4 }, { correctness: 5 }],
      }),
      judgeResults: [],
    });

    expect(calibration.verdict).toEqual(expect.objectContaining({
      passed: false,
      reason: 'missing_judge_results',
    }));
    expect(calibration.missingJudgeCorpusIds).toContain('low-1');
  });
});
