import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { initBigQuery } from '../src/validation/dryRun.js';
import { initFirestore } from '../src/state/firestore.js';
import { classifyQuestion } from '../src/agents/clarificationAgent.js';
import { qualityLoop } from '../src/qualityLoop.js';
import { getTeachingSummaries } from '../src/teachings/summaryMap.js';
import { parseDbtArtifacts } from '../src/dbt/parser.js';
import type { TeachingSummary } from '../src/teachings/types.js';
import type { TableContext } from '../src/dbt/types.js';
import type { CorpusEntry, BenchmarkResult } from './benchmark-types.js';

// ── Env validation ────────────────────────────────────────────────────────────

const apiKey = process.env.GEMINI_API_KEY;
const projectId = process.env.GCP_PROJECT_ID;

if (!apiKey || !projectId) {
  const missing = [
    !apiKey && 'GEMINI_API_KEY',
    !projectId && 'GCP_PROJECT_ID',
  ].filter(Boolean).join(', ');
  console.error(`Error: Missing required environment variable(s): ${missing}`);
  process.exit(1);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

const MAX_BYTES = 1 * 1024 * 1024 * 1024; // 1 GB cost gate for benchmark

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const runDate = formatDate(new Date());

  console.log(`Benchmark run: ${runDate}`);

  // Initialize services
  initFirestore(projectId!);
  initBigQuery(projectId!);

  // Load teaching summaries from Firestore
  let teachingSummaries: TeachingSummary[] = [];
  try {
    teachingSummaries = await getTeachingSummaries();
    console.log(`Loaded ${teachingSummaries.length} teaching summaries`);
  } catch (err) {
    console.warn(`Warning: Could not load teaching summaries: ${(err as Error).message}`);
  }

  // Load dbt artifacts (optional — benchmark can run without schema context)
  const root = join(process.cwd());
  let tables: TableContext[] = [];
  try {
    const manifestRaw = await readFile(join(root, 'dbt', 'manifest.json'), 'utf-8');
    const catalogRaw = await readFile(join(root, 'dbt', 'catalog.json'), 'utf-8');
    const manifest = JSON.parse(manifestRaw) as { nodes: Record<string, unknown> };
    const catalog = JSON.parse(catalogRaw) as { nodes: Record<string, unknown> };
    tables = parseDbtArtifacts(
      manifest as Parameters<typeof parseDbtArtifacts>[0],
      catalog as Parameters<typeof parseDbtArtifacts>[1],
    );
    console.log(`Loaded ${tables.length} dbt tables`);
  } catch (err) {
    console.warn(`Warning: Could not load dbt artifacts: ${(err as Error).message}. Running without schema context.`);
  }

  // Read corpus
  const corpusPath = join(root, 'benchmarks', 'corpus.json');
  const corpusRaw = await readFile(corpusPath, 'utf-8');
  const corpus = JSON.parse(corpusRaw) as CorpusEntry[];
  console.log(`Corpus: ${corpus.length} questions\n`);

  // Run each question
  const results: BenchmarkResult[] = [];

  for (const entry of corpus) {
    console.log(`[${entry.id}] ${entry.question}`);
    const totalStart = Date.now();

    try {
      // Step 1: Clarification
      const clarifyStart = Date.now();
      const clarification = await classifyQuestion(
        entry.question,
        [],           // no thread context in benchmark
        teachingSummaries,
        apiKey!,
      );
      const clarifyMs = Date.now() - clarifyStart;

      console.log(`  clarification: ${clarification.confidence} (${clarifyMs}ms)`);

      // If LOW confidence, record and skip quality loop
      if (clarification.confidence === 'low') {
        const totalMs = Date.now() - totalStart;
        results.push({
          corpusId: entry.id,
          question: entry.question,
          generatedSql: null,
          confidence: 'low',
          qualityVerdict: 'exhausted',
          retryCount: 0,
          validationResults: { l1: false, l2: false, l3: false, l4: false },
          bytesProcessed: null,
          supervisorNotes: 'Skipped: LOW clarification confidence',
          teachingCompliance: 'no_relevant_teaching',
          latencyMs: {
            clarification: clarifyMs,
            generation: 0,
            validation: 0,
            supervisor: 0,
            total: totalMs,
          },
          groundingCitations: [],
        });
        console.log(`  -> skipped (LOW confidence)\n`);
        continue;
      }

      // Step 2: Quality loop
      const loopStart = Date.now();
      const quality = await qualityLoop(
        {
          question: clarification.resolved_question || entry.question,
          tables,
          threadContext: [],
          apiKey: apiKey!,
          bqml_hint: clarification.bqml_hint ?? undefined,
        },
        apiKey!,                        // supervisor uses same API key
        clarification.resolved_question || entry.question,
        MAX_BYTES,
      );
      const loopMs = Date.now() - loopStart;
      const totalMs = Date.now() - totalStart;

      const result: BenchmarkResult = {
        corpusId: entry.id,
        question: entry.question,
        generatedSql: quality.sqlResult.sql,
        confidence: quality.finalConfidence,
        qualityVerdict: quality.verdict,
        retryCount: quality.retryCount,
        validationResults: {
          l1: quality.verdict !== 'exhausted',
          l2: quality.verdict !== 'exhausted',
          l3: quality.verdict !== 'exhausted',
          l4: quality.verdict !== 'cost_exceeded',
        },
        bytesProcessed: quality.bytesProcessed ?? null,
        supervisorNotes: quality.supervisorNotes,
        teachingCompliance: 'no_relevant_teaching',
        latencyMs: {
          clarification: clarifyMs,
          generation: loopMs,
          validation: 0,
          supervisor: 0,
          total: totalMs,
        },
        groundingCitations: quality.sqlResult.groundingCitations.map(c => c.sourceFile),
      };

      results.push(result);
      console.log(`  verdict: ${quality.verdict}, confidence: ${quality.finalConfidence}, retries: ${quality.retryCount} (${totalMs}ms)\n`);

    } catch (err) {
      const totalMs = Date.now() - totalStart;
      console.error(`  ERROR: ${(err as Error).message}\n`);
      results.push({
        corpusId: entry.id,
        question: entry.question,
        generatedSql: null,
        confidence: 'low',
        qualityVerdict: 'exhausted',
        retryCount: 0,
        validationResults: { l1: false, l2: false, l3: false, l4: false },
        bytesProcessed: null,
        supervisorNotes: `Error: ${(err as Error).message}`,
        teachingCompliance: 'no_relevant_teaching',
        latencyMs: {
          clarification: 0,
          generation: 0,
          validation: 0,
          supervisor: 0,
          total: totalMs,
        },
        groundingCitations: [],
      });
    }
  }

  // Write results
  const resultsDir = join(root, 'benchmarks', 'results');
  await mkdir(resultsDir, { recursive: true });
  const outputPath = join(resultsDir, `${runDate}.json`);
  const output = {
    runDate,
    corpusSize: corpus.length,
    results,
  };
  await writeFile(outputPath, JSON.stringify(output, null, 2), 'utf-8');
  console.log(`Results written to benchmarks/results/${runDate}.json`);

  // Summary
  const passed = results.filter(r => r.qualityVerdict === 'pass' || r.qualityVerdict === 'fail_then_pass').length;
  console.log(`\nPass: ${passed}/${corpus.length}`);
}

main().then(() => {
  process.exit(0);
}).catch(err => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
