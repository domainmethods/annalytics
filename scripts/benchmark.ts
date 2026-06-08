import { access, readFile, mkdir, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { initBigQuery } from '../src/validation/dryRun.js';
import { classifyQuestion } from '../src/agents/clarificationAgent.js';
import { qualityLoop } from '../src/qualityLoop.js';
import { parseDbtArtifacts } from '../src/dbt/parser.js';
import type { KnowledgeSummary } from '../src/teachings/types.js';
import type { TableContext } from '../src/dbt/types.js';
import type { CorpusEntry, BenchmarkResult } from './benchmark-types.js';
import { getFlashModel, getJudgeModel, getProModel } from '../src/agents/modelConfig.js';
import {
  assertGenerateContentModelsAvailable,
  validateBenchmarkAcceptanceInputs,
} from './benchmarkPreflight.js';
import { loadLocalKnowledgeSummaries } from './benchmarkInputs.js';
import {
  buildBenchmarkMetadata,
  clarificationPassed,
  combineReferenceIds,
  extractTablesFromSql,
  extractReferenceIdsFromCitations,
  extractTeachingIdsFromCitations,
  getGitDirty,
  getGitSha,
  referenceRetrievalPassed,
  referenceRetrievalSource,
  sqlShapePassed,
  tableSelectionPassed,
  teachingComplianceLabel,
  teachingRetrievalPassed,
  validationResultsFromFailures,
} from './benchmarkSupport.js';
import { probeReferenceCards } from './referenceProbe.js';

// ── Env validation ────────────────────────────────────────────────────────────

const apiKey = process.env.GEMINI_API_KEY;
const projectId = process.env.GCP_PROJECT_ID;
const fileSearchStoreId = process.env.FILE_SEARCH_STORE_ID;
const manifestPath = process.env.DBT_MANIFEST_PATH || './dbt/manifest.json';
const catalogPath = process.env.DBT_CATALOG_PATH || './dbt/catalog.json';
const flashModel = getFlashModel();
const geminiModel = getProModel();
const judgeModel = getJudgeModel();

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

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const runDate = formatDate(new Date());

  console.log(`Benchmark run: ${runDate}`);

  await assertGenerateContentModelsAvailable(apiKey!, [
    flashModel,
    geminiModel,
    judgeModel,
  ]);

  const root = join(process.cwd());
  const corpusPath = join(root, 'benchmarks', 'corpus.json');
  const corpusRaw = await readFile(corpusPath, 'utf-8');
  const corpus = JSON.parse(corpusRaw) as CorpusEntry[];
  const resolvedManifestPath = join(root, manifestPath);
  const resolvedCatalogPath = join(root, catalogPath);
  const manifestExists = await fileExists(resolvedManifestPath);
  const catalogExists = await fileExists(resolvedCatalogPath);
  const inputErrors = validateBenchmarkAcceptanceInputs({
    corpus,
    fileSearchStoreId,
    manifestExists,
    catalogExists,
  });
  if (inputErrors.length > 0) {
    throw new Error(`Benchmark preflight failed:\n${inputErrors.map(error => `- ${error}`).join('\n')}`);
  }

  // Initialize BigQuery for dry-run validation.
  initBigQuery(projectId!);

  // Load local knowledge summaries. Benchmark runs should not require Firestore.
  const knowledgeSummaries: KnowledgeSummary[] = await loadLocalKnowledgeSummaries(root);
  console.log(`Loaded ${knowledgeSummaries.length} local knowledge summaries`);

  // Load dbt artifacts when available.
  let tables: TableContext[] = [];
  let manifestRaw: string | null = null;
  let catalogRaw: string | null = null;
  try {
    manifestRaw = await readFile(resolvedManifestPath, 'utf-8');
    catalogRaw = await readFile(resolvedCatalogPath, 'utf-8');
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

  const knownBenchmarkTables = [
    ...new Set([
      ...tables.map(table => table.name),
      ...corpus.flatMap(entry => entry.expectedTables ?? []),
    ]),
  ];
  console.log(`Corpus: ${corpus.length} questions\n`);
  const packageJson = await readFile(join(root, 'package.json'), 'utf-8');
  const metadata = buildBenchmarkMetadata({
    packageJson,
    corpusRaw,
    manifestRaw,
    catalogRaw,
    gitSha: getGitSha(root),
    gitDirty: getGitDirty(root),
    geminiModel,
    judgeModel,
    fileSearchStoreId: fileSearchStoreId ?? null,
    gcpProjectId: projectId!,
  });

  // Run each question
  const results: BenchmarkResult[] = [];

  for (const entry of corpus) {
    console.log(`[${entry.id}] ${entry.question}`);
    const totalStart = Date.now();
    let observedClarificationConfidence: 'high' | 'medium' | 'low' | undefined;

    try {
      // Step 1: Clarification
      const clarifyStart = Date.now();
      const clarification = await classifyQuestion(
        entry.question,
        [],           // no thread context in benchmark
        knowledgeSummaries,
        apiKey!,
      );
      const clarifyMs = Date.now() - clarifyStart;
      observedClarificationConfidence = clarification.confidence;

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
          validationHistory: [],
          bytesProcessed: null,
          supervisorNotes: 'Skipped: LOW clarification confidence',
          teachingCompliance: teachingComplianceLabel(teachingRetrievalPassed(entry.expectedTeachingIds, [])),
          expectedTeachingIds: entry.expectedTeachingIds,
          observedTeachingIds: [],
          teachingRetrievalPassed: teachingRetrievalPassed(entry.expectedTeachingIds, []),
          expectedReferenceIds: entry.expectedReferenceIds,
          observedReferenceIds: [],
          referenceRetrievalPassed: referenceRetrievalPassed(entry.expectedReferenceIds, []),
          referenceProbeReferenceIds: [],
          sqlGroundingReferenceIds: [],
          referenceProbeCitations: [],
          referenceRetrievalSource: 'none',
          expectedTables: entry.expectedTables,
          observedTables: [],
          tableSelectionPassed: tableSelectionPassed(entry.expectedTables, []),
          expectedSqlContains: entry.expectedSqlContains,
          sqlShapePassed: sqlShapePassed(entry.expectedSqlContains, null),
          expectedClarificationConfidence: entry.expectedClarificationConfidence,
          clarificationPassed: clarificationPassed(
            entry.expectedClarificationConfidence,
            clarification.confidence,
          ),
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

      // Step 2: explicit File Search ReferenceCard probe for benchmark provenance
      const referenceProbe = fileSearchStoreId
        ? await probeReferenceCards({
            question: clarification.resolved_question || entry.question,
            apiKey: apiKey!,
            fileSearchStoreId,
            model: geminiModel,
          })
        : {
            referenceIds: [],
            citations: [],
            error: 'Reference probe skipped: FILE_SEARCH_STORE_ID is missing',
          };
      console.log(
        `  reference probe: ${referenceProbe.referenceIds.length} refs${
          referenceProbe.error ? ' (error recorded)' : ''
        }`,
      );

      // Step 3: Quality loop
      const loopStart = Date.now();
      const quality = await qualityLoop(
        {
          question: clarification.resolved_question || entry.question,
          tables,
          threadContext: [],
          apiKey: apiKey!,
          model: geminiModel,
          fileSearchStoreId,
          bqml_hint: clarification.bqml_hint ?? undefined,
        },
        apiKey!,                        // supervisor uses same API key
        clarification.resolved_question || entry.question,
        MAX_BYTES,
      );
      const loopMs = Date.now() - loopStart;
      const totalMs = Date.now() - totalStart;
      const sqlGroundingReferenceIds = extractReferenceIdsFromCitations(
        quality.sqlResult.groundingCitations,
      );
      const observedReferenceIds = combineReferenceIds(
        referenceProbe.referenceIds,
        sqlGroundingReferenceIds,
      );
      const observedTeachingIds = extractTeachingIdsFromCitations(
        quality.sqlResult.groundingCitations,
      );
      const teachingPassed = teachingRetrievalPassed(entry.expectedTeachingIds, observedTeachingIds);
      const observedTables = extractTablesFromSql(
        quality.sqlResult.sql,
        knownBenchmarkTables,
      );

      const result: BenchmarkResult = {
        corpusId: entry.id,
        question: entry.question,
        generatedSql: quality.sqlResult.sql,
        confidence: quality.finalConfidence,
        qualityVerdict: quality.verdict,
        retryCount: quality.retryCount,
        validationResults: validationResultsFromFailures(
          quality.failureHistory,
          quality.verdict,
          quality.validationHistory,
        ),
        validationHistory: quality.validationHistory ?? [],
        bytesProcessed: quality.bytesProcessed ?? null,
        supervisorNotes: quality.supervisorNotes,
        teachingCompliance: teachingComplianceLabel(teachingPassed),
        expectedTeachingIds: entry.expectedTeachingIds,
        observedTeachingIds,
        teachingRetrievalPassed: teachingPassed,
        expectedReferenceIds: entry.expectedReferenceIds,
        observedReferenceIds,
        referenceRetrievalPassed: referenceRetrievalPassed(
          entry.expectedReferenceIds,
          observedReferenceIds,
        ),
        referenceProbeReferenceIds: referenceProbe.referenceIds,
        sqlGroundingReferenceIds,
        referenceProbeCitations: referenceProbe.citations,
        referenceRetrievalSource: referenceRetrievalSource(
          referenceProbe.referenceIds,
          sqlGroundingReferenceIds,
        ),
        ...(referenceProbe.error ? { referenceProbeError: referenceProbe.error } : {}),
        expectedTables: entry.expectedTables,
        observedTables,
        tableSelectionPassed: tableSelectionPassed(
          entry.expectedTables,
          observedTables,
        ),
        expectedSqlContains: entry.expectedSqlContains,
        sqlShapePassed: sqlShapePassed(entry.expectedSqlContains, quality.sqlResult.sql),
        expectedClarificationConfidence: entry.expectedClarificationConfidence,
        clarificationPassed: clarificationPassed(
          entry.expectedClarificationConfidence,
          clarification.confidence,
        ),
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
        validationHistory: [],
        bytesProcessed: null,
        supervisorNotes: `Error: ${(err as Error).message}`,
        teachingCompliance: teachingComplianceLabel(teachingRetrievalPassed(entry.expectedTeachingIds, [])),
        expectedTeachingIds: entry.expectedTeachingIds,
        observedTeachingIds: [],
        teachingRetrievalPassed: teachingRetrievalPassed(entry.expectedTeachingIds, []),
        expectedReferenceIds: entry.expectedReferenceIds,
        observedReferenceIds: [],
        referenceRetrievalPassed: referenceRetrievalPassed(entry.expectedReferenceIds, []),
        referenceProbeReferenceIds: [],
        sqlGroundingReferenceIds: [],
        referenceProbeCitations: [],
        referenceRetrievalSource: 'none',
        expectedTables: entry.expectedTables,
        observedTables: [],
        tableSelectionPassed: tableSelectionPassed(entry.expectedTables, []),
        expectedSqlContains: entry.expectedSqlContains,
        sqlShapePassed: sqlShapePassed(entry.expectedSqlContains, null),
        expectedClarificationConfidence: entry.expectedClarificationConfidence,
        clarificationPassed: clarificationPassed(
          entry.expectedClarificationConfidence,
          observedClarificationConfidence,
        ),
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
    metadata,
    corpusSize: corpus.length,
    results,
    judgeResults: [],
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
