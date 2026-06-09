import type { BenchmarkResult, BenchmarkRun, JudgeResult } from './benchmark-types.js';

export type CalibrationConfidence = BenchmarkResult['confidence'];

export interface BenchmarkCalibrationBucket {
  confidence: CalibrationConfidence;
  total: number;
  wrong: number;
  wrongRate: number;
  belowSample: boolean;
}

export type BenchmarkCalibrationReason =
  | 'monotonic'
  | 'missing_judge_results'
  | 'missing_confidence_bucket'
  | 'insufficient_sample'
  | 'non_monotonic'
  | 'insufficient_delta';

export interface BenchmarkCalibrationVerdict {
  passed: boolean;
  reason: BenchmarkCalibrationReason;
  detail: string;
  correctnessWrongThreshold: number;
  minSample: number;
  minLowHighWrongRateDelta: number;
}

export interface BenchmarkCalibrationResult {
  buckets: BenchmarkCalibrationBucket[];
  verdict: BenchmarkCalibrationVerdict;
  missingJudgeCorpusIds: string[];
}

export interface BenchmarkCalibrationOptions {
  correctnessWrongThreshold?: number;
  minSample?: number;
  minLowHighWrongRateDelta?: number;
}

const CONFIDENCE_ORDER: CalibrationConfidence[] = ['low', 'medium', 'high'];
const DEFAULT_CORRECTNESS_WRONG_THRESHOLD = 3;
const DEFAULT_MIN_SAMPLE = 5;
const DEFAULT_MIN_LOW_HIGH_WRONG_RATE_DELTA = 0.05;

export function evaluateBenchmarkCalibration(
  run: BenchmarkRun,
  options: BenchmarkCalibrationOptions = {},
): BenchmarkCalibrationResult {
  const correctnessWrongThreshold =
    options.correctnessWrongThreshold ?? DEFAULT_CORRECTNESS_WRONG_THRESHOLD;
  const minSample = options.minSample ?? DEFAULT_MIN_SAMPLE;
  const minLowHighWrongRateDelta =
    options.minLowHighWrongRateDelta ?? DEFAULT_MIN_LOW_HIGH_WRONG_RATE_DELTA;

  const judgesByCorpusId = new Map(
    (run.judgeResults ?? []).map(judge => [judge.corpusId, judge]),
  );
  const tallies = new Map<CalibrationConfidence, { total: number; wrong: number }>();
  const missingJudgeCorpusIds: string[] = [];

  for (const result of run.results ?? []) {
    const judge = judgesByCorpusId.get(result.corpusId);
    if (!judge) {
      missingJudgeCorpusIds.push(result.corpusId);
      continue;
    }

    const current = tallies.get(result.confidence) ?? { total: 0, wrong: 0 };
    current.total += 1;
    // Wrong means either the judge explicitly flagged the case or the correctness
    // score fell below the pinned threshold. This keeps the calibration reducer
    // deterministic and conservative for side-bar gating.
    if (isWrong(judge, correctnessWrongThreshold)) {
      current.wrong += 1;
    }
    tallies.set(result.confidence, current);
  }

  const buckets = CONFIDENCE_ORDER
    .filter(confidence => tallies.has(confidence))
    .map((confidence): BenchmarkCalibrationBucket => {
      const tally = tallies.get(confidence)!;
      return {
        confidence,
        total: tally.total,
        wrong: tally.wrong,
        wrongRate: tally.total === 0 ? 0 : tally.wrong / tally.total,
        belowSample: tally.total < minSample,
      };
    });

  const verdict = calibrationVerdict(
    buckets,
    missingJudgeCorpusIds,
    correctnessWrongThreshold,
    minSample,
    minLowHighWrongRateDelta,
  );

  return { buckets, verdict, missingJudgeCorpusIds };
}

function isWrong(judge: JudgeResult, correctnessWrongThreshold: number): boolean {
  return judge.flaggedForReview || judge.scores.correctness < correctnessWrongThreshold;
}

function calibrationVerdict(
  buckets: BenchmarkCalibrationBucket[],
  missingJudgeCorpusIds: string[],
  correctnessWrongThreshold: number,
  minSample: number,
  minLowHighWrongRateDelta: number,
): BenchmarkCalibrationVerdict {
  const base = { correctnessWrongThreshold, minSample, minLowHighWrongRateDelta };
  if (missingJudgeCorpusIds.length > 0) {
    return {
      ...base,
      passed: false,
      reason: 'missing_judge_results',
      detail: `${missingJudgeCorpusIds.length} benchmark result(s) had no judge result`,
    };
  }

  const byConfidence = new Map(buckets.map(bucket => [bucket.confidence, bucket]));
  const missingBuckets = CONFIDENCE_ORDER.filter(confidence => !byConfidence.has(confidence));
  if (missingBuckets.length > 0) {
    return {
      ...base,
      passed: false,
      reason: 'missing_confidence_bucket',
      detail: `Missing confidence bucket(s): ${missingBuckets.join(', ')}`,
    };
  }

  const belowSample = buckets.filter(bucket => bucket.belowSample);
  if (belowSample.length > 0) {
    return {
      ...base,
      passed: false,
      reason: 'insufficient_sample',
      detail: `Below minSample=${minSample}: ${belowSample.map(b => b.confidence).join(', ')}`,
    };
  }

  const low = byConfidence.get('low')!;
  const medium = byConfidence.get('medium')!;
  const high = byConfidence.get('high')!;
  if (!(low.wrongRate >= medium.wrongRate && medium.wrongRate >= high.wrongRate)) {
    return {
      ...base,
      passed: false,
      reason: 'non_monotonic',
      detail: 'Expected wrongRate ordering low >= medium >= high',
    };
  }

  if (low.wrongRate - high.wrongRate < minLowHighWrongRateDelta) {
    return {
      ...base,
      passed: false,
      reason: 'insufficient_delta',
      detail: `low-high wrongRate delta is below ${minLowHighWrongRateDelta}`,
    };
  }

  return {
    ...base,
    passed: true,
    reason: 'monotonic',
    detail: 'wrongRate ordering is low >= medium >= high with enough low-high separation',
  };
}
