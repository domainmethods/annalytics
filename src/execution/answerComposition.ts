import { verifyComposition, type CompositionInput, type EligibleComposition } from './composition.js';

export interface CompositionLogger {
  info(obj: Record<string, unknown>, msg: string): void;
}

/**
 * Verify a result for an answer surface (pipeline, Table override, Summary
 * fallback). Never throws: any error is treated as ineligible so a share
 * feature can't break an answer. Logs `answer.composition` with shape
 * telemetry only — never row values, labels, SQL or table names.
 * Returns the composition only when it is eligible.
 */
export function verifyAnswerComposition(
  input: CompositionInput,
  logger: CompositionLogger,
): EligibleComposition | undefined {
  let composition: EligibleComposition | undefined;
  let fields: Record<string, unknown>;
  try {
    const verdict = verifyComposition(input);
    if (verdict.eligible) {
      composition = verdict;
      fields = { eligible: true, measureKind: verdict.measureKind, usedUniqueKeyCount: verdict.usedUniqueKeys.length };
    } else {
      fields = { eligible: false, reason: verdict.reason };
    }
  } catch {
    composition = undefined;
    fields = { eligible: false, reason: 'verifier_error' };
  }
  try {
    logger.info({ event: 'answer.composition', ...fields, rowCount: input.result?.rows?.length ?? 0 }, 'answer.composition');
  } catch {
    // Telemetry must never affect the answer.
  }
  return composition;
}
