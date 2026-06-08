import type { BenchmarkMetadata, BenchmarkResult, BenchmarkRun } from './benchmark-types.js';
import { formatValidationTrace } from './benchmarkSupport.js';

const FAILED_VALIDATION_RESULTS: BenchmarkResult['validationResults'] = {
  l1: false,
  l2: false,
  l3: false,
  l4: false,
};

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
  referenceRetrievalSource: 'explicit_probe' | 'sql_grounding' | 'none' | 'legacy';
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
  return result.corpusId.includes('-ref-') || (result.expectedReferenceIds?.length ?? 0) > 0;
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
  const runFailures: ReferenceCardAcceptanceFailure[] = cases.length === 0
    ? [{
        corpusId: '__run__',
        failureClass: 'pipeline_failure',
        detail: 'No ReferenceCard acceptance cases found',
      }]
    : [];
  const failures: ReferenceCardAcceptanceFailure[] = [
    ...metadataFailures.map(detail => ({
      corpusId: '__metadata__',
      failureClass: 'missing_metadata' as const,
      detail,
    })),
    ...runFailures,
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

export function formatReferenceCardAcceptanceReport(result: ReferenceCardAcceptanceResult): string {
  const lines: string[] = [];

  lines.push(`# ReferenceCard Acceptance - ${escapeMarkdown(result.runDate)}`);
  lines.push('');
  lines.push(`**Decision:** \`${result.decision}\``);
  lines.push('');

  lines.push('## Run Provenance');
  lines.push('');
  lines.push('| Field | Value |');
  lines.push('|-------|-------|');
  lines.push(`| Run ID | ${escapeMarkdown(result.metadata?.runId ?? '(missing)')} |`);
  lines.push(`| Started | ${escapeMarkdown(result.metadata?.runStartedAt ?? '(missing)')} |`);
  lines.push(`| Git SHA | ${escapeMarkdown(result.metadata?.gitSha ?? '(missing)')} |`);
  lines.push(`| Dirty | ${escapeMarkdown(String(result.metadata?.gitDirty ?? '(missing)'))} |`);
  lines.push(`| Corpus Hash | ${escapeMarkdown(result.metadata?.corpusHash ?? '(missing)')} |`);
  lines.push(`| dbt Manifest Hash | ${escapeMarkdown(result.metadata?.dbtManifestHash ?? '(not available)')} |`);
  lines.push(`| dbt Catalog Hash | ${escapeMarkdown(result.metadata?.dbtCatalogHash ?? '(not available)')} |`);
  lines.push(`| Gemini Model | ${escapeMarkdown(result.metadata?.geminiModel ?? '(missing)')} |`);
  lines.push(`| File Search Store | ${escapeMarkdown(result.metadata?.fileSearchStoreId ?? '(missing)')} |`);
  lines.push('');

  lines.push('## ReferenceCard Scorecard');
  lines.push('');
  lines.push('| Corpus ID | Status | Retrieval | Source | Tables | SQL Shape | L1/L3/L4 | L2 |');
  lines.push('|-----------|--------|-----------|--------|--------|-----------|----------|----|');
  for (const item of result.cases) {
    lines.push(`| ${[
      escapeMarkdown(item.corpusId),
      item.status,
      boolLabel(item.referenceRetrievalPassed),
      item.referenceRetrievalSource,
      boolLabel(item.tableSelectionPassed),
      boolLabel(item.sqlShapePassed),
      blockingValidationLabel(item.validationResults),
      item.advisoryL2Passed ? 'pass' : 'advisory_fail',
    ].join(' | ')} |`);
  }
  lines.push('');

  lines.push('## Failures');
  lines.push('');
  if (result.failures.length === 0) {
    lines.push('No acceptance failures.');
  } else {
    lines.push('| Corpus ID | Class | Detail |');
    lines.push('|-----------|-------|--------|');
    for (const failure of result.failures) {
      lines.push(`| ${escapeMarkdown(failure.corpusId)} | ${failure.failureClass} | ${escapeMarkdown(failure.detail)} |`);
    }
  }
  lines.push('');

  if (result.comparison) {
    lines.push('## Comparison');
    lines.push('');
    lines.push(`Newly failing: ${formatList(result.comparison.newlyFailing)}`);
    lines.push('');
    lines.push(`Newly passing: ${formatList(result.comparison.newlyPassing)}`);
    lines.push('');
  }

  lines.push('## Suggested Next Action');
  lines.push('');
  lines.push(
    result.decision === 'ACCEPTED'
      ? 'Expand to one next high-confusion domain.'
      : 'Tighten the failing layer before expanding domain scope.',
  );

  return lines.join('\n');
}

function evaluateCase(result: BenchmarkResult): ReferenceCardCaseAcceptance {
  const failures: ReferenceCardAcceptanceFailure[] = [];
  const expectedReferenceIds = arrayOrEmpty(result.expectedReferenceIds);
  const observedReferenceIds = arrayOrEmpty(result.observedReferenceIds);
  const referenceRetrievalSource = referenceRetrievalSourceFor(result, observedReferenceIds);
  const expectedTables = arrayOrEmpty(result.expectedTables);
  const observedTables = arrayOrEmpty(result.observedTables);
  const expectedSqlContains = arrayOrEmpty(result.expectedSqlContains);
  const isClarificationOnly = result.expectedClarificationConfidence != null && expectedReferenceIds.length === 0;
  const validationResults = normalizeValidationResults(result.validationResults);

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

  const blockingValidationFailures = validationResults
    ? blockingValidationFailuresFor(validationResults)
    : [];
  if (!isClarificationOnly && !validationResults) {
    failures.push({
      corpusId: result.corpusId,
      failureClass: 'validation_failure',
      detail: 'Final SQL missing validation results',
    });
  } else if (!isClarificationOnly && blockingValidationFailures.length > 0) {
    const trace = formatValidationTrace(result.validationHistory);
    failures.push({
      corpusId: result.corpusId,
      failureClass: 'validation_failure',
      detail: `Final SQL failed ${blockingValidationFailures.join(', ')}`
        + (trace ? `. Trace: ${trace}` : ''),
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
    referenceRetrievalSource,
    expectedTables,
    observedTables,
    tableSelectionPassed: result.tableSelectionPassed,
    sqlShapePassed: result.sqlShapePassed,
    clarificationPassed: result.clarificationPassed,
    qualityVerdict: result.qualityVerdict,
    validationResults: validationResults ?? FAILED_VALIDATION_RESULTS,
    advisoryL2Passed: validationResults?.l2 ?? false,
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

function normalizeValidationResults(value: unknown): BenchmarkResult['validationResults'] | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }

  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.l1 !== 'boolean' ||
    typeof candidate.l2 !== 'boolean' ||
    typeof candidate.l3 !== 'boolean' ||
    typeof candidate.l4 !== 'boolean'
  ) {
    return null;
  }

  return {
    l1: candidate.l1,
    l2: candidate.l2,
    l3: candidate.l3,
    l4: candidate.l4,
  };
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

function referenceRetrievalSourceFor(
  result: BenchmarkResult,
  observedReferenceIds: string[],
): ReferenceCardCaseAcceptance['referenceRetrievalSource'] {
  if (
    result.referenceRetrievalSource === 'explicit_probe'
    || result.referenceRetrievalSource === 'sql_grounding'
    || result.referenceRetrievalSource === 'none'
  ) {
    return result.referenceRetrievalSource;
  }
  return observedReferenceIds.length > 0 ? 'legacy' : 'none';
}

function formatList(values: string[]): string {
  return values.length > 0 ? values.join(', ') : '(none)';
}

function boolLabel(value: boolean | null): string {
  if (value === true) return 'true';
  if (value === false) return 'false';
  return 'n/a';
}

function blockingValidationLabel(validation: BenchmarkResult['validationResults']): string {
  return validation.l1 && validation.l3 && validation.l4 ? 'true' : 'false';
}

function escapeMarkdown(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}
