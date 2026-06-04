import type { BenchmarkMetadata, BenchmarkResult, BenchmarkRun } from './benchmark-types.js';

export type ReferenceCardDecision = 'ACCEPTED' | 'NEEDS_REVISION';

export type ReferenceCardFailureClass =
  | 'missing_metadata'
  | 'retrieval_miss'
  | 'table_mismatch'
  | 'sql_shape_mismatch'
  | 'validation_failure'
  | 'clarification_mismatch'
  | 'pipeline_failure';

export interface ReferenceCardAcceptanceFailure {
  corpusId: string;
  failureClass: ReferenceCardFailureClass;
  detail: string;
}

export interface ReferenceCardCaseAcceptance {
  corpusId: string;
  question: string;
  status: 'pass' | 'fail';
  expectedReferenceIds: string[];
  observedReferenceIds: string[];
  referenceRetrievalPassed: boolean | null;
  expectedTables: string[];
  observedTables: string[];
  tableSelectionPassed: boolean | null;
  sqlShapePassed: boolean | null;
  clarificationPassed: boolean | null;
  qualityVerdict: BenchmarkResult['qualityVerdict'];
  validationResults: BenchmarkResult['validationResults'];
  advisoryL2Passed: boolean;
  failures: ReferenceCardAcceptanceFailure[];
}

export interface ReferenceCardAcceptanceComparison {
  newlyFailing: string[];
  newlyPassing: string[];
}

export interface ReferenceCardAcceptanceResult {
  runDate: string;
  decision: ReferenceCardDecision;
  metadata: BenchmarkMetadata | null;
  metadataFailures: string[];
  cases: ReferenceCardCaseAcceptance[];
  failures: ReferenceCardAcceptanceFailure[];
  comparison?: ReferenceCardAcceptanceComparison;
}

export function isReferenceCardAcceptanceCase(result: BenchmarkResult): boolean {
  return result.corpusId.startsWith('revenue-ref-') || (result.expectedReferenceIds?.length ?? 0) > 0;
}

export function evaluateReferenceCardAcceptance(
  run: BenchmarkRun,
  previous?: BenchmarkRun,
): ReferenceCardAcceptanceResult {
  const metadata = run.metadata ?? null;
  const metadataFailures = validateMetadata(metadata);
  const cases = run.results
    .filter(isReferenceCardAcceptanceCase)
    .map(evaluateCase);
  const failures: ReferenceCardAcceptanceFailure[] = [
    ...metadataFailures.map(detail => ({
      corpusId: '__metadata__',
      failureClass: 'missing_metadata' as const,
      detail,
    })),
    ...cases.flatMap(item => item.failures),
  ];

  const acceptance: ReferenceCardAcceptanceResult = {
    runDate: run.runDate,
    decision: failures.length === 0 ? 'ACCEPTED' : 'NEEDS_REVISION',
    metadata,
    metadataFailures,
    cases,
    failures,
  };

  if (previous) {
    acceptance.comparison = compareReferenceCardAcceptance(previous, run);
  }

  return acceptance;
}

export function compareReferenceCardAcceptance(
  previous: BenchmarkRun,
  current: BenchmarkRun,
): ReferenceCardAcceptanceComparison {
  const previousStatuses = new Map(
    evaluateReferenceCardAcceptance(previous).cases.map(item => [item.corpusId, item.status]),
  );
  const currentCases = evaluateReferenceCardAcceptance(current).cases;
  const newlyFailing: string[] = [];
  const newlyPassing: string[] = [];

  for (const item of currentCases) {
    const previousStatus = previousStatuses.get(item.corpusId);
    if (previousStatus === 'pass' && item.status === 'fail') {
      newlyFailing.push(item.corpusId);
    }
    if (previousStatus === 'fail' && item.status === 'pass') {
      newlyPassing.push(item.corpusId);
    }
  }

  return { newlyFailing, newlyPassing };
}

