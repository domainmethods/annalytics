import { readFileSync, writeFileSync } from 'node:fs';
import { GoogleGenAI } from '@google/genai';
import type { CorpusEntry, JudgeResult, BenchmarkRun } from './benchmark-types.js';
import { getJudgeModel } from '../src/agents/modelConfig.js';
import { judgeSingleResult } from './benchmark-judge-core.js';

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

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  // Load results file
  let benchmarkRun: BenchmarkRun;
  try {
    const raw = readFileSync(resultsFilePath, 'utf-8');
    benchmarkRun = JSON.parse(raw) as BenchmarkRun;
  } catch (err) {
    console.error(`Error reading results file: ${(err as Error).message}`);
    process.exit(1);
  }

  // Load corpus
  const corpusPath = 'benchmarks/corpus.json';
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

  // Resume from previous progress if script was interrupted
  const judgeResults: JudgeResult[] = benchmarkRun.judgeResults ? [...benchmarkRun.judgeResults] : [];
  const judgedIds = new Set(judgeResults.map(r => r.corpusId));

  if (judgedIds.size > 0) {
    console.log(`Resuming: ${judgedIds.size} already judged, ${benchmarkRun.results.length - judgedIds.size} remaining\n`);
  }

  for (const result of benchmarkRun.results) {
    if (judgedIds.has(result.corpusId)) {
      console.log(`[${result.corpusId}] Already judged, skipping...`);
      continue;
    }

    const entry = corpusMap.get(result.corpusId);

    console.log(`[${result.corpusId}] Judging...`);

    try {
      const judgeResult = await judgeSingleResult(ai, entry, result, getJudgeModel());

      judgeResults.push(judgeResult);

      // Write incrementally to preserve progress
      const updated: BenchmarkRun = { ...benchmarkRun, judgeResults };
      writeFileSync(resultsFilePath, JSON.stringify(updated, null, 2), 'utf-8');

      const flagLabel = judgeResult.flaggedForReview ? ' [FLAGGED]' : '';
      console.log(`  overall: ${judgeResult.overallScore.toFixed(2)}${flagLabel}`);
      console.log(`  scores: correctness=${judgeResult.scores.correctness} efficiency=${judgeResult.scores.efficiency} readability=${judgeResult.scores.readability} teachingCompliance=${judgeResult.scores.teachingCompliance} safety=${judgeResult.scores.safety}`);
      console.log(`  rationale: ${judgeResult.rationale.slice(0, 120)}${judgeResult.rationale.length > 120 ? '...' : ''}\n`);
    } catch (err) {
      console.error(`  ERROR judging ${result.corpusId}: ${(err as Error).message}\n`);
    }
  }

  console.log(`Judge results written to ${resultsFilePath}`);

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
