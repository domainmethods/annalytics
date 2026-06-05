import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  detectRegressions,
  generateSummary,
  writeBenchmarkAnalysisOutputs,
} from '../../scripts/benchmark-analyze.js';
import type {
  BenchmarkMetadata,
  BenchmarkResult,
  BenchmarkRun,
  JudgeResult,
} from '../../scripts/benchmark-types.js';

const makeJudge = (
  id: string,
  correctness: number,
  overrides: Partial<JudgeResult> = {},
): JudgeResult => ({
  corpusId: id,
  scores: { correctness, efficiency: 3, readability: 3, teachingCompliance: 3, safety: 3 },
  overallScore: correctness,
  rationale: 'test',
  flaggedForReview: false,
  ...overrides,
});

const metadata: BenchmarkMetadata = {
  runId: 'benchmark_2026-06-04T10-00-00-000Z',
  runStartedAt: '2026-06-04T10:00:00.000Z',
  gitSha: 'abc123',
  gitDirty: false,
  packageVersion: '1.0.0',
  corpusHash: 'corpus-hash',
  dbtManifestHash: null,
  dbtCatalogHash: null,
  geminiModel: 'gemini-3.0-pro',
  judgeModel: 'gemini-3.0-pro',
  fileSearchStoreId: 'fileSearchStores/revenue',
  gcpProjectId: 'analytics-prod',
};

function result(overrides: Partial<BenchmarkResult> = {}): BenchmarkResult {
  return {
    corpusId: 'revenue-ref-001',
    question: 'What was total revenue last month?',
    generatedSql: 'SELECT 1 FROM `analytics.fct_orders`',
    confidence: 'high',
    qualityVerdict: 'pass',
    retryCount: 0,
    validationResults: { l1: true, l2: true, l3: true, l4: true },
    bytesProcessed: 1000,
    supervisorNotes: 'ok',
    teachingCompliance: 'no_relevant_teaching',
    expectedReferenceIds: ['revenue-canonical-definition'],
    observedReferenceIds: ['revenue-canonical-definition'],
    referenceRetrievalPassed: true,
    expectedTables: ['analytics.fct_orders'],
    observedTables: ['analytics.fct_orders'],
    tableSelectionPassed: true,
    expectedSqlContains: ['analytics.fct_orders'],
    sqlShapePassed: true,
    expectedClarificationConfidence: undefined,
    clarificationPassed: null,
    latencyMs: { clarification: 1, generation: 1, validation: 0, supervisor: 0, total: 2 },
    groundingCitations: ['reference_card:revenue-canonical-definition'],
    ...overrides,
  };
}

function run(overrides: Partial<BenchmarkRun> = {}): BenchmarkRun {
  return {
    runDate: '2026-06-04',
    metadata,
    corpusSize: 1,
    results: [result()],
    judgeResults: [],
    ...overrides,
  };
}

describe('detectRegressions', () => {
  it('detects regression when correctness drops by 2+', () => {
    const previous = [makeJudge('q1', 5), makeJudge('q2', 4)];
    const current = [makeJudge('q1', 2), makeJudge('q2', 4)];
    const regressions = detectRegressions(previous, current);
    expect(regressions).toHaveLength(1);
    expect(regressions[0].corpusId).toBe('q1');
  });

  it('returns empty when no regressions', () => {
    const previous = [makeJudge('q1', 3)];
    const current = [makeJudge('q1', 4)];
    expect(detectRegressions(previous, current)).toHaveLength(0);
  });
});

