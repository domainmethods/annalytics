import { access, readFile, mkdir, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { GoogleGenAI } from '@google/genai';
import { initBigQuery } from '../src/validation/dryRun.js';
import { classifyQuestion } from '../src/agents/clarificationAgent.js';
import { qualityLoop } from '../src/qualityLoop.js';
import { parseDbtArtifacts } from '../src/dbt/parser.js';
import type { KnowledgeSummary } from '../src/teachings/types.js';
import type { TableContext } from '../src/dbt/types.js';
import type { CorpusEntry, BenchmarkResult } from './benchmark-types.js';
import { getJudgeModel, resolveModelId, type ModelTier } from '../src/agents/modelConfig.js';
import { resolveNodeModel, defaultTierForNode, type NodeId } from '../src/agents/nodeProfiles.js';
import { withUsageSink, type UsageRecord } from '../src/agents/modelGateway.js';
import { assertGenerateContentModelsAvailable } from './benchmarkPreflight.js';
import { loadLocalKnowledgeSummaries } from './benchmarkInputs.js';
import {
  clarificationPassed,
  sqlShapePassed,
  tableSelectionPassed,
  extractTablesFromSql,
} from './benchmarkSupport.js';
import { judgeSingleResult } from './benchmark-judge-core.js';
import {
  DEFAULT_LADDER,
  type LadderRung,
  type RungScore,
} from './node-sweep-types.js';
import { pickRecommendation } from './node-sweep-decision.js';
import { computeEpsilon } from './node-sweep-calibrate.js';

// ── Env validation ────────────────────────────────────────────────────────────

const apiKey = process.env.GEMINI_API_KEY;
const projectId = process.env.GCP_PROJECT_ID;
const fileSearchStoreId = process.env.FILE_SEARCH_STORE_ID;
const manifestPath = process.env.DBT_MANIFEST_PATH || './dbt/manifest.json';
const catalogPath = process.env.DBT_CATALOG_PATH || './dbt/catalog.json';
const judgeModel = getJudgeModel();

if (!apiKey || !projectId) {
  const missing = [
    !apiKey && 'GEMINI_API_KEY',
    !projectId && 'GCP_PROJECT_ID',
  ].filter(Boolean).join(', ');
  console.error(`Error: Missing required environment variable(s): ${missing}`);
  process.exit(1);
}

const MAX_BYTES = 1 * 1024 * 1024 * 1024; // 1 GB cost gate, mirrors benchmark.ts

// Relative per-token cost weights — UPDATE from live billing before trusting
// absolute cost. Only the RATIO across tiers matters for the decision rule's
// cost tie-break.
const TIER_PRICES: Record<ModelTier, number> = {
  'flash-lite': 0.0000001,
  'flash': 0.0000003,
  'pro': 0.000002,
};

const DEFAULT_SWEEP_NODES: NodeId[] = ['clarification', 'sqlGenerator', 'supervisor'];

// ── Arg parsing ─────────────────────────────────────────────────────────────

interface SweepArgs {
  nodes: NodeId[];
  version?: string;
  corpus: string;
}

function parseArgs(argv: string[]): SweepArgs {
  const nodes: NodeId[] = [];
  let version: string | undefined;
  let corpus = 'benchmarks/corpus.json';

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--node') {
      const value = argv[++i];
      if (value) nodes.push(value as NodeId);
    } else if (arg === '--version') {
      version = argv[++i];
    } else if (arg === '--corpus') {
      corpus = argv[++i] ?? corpus;
    }
  }

  return {
    nodes: nodes.length > 0 ? nodes : [...DEFAULT_SWEEP_NODES],
    version,
    corpus,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Build the per-node ladder. If `version` is supplied, every rung's version is
 * replaced with it and rungs whose (tier, version) pair has no resolvable model
 * are dropped. Without `version`, each rung keeps its own version.
 */
function buildLadder(version?: string): LadderRung[] {
  if (!version) return [...DEFAULT_LADDER];
  const out: LadderRung[] = [];
  for (const rung of DEFAULT_LADDER) {
    try {
      resolveModelId(rung.tier, version);
      out.push({ ...rung, version });
    } catch {
      // (tier, version) pair has no model — drop this rung.
    }
  }
  return out;
}

function p95(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.ceil(0.95 * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/**
 * Build a BenchmarkResult sufficient for the judge. Only the fields
 * buildJudgePrompt reads are meaningful; the rest are filled with safe defaults
 * so the object satisfies the BenchmarkResult type.
 */
function buildResult(
  entry: CorpusEntry,
  generatedSql: string | null,
  fields: {
    confidence: 'high' | 'medium' | 'low';
    qualityVerdict: BenchmarkResult['qualityVerdict'];
    retryCount: number;
    supervisorNotes: string;
    bytesProcessed: number | null;
    observedTables: string[];
  },
): BenchmarkResult {
  return {
    corpusId: entry.id,
    question: entry.question,
    generatedSql,
    confidence: fields.confidence,
    qualityVerdict: fields.qualityVerdict,
    retryCount: fields.retryCount,
    validationResults: { l1: false, l2: false, l3: false, l4: false },
    bytesProcessed: fields.bytesProcessed,
    supervisorNotes: fields.supervisorNotes,
    teachingCompliance: 'no_relevant_teaching',
    observedReferenceIds: [],
    referenceRetrievalPassed: null,
    expectedTables: entry.expectedTables,
    observedTables: fields.observedTables,
    tableSelectionPassed: tableSelectionPassed(entry.expectedTables, fields.observedTables),
    expectedSqlContains: entry.expectedSqlContains,
    sqlShapePassed: sqlShapePassed(entry.expectedSqlContains, generatedSql),
    expectedClarificationConfidence: entry.expectedClarificationConfidence,
    clarificationPassed: null,
    latencyMs: { clarification: 0, generation: 0, validation: 0, supervisor: 0, total: 0 },
    groundingCitations: [],
  };
}

interface PerEntry {
  id: string;
  clarificationPassed: boolean;
  sqlGenMetric: number;
  overallScore: number;
}

interface CorpusRunResult {
  perEntry: PerEntry[];
  nodeUsage: Map<NodeId, { latencies: number[]; tokens: number }>;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const runDate = formatDate(new Date());
  const args = parseArgs(process.argv.slice(2));

  console.log(`Node sweep run: ${runDate}`);
  console.log(`Sweeping nodes: ${args.nodes.join(', ')}`);
  if (args.version) console.log(`Global version override: ${args.version}`);

  const ai = new GoogleGenAI({ apiKey: apiKey! });
  const root = join(process.cwd());

  // Build per-node ladders up front (same ladder shape per node).
  const ladder = buildLadder(args.version);
  if (ladder.length === 0) {
    throw new Error(`No ladder rungs survive --version ${args.version}: no (tier, version) pair resolves to a model`);
  }
  console.log(`Ladder: ${ladder.map(r => `${r.rung}(${r.tier}/${r.version})`).join(', ')}`);

  // Preflight: resolve every kept rung's model id plus each node's baseline model.
  const rungModelIds = ladder.map(rung => resolveModelId(rung.tier, rung.version));
  const baselineModelIds = args.nodes.map(node => resolveNodeModel(node));
  const requiredModels = [...new Set([judgeModel, ...rungModelIds, ...baselineModelIds])];
  await assertGenerateContentModelsAvailable(apiKey!, requiredModels);

  // Initialize BigQuery for dry-run validation.
  initBigQuery(projectId!);

  // Load corpus.
  const corpusPath = join(root, args.corpus);
  const corpusRaw = await readFile(corpusPath, 'utf-8');
  const corpus = JSON.parse(corpusRaw) as CorpusEntry[];
  console.log(`Corpus: ${corpus.length} questions`);

  // Load local knowledge summaries (no Firestore dependency).
  const knowledgeSummaries: KnowledgeSummary[] = await loadLocalKnowledgeSummaries(root);
  console.log(`Loaded ${knowledgeSummaries.length} local knowledge summaries`);

  // Load dbt artifacts when available (tolerate missing — empty tables[]).
  const resolvedManifestPath = join(root, manifestPath);
  const resolvedCatalogPath = join(root, catalogPath);
  let tables: TableContext[] = [];
  if (await fileExists(resolvedManifestPath) && await fileExists(resolvedCatalogPath)) {
    try {
      const manifestRaw = await readFile(resolvedManifestPath, 'utf-8');
      const catalogRaw = await readFile(resolvedCatalogPath, 'utf-8');
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
  } else {
    console.warn('Warning: dbt artifacts not found. Running without schema context.');
  }

  const knownBenchmarkTables = [
    ...new Set([
      ...tables.map(table => table.name),
      ...corpus.flatMap(entry => entry.expectedTables ?? []),
    ]),
  ];

  const corpusMap = new Map<string, CorpusEntry>(corpus.map(e => [e.id, e]));

  // ── One full pass over the corpus ────────────────────────────────────────────

  async function runCorpusOnce(): Promise<CorpusRunResult> {
    const perEntry: PerEntry[] = [];
    const nodeUsage = new Map<NodeId, { latencies: number[]; tokens: number }>();

    const sink = (r: UsageRecord) => {
      let bucket = nodeUsage.get(r.nodeId);
      if (!bucket) {
        bucket = { latencies: [], tokens: 0 };
        nodeUsage.set(r.nodeId, bucket);
      }
      bucket.latencies.push(r.latencyMs);
      bucket.tokens += r.promptTokens + r.candidatesTokens + r.thoughtsTokens;
    };

    await withUsageSink(sink, async () => {
      for (const entry of corpus) {
        let result: BenchmarkResult;
        try {
          const clarification = await classifyQuestion(
            entry.question,
            [],
            knowledgeSummaries,
            apiKey!,
          );

          const clarifyPassed = clarificationPassed(
            entry.expectedClarificationConfidence,
            clarification.confidence,
          );

          if (clarification.confidence === 'low') {
            // Record clarification metric, skip the quality loop, but STILL
            // judge (generatedSql=null → judge scores low) for an overallScore.
            result = buildResult(entry, null, {
              confidence: 'low',
              qualityVerdict: 'exhausted',
              retryCount: 0,
              supervisorNotes: 'Skipped: LOW clarification confidence',
              bytesProcessed: null,
              observedTables: [],
            });
          } else {
            const resolved = clarification.resolved_question || entry.question;
            const quality = await qualityLoop(
              {
                question: resolved,
                tables,
                threadContext: [],
                apiKey: apiKey!,
                fileSearchStoreId,
                bqml_hint: clarification.bqml_hint ?? undefined,
              },
              apiKey!,
              resolved,
              MAX_BYTES,
            );
            const observedTables = extractTablesFromSql(
              quality.sqlResult.sql,
              knownBenchmarkTables,
            );
            result = buildResult(entry, quality.sqlResult.sql, {
              confidence: quality.finalConfidence,
              qualityVerdict: quality.verdict,
              retryCount: quality.retryCount,
              supervisorNotes: quality.supervisorNotes,
              bytesProcessed: quality.bytesProcessed ?? null,
              observedTables,
            });
          }

          // Judge every entry (including LOW-confidence skips).
          const judge = await judgeSingleResult(ai, entry, result, judgeModel);

          const tableSel = tableSelectionPassed(entry.expectedTables, result.observedTables);
          const sqlShape = sqlShapePassed(entry.expectedSqlContains, result.generatedSql);
          const sqlGenMetric = mean([
            tableSel ? 1 : 0,
            sqlShape ? 1 : 0,
            // Normalize 1–5 judge correctness to 0..1 (the plan said "/10"; that
            // is WRONG — the judge scores correctness on a 1–5 scale).
            judge.scores.correctness / 5,
          ]);

          perEntry.push({
            id: entry.id,
            clarificationPassed: clarifyPassed === true,
            sqlGenMetric,
            overallScore: judge.overallScore,
          });
        } catch (err) {
          console.error(`  [${entry.id}] ERROR: ${(err as Error).message}`);
          // Record a zeroed entry so id-alignment stays stable across runs.
          perEntry.push({
            id: entry.id,
            clarificationPassed: false,
            sqlGenMetric: 0,
            overallScore: 1,
          });
        }
      }
    });

    return { perEntry, nodeUsage };
  }

  // ── Per-entry metric helpers ──────────────────────────────────────────────────

  function nodeMetric(nodeId: NodeId, perEntry: PerEntry[]): number {
    if (nodeId === 'clarification') {
      return mean(perEntry.map(e => (e.clarificationPassed ? 1 : 0)));
    }
    if (nodeId === 'sqlGenerator') {
      return mean(perEntry.map(e => e.sqlGenMetric));
    }
    // supervisor and any other node: end-to-end overallScore proxy.
    return mean(perEntry.map(e => e.overallScore));
  }

  function perEntryNodeMetric(nodeId: NodeId, e: PerEntry): number {
    if (nodeId === 'clarification') return e.clarificationPassed ? 1 : 0;
    if (nodeId === 'sqlGenerator') return e.sqlGenMetric;
    return e.overallScore;
  }

  function e2e(perEntry: PerEntry[]): number {
    return mean(perEntry.map(e => e.overallScore));
  }

  function nodeP95(nodeId: NodeId, nodeUsage: CorpusRunResult['nodeUsage']): number {
    return p95(nodeUsage.get(nodeId)?.latencies ?? []);
  }

  function nodeCost(nodeId: NodeId, tier: ModelTier, nodeUsage: CorpusRunResult['nodeUsage']): number {
    const tokens = nodeUsage.get(nodeId)?.tokens ?? 0;
    return tokens * TIER_PRICES[tier];
  }

  // Align two runs by sorted intersection of ids, reading values in that order.
  function alignById(
    runA: PerEntry[],
    runB: PerEntry[],
    read: (e: PerEntry) => number,
  ): { a: number[]; b: number[] } {
    const mapA = new Map(runA.map(e => [e.id, e]));
    const mapB = new Map(runB.map(e => [e.id, e]));
    const ids = [...mapA.keys()].filter(id => mapB.has(id)).sort();
    return {
      a: ids.map(id => read(mapA.get(id)!)),
      b: ids.map(id => read(mapB.get(id)!)),
    };
  }

  // ── ε calibration: two baseline runs ──────────────────────────────────────────

  console.log('\nCalibration: running corpus twice at baseline...');
  const baselineRunA = await runCorpusOnce();
  const baselineRunB = await runCorpusOnce();

  // ── Per-node coordinate descent ───────────────────────────────────────────────

  interface NodeOutcome {
    nodeId: NodeId;
    baseline: RungScore;
    chosen: RungScore;
    candidates: RungScore[];
    chosenRung?: LadderRung;
    e2eCritical: boolean;
  }

  const baselineE2e = e2e(baselineRunA.perEntry);
  const outcomes: NodeOutcome[] = [];

  for (const node of args.nodes) {
    console.log(`\n── Node: ${node} ──`);

    // ε is node-specific: metric series uses this node's per-entry metric.
    const metricAligned = alignById(
      baselineRunA.perEntry,
      baselineRunB.perEntry,
      e => perEntryNodeMetric(node, e),
    );
    const e2eAligned = alignById(
      baselineRunA.perEntry,
      baselineRunB.perEntry,
      e => e.overallScore,
    );
    const metricEps = computeEpsilon(metricAligned.a, metricAligned.b);
    const e2eEps = computeEpsilon(e2eAligned.a, e2eAligned.b);
    console.log(`  ε(metric)=${metricEps.toFixed(4)}  ε(e2e)=${e2eEps.toFixed(4)}`);

    const baseline: RungScore = {
      rung: 'DEFAULT',
      metric: nodeMetric(node, baselineRunA.perEntry),
      e2e: e2e(baselineRunA.perEntry),
      p95LatencyMs: nodeP95(node, baselineRunA.nodeUsage),
      cost: nodeCost(node, defaultTierForNode(node), baselineRunA.nodeUsage),
    };

    const rungScores: RungScore[] = [];
    const rungByName = new Map<string, LadderRung>();

    for (const rung of ladder) {
      rungByName.set(rung.rung, rung);
      const prev = process.env.NODE_PROFILE_OVERRIDES;
      process.env.NODE_PROFILE_OVERRIDES = JSON.stringify({
        [node]: { tier: rung.tier, version: rung.version, thinkingLevel: rung.thinkingLevel },
      });
      try {
        const run = await runCorpusOnce();
        rungScores.push({
          rung: rung.rung,
          metric: nodeMetric(node, run.perEntry),
          e2e: e2e(run.perEntry),
          p95LatencyMs: nodeP95(node, run.nodeUsage),
          cost: nodeCost(node, rung.tier, run.nodeUsage),
        });
        console.log(`  ${rung.rung} (${rung.tier}/${rung.version}): metric=${rungScores[rungScores.length - 1].metric.toFixed(3)}`);
      } catch (err) {
        console.error(`  ${rung.rung}: run threw (${(err as Error).message}); recording metric=0`);
        rungScores.push({
          rung: rung.rung,
          metric: 0,
          e2e: 0,
          p95LatencyMs: 0,
          cost: 0,
        });
      } finally {
        if (prev === undefined) delete process.env.NODE_PROFILE_OVERRIDES;
        else process.env.NODE_PROFILE_OVERRIDES = prev;
      }
    }

    const candidates = [baseline, ...rungScores];
    const chosen = pickRecommendation(baseline, candidates, metricEps, e2eEps);
    console.log(`  → chosen: ${chosen.rung}`);

    outcomes.push({
      nodeId: node,
      baseline,
      chosen,
      candidates,
      chosenRung: chosen.rung === 'DEFAULT' ? undefined : rungByName.get(chosen.rung),
      // A node whose metric proxy IS the e2e score is e2e-critical (supervisor
      // and any non-clarification/non-sqlGenerator node).
      e2eCritical: node !== 'clarification' && node !== 'sqlGenerator',
    });
  }

  // ── Combined verification pass ────────────────────────────────────────────────

  // Use the node-specific metric ε for combined-pass margin math; for the e2e
  // gate use the e2e ε from the last node's calibration (id-aligned, baseline).
  const e2eEpsAligned = alignById(
    baselineRunA.perEntry,
    baselineRunB.perEntry,
    e => e.overallScore,
  );
  const e2eEps = computeEpsilon(e2eEpsAligned.a, e2eEpsAligned.b);

  function metricEpsForNode(node: NodeId): number {
    const aligned = alignById(
      baselineRunA.perEntry,
      baselineRunB.perEntry,
      e => perEntryNodeMetric(node, e),
    );
    return computeEpsilon(aligned.a, aligned.b);
  }

  function buildCombinedOverrides(nodes: NodeOutcome[]): Record<string, unknown> {
    const overrides: Record<string, unknown> = {};
    for (const o of nodes) {
      if (o.chosenRung) {
        overrides[o.nodeId] = {
          tier: o.chosenRung.tier,
          version: o.chosenRung.version,
          thinkingLevel: o.chosenRung.thinkingLevel,
        };
      }
    }
    return overrides;
  }

  async function runCombined(downsized: NodeOutcome[]): Promise<number> {
    const overrides = buildCombinedOverrides(downsized);
    const prev = process.env.NODE_PROFILE_OVERRIDES;
    process.env.NODE_PROFILE_OVERRIDES = JSON.stringify(overrides);
    try {
      const run = await runCorpusOnce();
      return e2e(run.perEntry);
    } finally {
      if (prev === undefined) delete process.env.NODE_PROFILE_OVERRIDES;
      else process.env.NODE_PROFILE_OVERRIDES = prev;
    }
  }

  console.log('\n── Combined verification pass ──');
  let downsized = outcomes.filter(o => o.chosenRung);
  let combinedE2e = baselineE2e;
  let manualReview = false;

  if (downsized.length === 0) {
    console.log('No nodes downsized; combined pass uses baseline.');
  } else {
    combinedE2e = await runCombined(downsized);
    console.log(`Combined e2e: ${combinedE2e.toFixed(3)} (baseline ${baselineE2e.toFixed(3)}, ε ${e2eEps.toFixed(4)})`);

    if (combinedE2e < baselineE2e - e2eEps) {
      // Revert the node with the smallest margin first. Normalize each node's
      // raw headroom by its own metric ε so margins are in noise-band units —
      // node metrics live on different scales (clarification/sqlGenerator pass-rate
      // ∈ [0,1] vs supervisor e2e overallScore ∈ ~[1,5]), so comparing raw margins
      // would systematically bias the revert toward the narrower-scale node.
      // ε is floored at 0.01 by computeEpsilon, so the division is always safe.
      const withMargin = downsized.map(o => {
        const eps = metricEpsForNode(o.nodeId);
        return {
          outcome: o,
          margin: (o.chosen.metric - (o.baseline.metric - eps)) / eps,
        };
      });
      withMargin.sort((a, b) => a.margin - b.margin);
      const toRevert = withMargin[0].outcome;
      console.log(`Combined regressed; reverting smallest-margin node ${toRevert.nodeId} to DEFAULT`);
      toRevert.chosenRung = undefined;
      toRevert.chosen = toRevert.baseline;
      downsized = outcomes.filter(o => o.chosenRung);

      combinedE2e = downsized.length > 0 ? await runCombined(downsized) : baselineE2e;
      console.log(`Combined e2e after revert: ${combinedE2e.toFixed(3)}`);

      if (combinedE2e < baselineE2e - e2eEps) {
        // Revert ALL e2e-critical nodes and flag for manual review.
        manualReview = true;
        for (const o of outcomes) {
          if (o.e2eCritical && o.chosenRung) {
            console.log(`Combined still regressed; reverting e2e-critical node ${o.nodeId} to DEFAULT`);
            o.chosenRung = undefined;
            o.chosen = o.baseline;
          }
        }
        downsized = outcomes.filter(o => o.chosenRung);
        combinedE2e = downsized.length > 0 ? await runCombined(downsized) : baselineE2e;
        console.log(`Combined e2e after e2e-critical revert: ${combinedE2e.toFixed(3)} [FLAGGED FOR MANUAL REVIEW]`);
      }
    }
  }

  // ── Report ────────────────────────────────────────────────────────────────────

  const reportLines: string[] = [];
  reportLines.push(`# Node Sweep — ${runDate}`);
  reportLines.push('');
  reportLines.push(`- Swept nodes: ${args.nodes.join(', ')}`);
  if (args.version) reportLines.push(`- Global version override: ${args.version}`);
  reportLines.push(`- Corpus: ${args.corpus} (${corpus.length} questions)`);
  reportLines.push(`- Baseline e2e: ${baselineE2e.toFixed(3)}`);
  reportLines.push(`- Combined e2e: ${combinedE2e.toFixed(3)}`);
  reportLines.push(`- ε(e2e): ${e2eEps.toFixed(4)}`);
  reportLines.push('');

  for (const o of outcomes) {
    const metricEps = metricEpsForNode(o.nodeId);
    reportLines.push(`## ${o.nodeId}`);
    reportLines.push(`ε(metric): ${metricEps.toFixed(4)}`);
    reportLines.push('');
    reportLines.push('| rung | model | metric | p95ms | cost | recommended |');
    reportLines.push('|------|-------|--------|-------|------|-------------|');
    for (const c of o.candidates) {
      const model = c.rung === 'DEFAULT'
        ? resolveNodeModel(o.nodeId)
        : (() => {
            const r = ladder.find(l => l.rung === c.rung);
            return r ? resolveModelId(r.tier, r.version) : c.rung;
          })();
      const rec = c.rung === o.chosen.rung ? '✓' : '';
      reportLines.push(`| ${c.rung} | ${model} | ${c.metric.toFixed(3)} | ${c.p95LatencyMs} | ${c.cost.toExponential(2)} | ${rec} |`);
    }
    reportLines.push('');
  }

  reportLines.push('## Combined verdict');
  reportLines.push('');
  const verdict = manualReview
    ? 'REGRESSED — e2e-critical nodes reverted, FLAGGED FOR MANUAL REVIEW'
    : combinedE2e >= baselineE2e - e2eEps
      ? 'ACCEPTED — combined downsizing holds within ε'
      : 'REGRESSED';
  reportLines.push(`- Verdict: ${verdict}`);
  reportLines.push(`- Final downsized nodes: ${outcomes.filter(o => o.chosenRung).map(o => `${o.nodeId}→${o.chosen.rung}`).join(', ') || 'none'}`);
  reportLines.push('');

  const resultsDir = join(root, 'benchmarks', 'results');
  await mkdir(resultsDir, { recursive: true });
  const outputPath = join(resultsDir, `node-sweep-${runDate}.md`);
  await writeFile(outputPath, reportLines.join('\n'), 'utf-8');
  console.log(`\nReport written to benchmarks/results/node-sweep-${runDate}.md`);
}

main().then(() => {
  process.exit(0);
}).catch(err => {
  console.error('Node sweep failed:', err);
  process.exit(1);
});
