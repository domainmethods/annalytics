import { generateSql, type GenerateSqlOptions } from './agents/sqlGenerator.js';
import { reviewSql, type SupervisorInput } from './agents/supervisorAgent.js';
import { costGate } from './validation/costGate.js';
import { runCoreValidation, toLayerRecord, type ValidationLayerRecord } from './validation/core.js';
// Re-exported so existing importers (scripts/benchmark-types.ts, scripts/benchmarkSupport.ts)
// keep importing ValidationLayerRecord from this module unchanged.
export type { ValidationLayerRecord };
import type { SqlGenerationResult } from './types.js';

// ── Types ──────────────────────────────────────────────────────────────

export interface FailureRecord {
  attempt: number;
  failureType: 'structural' | 'dry_run' | 'semantic';
  detail: string;
}

export interface QualityResult {
  sqlResult: SqlGenerationResult;
  verdict: 'pass' | 'fail_then_pass' | 'exhausted' | 'cost_exceeded';
  supervisorNotes: string;
  finalConfidence: 'high' | 'medium' | 'low';
  retryCount: number;
  failureHistory: FailureRecord[];
  validationHistory?: ValidationLayerRecord[];
  bytesProcessed?: number;
}

export interface StatusCallbacks {
  onGenerate?: () => void | Promise<void>;
  onValidate?: () => void | Promise<void>;
  onReview?: () => void | Promise<void>;
  onRetry?: (attempt: number) => void | Promise<void>;
}

// ── Quality Loop ───────────────────────────────────────────────────────

const MAX_ATTEMPTS = 3;

export async function qualityLoop(
  options: GenerateSqlOptions,
  supervisorApiKey: string,
  clarifiedQuestion: string,
  maxBytesProcessed: number,
  callbacks?: StatusCallbacks,
): Promise<QualityResult> {
  const failureHistory: FailureRecord[] = [];
  const validationHistory: ValidationLayerRecord[] = [];
  let lastSqlResult: SqlGenerationResult | null = null;
  let lastSupervisorNotes = '';
  let lastConfidence: 'high' | 'medium' | 'low' = 'low';
  let lastBytesProcessed: number | undefined;
  let previousError: { sql: string; error: string } | undefined;
  let passedAttempt = -1;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      await callbacks?.onRetry?.(attempt);
    }

    // 1. Generate SQL
    await callbacks?.onGenerate?.();
    const genOptions: GenerateSqlOptions = previousError
      ? { ...options, previousAttempt: previousError }
      : options;
    const sqlResult = await generateSql(genOptions);
    lastSqlResult = sqlResult;

    // 2-4. L1 static → L2 AST (advisory) → L3 dry run
    await callbacks?.onValidate?.();
    const core = await runCoreValidation(sqlResult.sql, attempt);
    validationHistory.push(...core.records);

    if (core.blockedLayer === 'l1') {
      failureHistory.push({
        attempt,
        failureType: 'structural',
        detail: core.blocked?.error || 'L1 static analysis blocked',
      });
      previousError = { sql: sqlResult.sql, error: core.blocked?.error || 'Static analysis blocked' };
      continue;
    }
    if (core.blockedLayer === 'l3') {
      failureHistory.push({
        attempt,
        failureType: 'dry_run',
        detail: core.blocked?.error || 'Dry-run validation failed',
      });
      previousError = { sql: sqlResult.sql, error: core.blocked?.error || 'Dry-run failed' };
      continue;
    }
    // Raw L3 bytes (may be undefined) — rawBytesProcessed preserves the dry-run
    // value verbatim, distinct from core.bytesProcessed which coalesces to 0.
    const l3Bytes = core.rawBytesProcessed;
    lastBytesProcessed = l3Bytes;

    // 5. Supervisor review (only for structurally valid SQL)
    await callbacks?.onReview?.();
    const supervisorInput: SupervisorInput = {
      userQuestion: options.question,
      clarifiedQuestion,
      generatedSql: sqlResult.sql,
      explanation: sqlResult.explanation,
      reasoningChain: sqlResult.reasoningChain,
      groundingCitations: sqlResult.groundingCitations,
      apiKey: supervisorApiKey,
      dryRunMetadata: l3Bytes != null ? { bytesProcessed: l3Bytes } : undefined,
    };

    const verdict = await reviewSql(supervisorInput);

    if (verdict.verdict === 'PASS') {
      lastSupervisorNotes = verdict.issues.join('; ') || 'Approved';
      lastConfidence = verdict.confidence;
      passedAttempt = attempt;
      break;
    }

    // Supervisor FAIL — record and retry
    lastSupervisorNotes = verdict.issues.join('; ');
    lastConfidence = verdict.confidence;
    failureHistory.push({
      attempt,
      failureType: 'semantic',
      detail: verdict.issues.join('; '),
    });
    const errorContext = [
      'Supervisor review failed:',
      ...verdict.issues.map((i: string) => `- ${i}`),
      'Suggestions:',
      ...verdict.suggestions.map((s: string) => `- ${s}`),
    ].join('\n');
    previousError = { sql: sqlResult.sql, error: errorContext };
  }

  // lastSqlResult is guaranteed set: loop runs at least once (MAX_ATTEMPTS >= 1)
  const sqlResult = lastSqlResult as SqlGenerationResult;

  // Exhausted — no attempt passed
  if (passedAttempt === -1) {
    return {
      sqlResult,
      verdict: 'exhausted',
      supervisorNotes: `Quality loop exhausted after ${MAX_ATTEMPTS} attempts.${lastSupervisorNotes ? ' ' + lastSupervisorNotes : ''}`,
      finalConfidence: 'low',
      retryCount: MAX_ATTEMPTS - 1,
      failureHistory,
      validationHistory,
      bytesProcessed: lastBytesProcessed,
    };
  }

  // L4: Cost gate (outside loop — policy, not quality)
  const l4 = costGate(lastBytesProcessed ?? 0, maxBytesProcessed);
  validationHistory.push(toLayerRecord(passedAttempt, 'l4', l4));
  if (!l4.valid) {
    return {
      sqlResult,
      verdict: 'cost_exceeded',
      supervisorNotes: lastSupervisorNotes,
      finalConfidence: lastConfidence,
      retryCount: passedAttempt,
      failureHistory,
      validationHistory,
      bytesProcessed: lastBytesProcessed,
    };
  }

  return {
    sqlResult: lastSqlResult!,
    verdict: passedAttempt === 0 ? 'pass' : 'fail_then_pass',
    supervisorNotes: lastSupervisorNotes,
    finalConfidence: lastConfidence,
    retryCount: passedAttempt,
    failureHistory,
    validationHistory,
    bytesProcessed: lastBytesProcessed,
  };
}
