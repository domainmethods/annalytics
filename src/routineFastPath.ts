import type { ClarificationResult } from './agents/types.js';
import type { GenerateSqlOptions } from './agents/sqlGenerator.js';
import { generateSql } from './agents/sqlGenerator.js';
import { reviewSql } from './agents/supervisorAgent.js';
import { extractReferenceIdsFromCitations, extractTeachingIdsFromCitations } from './agents/grounding.js';
import type { TableContext } from './dbt/types.js';
import type { KnowledgeSummary } from './teachings/types.js';
import type { ThreadMessage } from './types.js';
import type { FailureRecord, QualityResult } from './qualityLoop.js';
import { costGate } from './validation/costGate.js';
import { runCoreValidation, toLayerRecord, type ValidationLayerRecord } from './validation/core.js';

export type SupervisorDecision = 'skipped' | 'required';

export type RoutineFastPathResult =
  | { kind: 'ineligible'; ineligibleReasons: string[] }
  | {
      kind: 'fallback';
      reasons: string[];
      previousAttempt?: { sql: string; error: string };
      failureHistory: FailureRecord[];
      validationHistory: ValidationLayerRecord[];
      sqlResult?: QualityResult['sqlResult'];
      bytesProcessed?: number;
    }
  | {
      kind: 'complete';
      quality: QualityResult;
      supervisorDecision: SupervisorDecision;
      supervisorTriggers: string[];
      ineligibleReasons: string[];
    };

export interface RoutineFastPathInput {
  enabled: boolean;
  requireSupervisor: boolean;
  question: string;
  clarifiedQuestion: string;
  clarificationConfidence: ClarificationResult['confidence'];
  route: ClarificationResult['route'];
  tables: TableContext[];
  threadContext: ThreadMessage[];
  apiKey: string;
  fileSearchStoreId?: string;
  knowledgeSummaries: KnowledgeSummary[];
  maxBytesProcessed: number;
  fastPathMaxBytes: number;
  sampleRows?: GenerateSqlOptions['sampleRows'];
  negativeExample?: GenerateSqlOptions['negativeExample'];
  previousAttempt?: GenerateSqlOptions['previousAttempt'];
  bqml_hint?: GenerateSqlOptions['bqml_hint'];
}