function evaluateCase(result: BenchmarkResult): ReferenceCardCaseAcceptance {
  const failures: ReferenceCardAcceptanceFailure[] = [];
  const expectedReferenceIds = arrayOrEmpty(result.expectedReferenceIds);
  const observedReferenceIds = arrayOrEmpty(result.observedReferenceIds);
  const expectedTables = arrayOrEmpty(result.expectedTables);
  const observedTables = arrayOrEmpty(result.observedTables);
  const expectedSqlContains = arrayOrEmpty(result.expectedSqlContains);
  const isClarificationOnly = result.expectedClarificationConfidence != null && expectedReferenceIds.length === 0;

  if (expectedReferenceIds.length > 0 && result.referenceRetrievalPassed !== true) {
    failures.push({
      corpusId: result.corpusId,
      failureClass: 'retrieval_miss',
      detail: `Expected references ${formatList(expectedReferenceIds)}; observed ${formatList(observedReferenceIds)}`,
    });
  }

  if (expectedTables.length > 0 && result.tableSelectionPassed !== true) {
    failures.push({
      corpusId: result.corpusId,
      failureClass: 'table_mismatch',
      detail: `Expected tables ${formatList(expectedTables)}; observed ${formatList(observedTables)}`,
    });
  }

  if (expectedSqlContains.length > 0 && result.sqlShapePassed !== true) {
    failures.push({
      corpusId: result.corpusId,
      failureClass: 'sql_shape_mismatch',
      detail: `Generated SQL did not contain all expected fragments: ${formatList(expectedSqlContains)}`,
    });
  }

  if (!isClarificationOnly && (result.qualityVerdict === 'exhausted' || result.qualityVerdict === 'cost_exceeded')) {
    failures.push({
      corpusId: result.corpusId,
      failureClass: 'pipeline_failure',
      detail: `Quality loop ended with verdict ${result.qualityVerdict}`,
    });
  }

  const blockingValidationFailures = blockingValidationFailuresFor(result.validationResults);
  if (!isClarificationOnly && blockingValidationFailures.length > 0) {
    failures.push({
      corpusId: result.corpusId,
      failureClass: 'validation_failure',
      detail: `Final SQL failed ${blockingValidationFailures.join(', ')}`,
    });
  }

  if (result.expectedClarificationConfidence && result.clarificationPassed !== true) {
    failures.push({
      corpusId: result.corpusId,
      failureClass: 'clarification_mismatch',
      detail: `Expected clarification confidence ${result.expectedClarificationConfidence}`,
    });
  }

  return {
    corpusId: result.corpusId,
    question: result.question,
    status: failures.length === 0 ? 'pass' : 'fail',
    expectedReferenceIds,
    observedReferenceIds,
    referenceRetrievalPassed: result.referenceRetrievalPassed,
    expectedTables,
    observedTables,
    tableSelectionPassed: result.tableSelectionPassed,
    sqlShapePassed: result.sqlShapePassed,
    clarificationPassed: result.clarificationPassed,
    qualityVerdict: result.qualityVerdict,
    validationResults: result.validationResults,
    advisoryL2Passed: result.validationResults.l2,
    failures,
  };
}

function validateMetadata(metadata: BenchmarkMetadata | null): string[] {
  if (!metadata) {
    return ['metadata is required'];
  }

  const failures: string[] = [];
  if (!metadata.runId) failures.push('metadata.runId is required');
  if (!metadata.runStartedAt) failures.push('metadata.runStartedAt is required');
  if (!metadata.gitSha) failures.push('metadata.gitSha is required');
  if (typeof metadata.gitDirty !== 'boolean') failures.push('metadata.gitDirty is required');
  if (!metadata.corpusHash) failures.push('metadata.corpusHash is required');
  if (!metadata.geminiModel) failures.push('metadata.geminiModel is required');
  if (!metadata.fileSearchStoreId) failures.push('metadata.fileSearchStoreId is required');
  return failures;
}

function blockingValidationFailuresFor(validation: BenchmarkResult['validationResults']): string[] {
  const failures: string[] = [];
  if (!validation.l1) failures.push('L1');
  if (!validation.l3) failures.push('L3');
  if (!validation.l4) failures.push('L4');
  return failures;
}

function arrayOrEmpty(value: string[] | undefined): string[] {
  return Array.isArray(value) ? value : [];
}

function formatList(values: string[]): string {
  return values.length > 0 ? values.join(', ') : '(none)';
}
