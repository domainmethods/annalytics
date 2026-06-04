import { describe, expect, it } from 'vitest';
import {
  compareReferenceCardAcceptance,
  evaluateReferenceCardAcceptance,
  isReferenceCardAcceptanceCase,
} from '../../scripts/benchmarkAcceptance.js';
import type { BenchmarkMetadata, BenchmarkResult, BenchmarkRun } from '../../scripts/benchmark-types.js';

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
    generatedSql: 'SELECT SUM(total_amount) FROM `analytics.fct_orders` WHERE order_status = "completed"',
    confidence: 'high',
    qualityVerdict: 'pass',
    retryCount: 0,
    validationResults: { l1: true, l2: true, l3: true, l4: true },
    bytesProcessed: 1024,
    supervisorNotes: 'ok',
    teachingCompliance: 'no_relevant_teaching',
    expectedReferenceIds: ['revenue-canonical-definition'],
    observedReferenceIds: ['revenue-canonical-definition'],
    referenceRetrievalPassed: true,
    expectedTables: ['analytics.fct_orders'],
    observedTables: ['analytics.fct_orders'],
    tableSelectionPassed: true,
    expectedSqlContains: ['analytics.fct_orders', 'order_status = "completed"'],
    sqlShapePassed: true,
    expectedClarificationConfidence: undefined,
    clarificationPassed: null,
    latencyMs: {
      clarification: 10,
      generation: 20,
      validation: 0,
      supervisor: 0,
      total: 30,
    },
    groundingCitations: ['reference_card:revenue-canonical-definition'],
    ...overrides,
  };
}

function run(results: BenchmarkResult[], runMetadata: BenchmarkMetadata | undefined = metadata): BenchmarkRun {
  return {
    runDate: '2026-06-04',
    metadata: runMetadata as BenchmarkMetadata,
    corpusSize: results.length,
    results,
    judgeResults: [],
  };
}

describe('isReferenceCardAcceptanceCase', () => {
  it('selects revenue reference cases and cases with expected reference IDs', () => {
    expect(isReferenceCardAcceptanceCase(result({
      corpusId: 'revenue-ref-005',
      expectedReferenceIds: undefined,
    }))).toBe(true);
    expect(isReferenceCardAcceptanceCase(result({
      corpusId: 'seed-001',
      expectedReferenceIds: ['revenue-canonical-definition'],
    }))).toBe(true);
    expect(isReferenceCardAcceptanceCase(result({
      corpusId: 'seed-003',
      expectedReferenceIds: undefined,
    }))).toBe(false);
  });
});