export async function runRoutineFastPath(input: RoutineFastPathInput): Promise<RoutineFastPathResult> {
  const initialReasons = initialIneligibleReasons(input);
  if (initialReasons.length > 0) return { kind: 'ineligible', ineligibleReasons: initialReasons };

  const sqlResult = await generateSql({
    question: input.clarifiedQuestion,
    tables: input.tables,
    threadContext: input.threadContext,
    apiKey: input.apiKey,
    fileSearchStoreId: input.fileSearchStoreId,
    sampleRows: input.sampleRows,
    bqml_hint: input.bqml_hint,
  });

  const core = await runCoreValidation(sqlResult.sql, 0);
  const validationHistory: ValidationLayerRecord[] = core.records;
  const failureHistory: FailureRecord[] = [];
  const fallback = (reason: string, error: string): RoutineFastPathResult => ({
    kind: 'fallback',
    reasons: [reason],
    previousAttempt: { sql: sqlResult.sql, error },
    failureHistory,
    validationHistory,
    sqlResult,
  });

  if (core.blockedLayer === 'l1') {
    const error = core.blocked?.error || 'L1 static analysis blocked';
    failureHistory.push({ attempt: 0, failureType: 'structural', detail: error });
    return fallback('l1_failed', error);
  }
  if (core.blockedLayer === 'l3') {
    const error = core.blocked?.error || 'Dry-run validation failed';
    failureHistory.push({ attempt: 0, failureType: 'dry_run', detail: error });
    return fallback('l3_failed', error);
  }

  const bytesProcessed = core.bytesProcessed ?? 0;
  const l4 = costGate(bytesProcessed, input.maxBytesProcessed);
  validationHistory.push(toLayerRecord(0, 'l4', l4));
  if (!l4.valid) {
    return {
      kind: 'complete',
      quality: qualityFrom(
        sqlResult,
        'cost_exceeded',
        l4.error || 'Global cost gate exceeded',
        'low',
        validationHistory,
        failureHistory,
        bytesProcessed,
      ),
      supervisorDecision: 'required',
      supervisorTriggers: ['global_cost_gate_exceeded'],
      ineligibleReasons: [],
    };
  }

  const tableReasons = tableIneligibleReasons(sqlResult, input.tables);
  if (tableReasons.length > 0) {
    return {
      kind: 'fallback',
      reasons: tableReasons,
      previousAttempt: {
        sql: sqlResult.sql,
        error: 'Generated SQL referenced a table outside the retrieved schema',
      },
      failureHistory,
      validationHistory,
      sqlResult,
      bytesProcessed,
    };
  }

  const groundingReasons = groundingIneligibleReasons(sqlResult, input.knowledgeSummaries);
  if (groundingReasons.length > 0) {
    return {
      kind: 'fallback',
      reasons: groundingReasons,
      previousAttempt: {
        sql: sqlResult.sql,
        error: 'Missing recognized ReferenceCard or teaching grounding citation',
      },
      failureHistory,
      validationHistory,
      sqlResult,
      bytesProcessed,
    };
  }

  const supervisorTriggers = supervisorTriggersFor(sqlResult, input, bytesProcessed);
  if (input.requireSupervisor && !supervisorTriggers.includes('pilot_requires_supervisor')) {
    supervisorTriggers.push('pilot_requires_supervisor');
  }

  if (supervisorTriggers.length > 0) {
    const verdict = await reviewSql({
      userQuestion: input.question,
      clarifiedQuestion: input.clarifiedQuestion,
      generatedSql: sqlResult.sql,
      explanation: sqlResult.explanation,
      reasoningChain: sqlResult.reasoningChain,
      groundingCitations: sqlResult.groundingCitations,
      apiKey: input.apiKey,
      dryRunMetadata: { bytesProcessed },
    });

    if (verdict.verdict === 'FAIL') {
      const error = supervisorError(verdict.issues, verdict.suggestions);
      failureHistory.push({
        attempt: 0,
        failureType: 'semantic',
        detail: verdict.issues.join('; ') || 'Supervisor review failed',
      });
      return {
        kind: 'fallback',
        reasons: ['supervisor_failed'],
        previousAttempt: { sql: sqlResult.sql, error },
        failureHistory,
        validationHistory,
        sqlResult,
        bytesProcessed,
      };
    }

    return {
      kind: 'complete',
      quality: qualityFrom(
        sqlResult,
        'pass',
        verdict.issues.join('; ') || 'Approved',
        verdict.confidence,
        validationHistory,
        failureHistory,
        bytesProcessed,
      ),
      supervisorDecision: 'required',
      supervisorTriggers,
      ineligibleReasons: [],
    };
  }

  return {
    kind: 'complete',
    quality: qualityFrom(
      sqlResult,
      'pass',
      'Routine fast path: supervisor skipped',
      sqlResult.confidence,
      validationHistory,
      failureHistory,
      bytesProcessed,
    ),
    supervisorDecision: 'skipped',
    supervisorTriggers: [],
    ineligibleReasons: [],
  };
}

function initialIneligibleReasons(input: RoutineFastPathInput): string[] {
  const reasons: string[] = [];
  if (!input.enabled) reasons.push('fast_path_disabled');
  if (input.route !== 'data_query') reasons.push('not_data_query');
  if (input.clarificationConfidence === 'low') reasons.push('low_clarification_confidence');
  if (input.negativeExample) reasons.push('negative_feedback_recovery');
  if (input.previousAttempt) reasons.push('refinement_or_retry');
  if (!input.fileSearchStoreId) reasons.push('missing_file_search_store');
  if (input.tables.length === 0) reasons.push('missing_retrieved_schema');
  if (input.knowledgeSummaries.length === 0) reasons.push('missing_knowledge_summary');
  return reasons;
}

function tableIneligibleReasons(sqlResult: QualityResult['sqlResult'], tables: TableContext[]): string[] {
  const allowed = tables.map(table => table.name);
  const reportedTables = sqlResult.tablesUsed.map(normalizeTableName).filter(Boolean);
  const sqlTables = extractTableReferences(sqlResult.sql);
  const allGeneratedTables = [...new Set([...reportedTables, ...sqlTables])];

  const reasons: string[] = [];
  if (allGeneratedTables.some(table => !isAllowedTable(table, allowed))) {
    reasons.push('table_outside_retrieved_schema');
  }
  if (sqlTables.some(table => !reportedTables.some(reported => sameTableReference(reported, table)))) {
    reasons.push('missing_tables_used');
  }
  return reasons;
}

