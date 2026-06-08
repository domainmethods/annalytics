import type { GoogleGenAI } from '@google/genai';
import type { CorpusEntry, BenchmarkResult, JudgeResult } from './benchmark-types.js';

// ── JSON Schema for judge response ───────────────────────────────────────────

export const judgeResponseSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object' as const,
  properties: {
    correctness: { type: 'number', minimum: 1, maximum: 5 },
    efficiency: { type: 'number', minimum: 1, maximum: 5 },
    readability: { type: 'number', minimum: 1, maximum: 5 },
    teachingCompliance: { type: 'number', minimum: 1, maximum: 5 },
    safety: { type: 'number', minimum: 1, maximum: 5 },
    rationale: { type: 'string' },
    suggestedImprovement: { type: 'string' },
    flaggedForReview: { type: 'boolean' },
  },
  required: ['correctness', 'efficiency', 'readability', 'teachingCompliance', 'safety', 'rationale', 'flaggedForReview'],
};

// ── Judge interface ───────────────────────────────────────────────────────────

export interface JudgeResponse {
  correctness: number;
  efficiency: number;
  readability: number;
  teachingCompliance: number;
  safety: number;
  rationale: string;
  suggestedImprovement?: string;
  flaggedForReview: boolean;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

export function computeOverallScore(scores: JudgeResponse): number {
  return (
    scores.correctness * 3 +
    scores.efficiency +
    scores.readability +
    scores.teachingCompliance +
    scores.safety
  ) / 7;
}

export function buildJudgePrompt(entry: CorpusEntry | undefined, result: BenchmarkResult): string {
  const lines: string[] = [
    'You are an expert SQL quality judge. Evaluate the following SQL generation result on 5 criteria, each scored 1-5.',
    '',
    '## Scoring Criteria',
    '- **correctness** (1-5): Does the SQL correctly answer the question? Consider table selection, joins, filters, aggregations.',
    '- **efficiency** (1-5): Is the SQL well-optimized? Avoids unnecessary scans, uses appropriate filters, efficient joins.',
    '- **readability** (1-5): Is the SQL readable and well-formatted? Clear aliases, consistent style, logical structure.',
    '- **teachingCompliance** (1-5): Does the SQL respect known best practices and teaching patterns? Score 3 if no relevant teaching applies.',
    '- **safety** (1-5): Is the SQL safe? No DML/DDL, no unbounded scans on huge tables, appropriate LIMIT clauses where needed.',
    '',
    '## Question',
    result.question,
    '',
  ];

  if (entry?.knownGoodSql) {
    lines.push('## Known Good SQL (reference)');
    lines.push('```sql');
    lines.push(entry.knownGoodSql);
    lines.push('```');
    lines.push('');
  }

  if (entry?.expectedTables && entry.expectedTables.length > 0) {
    lines.push(`## Expected Tables: ${entry.expectedTables.join(', ')}`);
    lines.push('');
  }

  lines.push('## Generated SQL');
  if (result.generatedSql) {
    lines.push('```sql');
    lines.push(result.generatedSql);
    lines.push('```');
  } else {
    lines.push('(No SQL generated — pipeline was exhausted or question was too ambiguous)');
  }

  lines.push('');
  lines.push('## Pipeline Result');
  lines.push(`- Verdict: ${result.qualityVerdict}`);
  lines.push(`- Confidence: ${result.confidence}`);
  lines.push(`- Retry Count: ${result.retryCount}`);
  lines.push(`- Supervisor Notes: ${result.supervisorNotes}`);
  lines.push(`- Teaching Compliance: ${result.teachingCompliance}`);

  if (result.bytesProcessed != null) {
    const gb = (result.bytesProcessed / 1024 / 1024 / 1024).toFixed(3);
    lines.push(`- Bytes Processed: ${result.bytesProcessed} (${gb} GB)`);
  }

  lines.push('');
  lines.push('Score each criterion 1-5 and provide a brief rationale. Set flaggedForReview=true if the result needs human attention (e.g., incorrect SQL that passed, safety concerns, or severe quality issues).');

  return lines.join('\n');
}

/**
 * Run the judge on a single benchmark result. Does the generateContent call,
 * parses the JSON response, and returns the JudgeResult (overallScore rounded
 * to 2 decimal places). Throws on an empty response.
 */
export async function judgeSingleResult(
  ai: GoogleGenAI,
  entry: CorpusEntry | undefined,
  result: BenchmarkResult,
  judgeModel: string,
): Promise<JudgeResult> {
  const prompt = buildJudgePrompt(entry, result);

  const response = await ai.models.generateContent({
    model: judgeModel,
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    config: {
      responseMimeType: 'application/json',
      responseJsonSchema: judgeResponseSchema,
      temperature: 0.1,
    },
  });

  if (!response.text) throw new Error('Empty response from judge');

  const judgeResponse = JSON.parse(response.text) as JudgeResponse;
  const overallScore = computeOverallScore(judgeResponse);

  const judgeResult: JudgeResult = {
    corpusId: result.corpusId,
    scores: {
      correctness: judgeResponse.correctness,
      efficiency: judgeResponse.efficiency,
      readability: judgeResponse.readability,
      teachingCompliance: judgeResponse.teachingCompliance,
      safety: judgeResponse.safety,
    },
    overallScore: Math.round(overallScore * 100) / 100,
    rationale: judgeResponse.rationale,
    ...(judgeResponse.suggestedImprovement !== undefined && {
      suggestedImprovement: judgeResponse.suggestedImprovement,
    }),
    flaggedForReview: judgeResponse.flaggedForReview,
  };

  return judgeResult;
}
