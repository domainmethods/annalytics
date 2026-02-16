import { generateSql, type GenerateSqlOptions } from './sqlGenerator.js';
import { reviewSql, type SupervisorInput } from './supervisorAgent.js';
import type { SqlGenerationResult } from '../types.js';
import type { SupervisorVerdict } from './types.js';

const MAX_RETRIES = 2;

export interface SupervisedResult {
  sqlResult: SqlGenerationResult;
  verdict: 'pass' | 'fail_then_pass' | 'exhausted';
  supervisorNotes: string;
  finalConfidence: 'high' | 'medium' | 'low';
  retryCount: number;
}

export async function generateWithSupervision(
  options: GenerateSqlOptions,
  supervisorApiKey: string,
  clarifiedQuestion: string,
): Promise<SupervisedResult> {
  let sqlResult = await generateSql(options);
  let lastVerdict: SupervisorVerdict | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const supervisorInput: SupervisorInput = {
      userQuestion: options.question,
      clarifiedQuestion,
      generatedSql: sqlResult.sql,
      explanation: sqlResult.explanation,
      reasoningChain: sqlResult.reasoningChain,
      groundingCitations: sqlResult.groundingCitations,
      apiKey: supervisorApiKey,
    };

    lastVerdict = await reviewSql(supervisorInput);

    if (lastVerdict.verdict === 'PASS') {
      return {
        sqlResult,
        verdict: attempt === 0 ? 'pass' : 'fail_then_pass',
        supervisorNotes: lastVerdict.issues.join('; ') || 'Approved',
        finalConfidence: lastVerdict.confidence,
        retryCount: attempt,
      };
    }

    // FAIL — retry with critique if not exhausted
    if (attempt < MAX_RETRIES) {
      const errorContext = [
        'Supervisor review failed:',
        ...lastVerdict.issues.map(i => `- ${i}`),
        'Suggestions:',
        ...lastVerdict.suggestions.map(s => `- ${s}`),
      ].join('\n');

      sqlResult = await generateSql({
        ...options,
        previousAttempt: {
          sql: sqlResult.sql,
          error: errorContext,
        },
      });
    }
  }

  // Exhausted — proceed with low confidence
  return {
    sqlResult,
    verdict: 'exhausted',
    supervisorNotes: `Supervisor could not approve after ${MAX_RETRIES + 1} attempts. Issues: ${lastVerdict!.issues.join('; ')}`,
    finalConfidence: 'low',
    retryCount: MAX_RETRIES,
  };
}