function groundingIneligibleReasons(sqlResult: QualityResult['sqlResult'], summaries: KnowledgeSummary[]): string[] {
  const referenceIds = extractReferenceIdsFromCitations(sqlResult.groundingCitations);
  const teachingIds = extractTeachingIdsFromCitations(sqlResult.groundingCitations);
  const referenceSummaries = summaries.filter(summary => summary.kind === 'reference_card' && summary.id);
  const teachingSummaries = summaries.filter(summary => summary.kind === 'teaching' && summary.id);
  const knownReferenceIds = new Set(referenceSummaries.map(summary => summary.id));
  const knownTeachingIds = new Set(teachingSummaries.map(summary => summary.id));
  const recognizedReferenceIds = referenceIds.filter(id => knownReferenceIds.has(id));
  const recognizedTeachingIds = teachingIds.filter(id => knownTeachingIds.has(id));

  const reasons: string[] = [];
  if (recognizedReferenceIds.length === 0 && recognizedTeachingIds.length === 0) {
    reasons.push('missing_grounding_citation');
  }
  if (referenceIds.some(id => !knownReferenceIds.has(id)) || teachingIds.some(id => !knownTeachingIds.has(id))) {
    reasons.push('unknown_grounding_citation');
  }

  const generatedTables = [...new Set([
    ...sqlResult.tablesUsed.map(normalizeTableName).filter(Boolean),
    ...extractTableReferences(sqlResult.sql),
  ])];
  for (const id of recognizedReferenceIds) {
    const summary = referenceSummaries.find(item => item.id === id);
    if (summary?.canonical_table && !generatedTables.some(table => sameTableReference(table, summary.canonical_table))) {
      reasons.push('reference_card_canonical_table_mismatch');
      break;
    }
  }

  return reasons;
}

function supervisorTriggersFor(
  sqlResult: QualityResult['sqlResult'],
  input: RoutineFastPathInput,
  bytesProcessed: number,
): string[] {
  const triggers: string[] = [];
  if (bytesProcessed > input.fastPathMaxBytes) triggers.push('fast_path_bytes_exceeded');
  if (sqlResult.confidence === 'low') triggers.push('low_sql_confidence');
  if (usesComplexSql(sqlResult.sql, sqlResult.tablesUsed)) triggers.push('complex_sql_shape');
  if (input.threadContext.length > 0) triggers.push('thread_context_present');
  if (input.bqml_hint) triggers.push('bqml_hint_present');
  return triggers;
}

function usesComplexSql(sql: string, tablesUsed: string[]): boolean {
  if (/\bml\./i.test(sql)) return true;
  if (/\bover\s*\(/i.test(sql)) return true;
  if (/\bwith\b/i.test(sql)) return true;
  if (/\(\s*select\b/i.test(sql)) return true;
  if (/\bdate_(trunc|diff|add|sub)\s*\(/i.test(sql)) return true;
  if (/\bextract\s*\(/i.test(sql)) return true;

  const factTables = tablesUsed.filter(table => /\bfct_/i.test(table));
  return factTables.length > 1 && /\bjoin\b/i.test(sql);
}

function qualityFrom(
  sqlResult: QualityResult['sqlResult'],
  verdict: QualityResult['verdict'],
  supervisorNotes: string,
  finalConfidence: QualityResult['finalConfidence'],
  validationHistory: ValidationLayerRecord[],
  failureHistory: FailureRecord[],
  bytesProcessed?: number,
): QualityResult {
  return {
    sqlResult,
    verdict,
    supervisorNotes,
    finalConfidence,
    retryCount: 0,
    failureHistory,
    validationHistory,
    bytesProcessed,
  };
}

function supervisorError(issues: string[], suggestions: string[]): string {
  return [
    'Supervisor review failed:',
    ...issues.map(issue => `- ${issue}`),
    'Suggestions:',
    ...suggestions.map(suggestion => `- ${suggestion}`),
  ].join('\n');
}

function extractTableReferences(sql: string): string[] {
  const refs = new Set<string>();
  const pattern = /\b(?:from|join)\s+`?([a-zA-Z_][\w-]*(?:\.[a-zA-Z_][\w-]*){1,2})`?/gi;
  for (const match of sql.matchAll(pattern)) {
    const ref = normalizeTableName(match[1]);
    if (ref) refs.add(ref);
  }
  return [...refs];
}

function normalizeTableName(value: string | undefined): string {
  return (value ?? '').replace(/`/g, '').trim();
}

function isAllowedTable(candidate: string, allowedTables: string[]): boolean {
  return allowedTables.some(allowed => sameTableReference(candidate, allowed));
}

function sameTableReference(left: string, right: string): boolean {
  const normalizedLeft = normalizeTableName(left).toLowerCase();
  const normalizedRight = normalizeTableName(right).toLowerCase();
  return normalizedLeft === normalizedRight || normalizedLeft.endsWith(`.${normalizedRight}`);
}