describe('generateSummary', () => {
  it('includes reference-card acceptance output even without judge results', () => {
    const summary = generateSummary(run());

    expect(summary).toContain('# Benchmark Summary - 2026-06-04');
    expect(summary).toContain('No judge results available yet.');
    expect(summary).toContain('## ReferenceCard Acceptance');
    expect(summary).toContain('**Decision:** `ACCEPTED`');
  });

  it('preserves judge sections and appends reference-card acceptance output', () => {
    const summary = generateSummary(
      run({
        judgeResults: [
          makeJudge('q1', 3, {
            rationale: 'needs analyst review',
            flaggedForReview: true,
          }),
        ],
      }),
      run({ judgeResults: [makeJudge('q1', 5)] }),
    );

    expect(summary).toContain('## Score Distribution');
    expect(summary).toContain('| Mean   | 3.00 |');
    expect(summary).toContain('## Pipeline Failures');
    expect(summary).toContain('**0** queries ended in `exhausted` or `cost_exceeded`.');
    expect(summary).toContain('## Regressions');
    expect(summary).toContain('| q1 | correctness | 5 | 3 | -2 |');
    expect(summary).toContain('## Flagged for Review');
    expect(summary).toContain('- **q1** (overall: 3) - needs analyst review');
    expect(summary).toContain('## ReferenceCard Acceptance');
    expect(summary.indexOf('## ReferenceCard Acceptance')).toBeGreaterThan(
      summary.indexOf('## Flagged for Review'),
    );
  });

  it('escapes reference-card failure corpus IDs in summary tables', () => {
    const summary = generateSummary(run({
      results: [
        result({
          corpusId: 'revenue-ref-bad|id',
          observedReferenceIds: [],
          referenceRetrievalPassed: false,
        }),
      ],
    }));

    expect(summary).toContain('| revenue-ref-bad\\|id | retrieval_miss |');
    expect(summary).not.toContain('| revenue-ref-bad|id | retrieval_miss |');
  });
});

describe('writeBenchmarkAnalysisOutputs', () => {
  it('writes both benchmark summary and reference-card acceptance markdown files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'annalytics-benchmark-analysis-'));
    const currentPath = join(dir, '2026-06-04.json');
    await writeFile(currentPath, JSON.stringify(run(), null, 2), 'utf-8');

    const outputs = writeBenchmarkAnalysisOutputs(currentPath);

    expect(outputs.summaryPath).toBe(join(dir, '2026-06-04-summary.md'));
    expect(outputs.acceptancePath).toBe(join(dir, '2026-06-04-referencecard-acceptance.md'));

    const summary = await readFile(outputs.summaryPath, 'utf-8');
    const acceptance = await readFile(outputs.acceptancePath, 'utf-8');
    expect(summary).toContain('## ReferenceCard Acceptance');
    expect(summary).toContain('**Decision:** `ACCEPTED`');
    expect(acceptance).toContain('# ReferenceCard Acceptance - 2026-06-04');
    expect(acceptance).toContain('**Decision:** `ACCEPTED`');
  });

  it('derives output paths from the final .json extension only', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'annalytics.json-benchmark-analysis-'));
    const currentPath = join(dir, '2026.json.06-04.json');
    await writeFile(currentPath, JSON.stringify(run(), null, 2), 'utf-8');

    const outputs = writeBenchmarkAnalysisOutputs(currentPath);

    expect(outputs.summaryPath).toBe(join(dir, '2026.json.06-04-summary.md'));
    expect(outputs.acceptancePath).toBe(
      join(dir, '2026.json.06-04-referencecard-acceptance.md'),
    );
    await expect(readFile(outputs.summaryPath, 'utf-8')).resolves.toContain(
      '## ReferenceCard Acceptance',
    );
    await expect(readFile(outputs.acceptancePath, 'utf-8')).resolves.toContain(
      '**Decision:** `ACCEPTED`',
    );
  });

  it('throws on malformed benchmark JSON', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'annalytics-benchmark-analysis-'));
    const currentPath = join(dir, 'broken.json');
    await writeFile(currentPath, '{not valid json', 'utf-8');

    expect(() => writeBenchmarkAnalysisOutputs(currentPath)).toThrow(SyntaxError);
  });

  it('rejects benchmark paths without a final .json extension', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'annalytics-benchmark-analysis-'));
    const currentPath = join(dir, '2026-06-04.benchmark');
    await writeFile(currentPath, JSON.stringify(run(), null, 2), 'utf-8');

    expect(() => writeBenchmarkAnalysisOutputs(currentPath)).toThrow(
      'Benchmark analysis input must end with .json',
    );
  });
});