describe('evaluateReferenceCardAcceptance', () => {
  it('accepts a passing revenue reference-card run', () => {
    const acceptance = evaluateReferenceCardAcceptance(run([
      result(),
      result({
        corpusId: 'revenue-ref-005',
        question: 'revenue',
        generatedSql: null,
        confidence: 'low',
        qualityVerdict: 'exhausted',
        expectedReferenceIds: undefined,
        observedReferenceIds: [],
        referenceRetrievalPassed: null,
        expectedTables: undefined,
        observedTables: [],
        tableSelectionPassed: null,
        expectedSqlContains: undefined,
        sqlShapePassed: null,
        expectedClarificationConfidence: 'low',
        clarificationPassed: true,
        validationResults: { l1: false, l2: false, l3: false, l4: false },
      }),
    ]));

    expect(acceptance.decision).toBe('ACCEPTED');
    expect(acceptance.failures).toEqual([]);
    expect(acceptance.cases).toHaveLength(2);
  });

  it('classifies retrieval misses', () => {
    const acceptance = evaluateReferenceCardAcceptance(run([
      result({ observedReferenceIds: [], referenceRetrievalPassed: false }),
    ]));

    expect(acceptance.decision).toBe('NEEDS_REVISION');
    expect(acceptance.failures).toContainEqual(expect.objectContaining({
      corpusId: 'revenue-ref-001',
      failureClass: 'retrieval_miss',
    }));
  });

  it('classifies missing observed reference arrays as retrieval misses without crashing', () => {
    const malformed = {
      ...result({ referenceRetrievalPassed: false }),
      observedReferenceIds: undefined,
    } as unknown as BenchmarkResult;

    const acceptance = evaluateReferenceCardAcceptance(run([malformed]));

    expect(acceptance.failures).toContainEqual(expect.objectContaining({
      corpusId: 'revenue-ref-001',
      failureClass: 'retrieval_miss',
      detail: expect.stringContaining('observed (none)'),
    }));
  });

  it('classifies SQL-derived table mismatches', () => {
    const acceptance = evaluateReferenceCardAcceptance(run([
      result({ observedTables: ['analytics.fct_revenue'], tableSelectionPassed: false }),
    ]));

    expect(acceptance.failures).toContainEqual(expect.objectContaining({
      corpusId: 'revenue-ref-001',
      failureClass: 'table_mismatch',
    }));
  });

  it('classifies SQL-shape mismatches', () => {
    const acceptance = evaluateReferenceCardAcceptance(run([
      result({ sqlShapePassed: false }),
    ]));

    expect(acceptance.failures).toContainEqual(expect.objectContaining({
      corpusId: 'revenue-ref-001',
      failureClass: 'sql_shape_mismatch',
    }));
  });

  it('keeps advisory L2 failures visible without failing acceptance', () => {
    const acceptance = evaluateReferenceCardAcceptance(run([
      result({ validationResults: { l1: true, l2: false, l3: true, l4: true } }),
    ]));

    expect(acceptance.decision).toBe('ACCEPTED');
    expect(acceptance.cases[0].advisoryL2Passed).toBe(false);
    expect(acceptance.failures).toEqual([]);
  });

  it('classifies blocking validation failures', () => {
    const acceptance = evaluateReferenceCardAcceptance(run([
      result({ validationResults: { l1: true, l2: true, l3: false, l4: true } }),
    ]));

    expect(acceptance.failures).toContainEqual(expect.objectContaining({
      failureClass: 'validation_failure',
      detail: expect.stringContaining('L3'),
    }));
  });

  it('classifies ambiguous intake clarification mismatches without treating skipped SQL as pipeline failure', () => {
    const acceptance = evaluateReferenceCardAcceptance(run([
      result({
        corpusId: 'revenue-ref-005',
        question: 'revenue',
        generatedSql: null,
        confidence: 'high',
        qualityVerdict: 'exhausted',
        expectedReferenceIds: undefined,
        observedReferenceIds: [],
        referenceRetrievalPassed: null,
        expectedTables: undefined,
        observedTables: [],
        tableSelectionPassed: null,
        expectedSqlContains: undefined,
        sqlShapePassed: null,
        expectedClarificationConfidence: 'low',
        clarificationPassed: false,
        validationResults: { l1: false, l2: false, l3: false, l4: false },
      }),
    ]));

    expect(acceptance.failures).toEqual([
      expect.objectContaining({ failureClass: 'clarification_mismatch' }),
    ]);
  });

  it('classifies blocking L1 and L4 validation failures while keeping L2 advisory', () => {
    const acceptance = evaluateReferenceCardAcceptance(run([
      result({ validationResults: { l1: false, l2: false, l3: true, l4: false } }),
    ]));

    expect(acceptance.cases[0].advisoryL2Passed).toBe(false);
    expect(acceptance.failures).toContainEqual(expect.objectContaining({
      failureClass: 'validation_failure',
      detail: expect.stringContaining('L1, L4'),
    }));
  });

  it('fails acceptance when required provenance metadata is missing', () => {
    const incompleteMetadata = { ...metadata, gitSha: null, fileSearchStoreId: null };
    const acceptance = evaluateReferenceCardAcceptance(run([result()], incompleteMetadata));

    expect(acceptance.decision).toBe('NEEDS_REVISION');
    expect(acceptance.metadataFailures).toEqual([
      'metadata.gitSha is required',
      'metadata.fileSearchStoreId is required',
    ]);
    expect(acceptance.failures).toContainEqual(expect.objectContaining({
      corpusId: '__metadata__',
      failureClass: 'missing_metadata',
    }));
  });

  it('adds run comparison when a previous run is provided', () => {
    const previous = run([
      result({ corpusId: 'revenue-ref-pass-to-fail' }),
      result({
        corpusId: 'revenue-ref-fail-to-pass',
        observedReferenceIds: [],
        referenceRetrievalPassed: false,
      }),
    ]);
    const current = run([
      result({
        corpusId: 'revenue-ref-pass-to-fail',
        observedReferenceIds: [],
        referenceRetrievalPassed: false,
      }),
      result({ corpusId: 'revenue-ref-fail-to-pass' }),
    ]);

    expect(compareReferenceCardAcceptance(previous, current)).toEqual({
      newlyFailing: ['revenue-ref-pass-to-fail'],
      newlyPassing: ['revenue-ref-fail-to-pass'],
    });
    expect(evaluateReferenceCardAcceptance(current, previous).comparison).toEqual({
      newlyFailing: ['revenue-ref-pass-to-fail'],
      newlyPassing: ['revenue-ref-fail-to-pass'],
    });
  });
});
