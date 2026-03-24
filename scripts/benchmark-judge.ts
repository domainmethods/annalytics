import { readFileSync, writeFileSync } from 'fs';
import { join } from 'node:path';
import { GoogleGenAI } from '@google/genai';
import type { CorpusEntry, BenchmarkResult, JudgeResult, BenchmarkRun } from './benchmark-types.js';

// ── Env validation ────────────────────────────────────────────────────────────

const apiKey = process.env.GEMINI_API_KEY;

if (!apiKey) {
  console.error('Error: Missing required environment variable: GEMINI_API_KEY');
  process.exit(1);
}

// ── CLI arg validation ────────────────────────────────────────────────────────

const [, , resultsFilePath] = process.argv;

if (!resultsFilePath) {
  console.error('Usage: npx tsx scripts/benchmark-judge.ts benchmarks/results/YYYY-MM-DD.json');
  process.exit(1);
}

// ── JSON Schema for judge response ───────────────────────────────────────────

const judgeResponseSchema = {
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

interface JudgeResponse {
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

function computeOverallScore(scores: JudgeResponse): number {
  return (
    scores.correctness * 3 +
    scores.efficiency +
    scores.readability +
    scores.teachingCompliance +
    scores.safety
  ) / 7;
}

function buildJudgePrompt(entry: CorpusEntry | undefined, result: BenchmarkResult): string {
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

  if (result.bytesProcessed !== null) {
    const gb = (result.bytesProcessed / 1024 / 1024 / 1024).toFixed(3);
    lines.push(`- Bytes Processed: ${result.bytesProcessed} (${gb} GB)`);
  }

  lines.push('');
  lines.push('Score each criterion 1-5 and provide a brief rationale. Set flaggedForReview=true if the result needs human attention (e.g., incorrect SQL that passed, safety concerns, or severe quality issues).');

  return lines.join('\n');
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const resolvedPath = resultsFilePath.startsWith('/')
    ? resultsFilePath
    : join(process.cwd(), resultsFilePath);

  // Load results file
  let benchmarkRun: BenchmarkRun;
  try {
    const raw = readFileSync(resolvedPath, 'utf-8');
    benchmarkRun = JSON.parse(raw) as BenchmarkRun;
  } catch (err) {
    console.error(`Error reading results file: ${(err as Error).message}`);
    process.exit(1);
  }

  // Load corpus
  const corpusPath = join(process.cwd(), 'benchmarks', 'corpus.json');
  let corpus: CorpusEntry[] = [];
  try {
    const raw = readFileSync(corpusPath, 'utf-8');
    corpus = JSON.parse(raw) as CorpusEntry[];
  } catch (err) {
    console.warn(`Warning: Could not load corpus: ${(err as Error).message}. Proceeding without corpus metadata.`);
  }

  const corpusMap = new Map<string, CorpusEntry>(corpus.map(e => [e.id, e]));

  console.log(`Judging ${benchmarkRun.results.length} result(s) from ${benchmarkRun.runDate}...\n`);

  const ai = new GoogleGenAI({ apiKey: apiKey! });
  const judgeResults: JudgeResult[] = [];

  for (const result of benchmarkRun.results) {
    const entry = corpusMap.get(result.corpusId);
    const prompt = buildJudgePrompt(entry, result);

    console.log(`[${result.corpusId}] Judging...`);

    const response = await ai.models.generateContent({
      model: 'gemini-2.0-pro-exp',
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      config: {
        responseMimeType: 'application/json',
        responseJsonSchema: judgeResponseSchema,
        temperature: 0.1,
      },
    });

    if (!response.text) throw new Error('Empty response from judge for ' + result.corpusId);

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

    judgeResults.push(judgeResult);

    const flagLabel = judgeResult.flaggedForReview ? ' [FLAGGED]' : '';
    console.log(`  overall: ${judgeResult.overallScore.toFixed(2)}${flagLabel}`);
    console.log(`  scores: correctness=${judgeResult.scores.correctness} efficiency=${judgeResult.scores.efficiency} readability=${judgeResult.scores.readability} teachingCompliance=${judgeResult.scores.teachingCompliance} safety=${judgeResult.scores.safety}`);
    console.log(`  rationale: ${judgeResult.rationale.slice(0, 120)}${judgeResult.rationale.length > 120 ? '...' : ''}\n`);
  }

  // Append judgeResults to the results file
  const updated: BenchmarkRun = {
    ...benchmarkRun,
    judgeResults,
  };
  writeFileSync(resolvedPath, JSON.stringify(updated, null, 2), 'utf-8');
  console.log(`Judge results written to ${resolvedPath}`);

  // Summary
  const avgScore = judgeResults.reduce((sum, r) => sum + r.overallScore, 0) / judgeResults.length;
  const flaggedCount = judgeResults.filter(r => r.flaggedForReview).length;

  console.log('\n── Summary ──────────────────────────────────────────────────────────────');
  console.log(`Average score: ${avgScore.toFixed(2)} / 5.00`);
  console.log(`Flagged for review: ${flaggedCount} / ${judgeResults.length}`);

  if (flaggedCount > 0) {
    console.log('\nFlagged entries:');
    judgeResults
      .filter(r => r.flaggedForReview)
      .forEach(r => console.log(`  - ${r.corpusId} (score: ${r.overallScore.toFixed(2)}): ${r.rationale.slice(0, 100)}`));
  }
}

main().then(() => {
  process.exit(0);
}).catch(err => {
  console.error('Judge failed:', err);
  process.exit(1);
});
