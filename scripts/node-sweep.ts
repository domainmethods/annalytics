import { access, readFile, mkdir, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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

// NB: env reads + validation live inside main() (not module scope) so importing
// this module for the orchestration test harness never triggers process.exit.

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

export interface PerEntry {
  id: string;
  clarificationPassed: boolean;
  sqlGenMetric: number;
  overallScore: number;
}

export interface CorpusRunResult {
  perEntry: PerEntry[];
  nodeUsage: Map<NodeId, { latencies: number[]; tokens: number }>;
}

// ── Orchestration (IO-free; injectable runCorpusOnce) ──────────────────────────

export interface NodeOutcome {
  nodeId: NodeId;
  baseline: RungScore;
  chosen: RungScore;
  candidates: RungScore[];
  chosenRung?: LadderRung;
  e2eCritical: boolean;
}

export interface SweepConfig {
  nodes: NodeId[];
  version?: string;
  ladder: LadderRung[];
  corpusCount: number;
  corpusLabel: string;
  runDate: string;
  /** The single Gemini/BigQuery-touching seam. Each call is one full corpus pass
   *  under whatever NODE_PROFILE_OVERRIDES is currently set in process.env. */
  runCorpusOnce: () => Promise<CorpusRunResult>;
  /** Progress logger; defaults to console.log. Pass a no-op to silence. */
  log?: (msg: string) => void;
}

export interface SweepResult {
  report: string;
  outcomes: NodeOutcome[];
  baselineE2e: number;
  combinedE2e: number;
  e2eEps: number;
  manualReview: boolean;
}

// ── Per-entry metric helpers (pure over a CorpusRunResult) ─────────────────────

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

function e2eOf(perEntry: PerEntry[]): number {
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

/**
 * Coordinate-descent orchestration: ε calibration → per-node ladder sweep →
 * combined verification pass with margin-ordered revert → markdown report.
 * Pure of all IO except the injected `runCorpusOnce`, which is the only seam that
 * touches Gemini/BigQuery. The per-rung loop mutates `process.env.NODE_PROFILE_OVERRIDES`
 * and always restores it (try/finally), so a caller's env is left untouched.
 */
export async function runSweep(cfg: SweepConfig): Promise<SweepResult> {
  const { nodes, version, ladder, corpusCount, corpusLabel, runDate, runCorpusOnce } = cfg;
  const log = cfg.log ?? ((m: string) => console.log(m));

  // ── ε calibration: two baseline runs ─────────────────────────────────────────
  log('\nCalibration: running corpus twice at baseline...');
  const baselineRunA = await runCorpusOnce();
  const baselineRunB = await runCorpusOnce();

  const metricEpsForNode = (node: NodeId): number => {
    const aligned = alignById(baselineRunA.perEntry, baselineRunB.perEntry, e => perEntryNodeMetric(node, e));
    return computeEpsilon(aligned.a, aligned.b);
  };
  // e2e ε is node-independent (always the overallScore series).
  const e2eAligned = alignById(baselineRunA.perEntry, baselineRunB.perEntry, e => e.overallScore);
  const e2eEps = computeEpsilon(e2eAligned.a, e2eAligned.b);

  const baselineE2e = e2eOf(baselineRunA.perEntry);
  const outcomes: NodeOutcome[] = [];

  // ── Per-node coordinate descent ──────────────────────────────────────────────
  for (const node of nodes) {
    log(`\n── Node: ${node} ──`);
    const metricEps = metricEpsForNode(node);
    log(`  ε(metric)=${metricEps.toFixed(4)}  ε(e2e)=${e2eEps.toFixed(4)}`);

    const baseline: RungScore = {
      rung: 'DEFAULT',
      metric: nodeMetric(node, baselineRunA.perEntry),
      e2e: e2eOf(baselineRunA.perEntry),
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
          e2e: e2eOf(run.perEntry),
          p95LatencyMs: nodeP95(node, run.nodeUsage),
          cost: nodeCost(node, rung.tier, run.nodeUsage),
        });
        log(`  ${rung.rung} (${rung.tier}/${rung.version}): metric=${rungScores[rungScores.length - 1].metric.toFixed(3)}`);
      } catch (err) {
        log(`  ${rung.rung}: run threw (${(err as Error).message}); recording metric=0`);
        rungScores.push({ rung: rung.rung, metric: 0, e2e: 0, p95LatencyMs: 0, cost: 0 });
      } finally {
        if (prev === undefined) delete process.env.NODE_PROFILE_OVERRIDES;
        else process.env.NODE_PROFILE_OVERRIDES = prev;
      }
    }

    const candidates = [baseline, ...rungScores];
    const chosen = pickRecommendation(baseline, candidates, metricEps, e2eEps);
    log(`  → chosen: ${chosen.rung}`);

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

  // ── Combined verification pass ───────────────────────────────────────────────
  function buildCombinedOverrides(ns: NodeOutcome[]): Record<string, unknown> {
    const overrides: Record<string, unknown> = {};
    for (const o of ns) {
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

  async function runCombined(ns: NodeOutcome[]): Promise<number> {
    const overrides = buildCombinedOverrides(ns);
    const prev = process.env.NODE_PROFILE_OVERRIDES;
    process.env.NODE_PROFILE_OVERRIDES = JSON.stringify(overrides);
    try {
      const run = await runCorpusOnce();
      return e2eOf(run.perEntry);
    } finally {
      if (prev === undefined) delete process.env.NODE_PROFILE_OVERRIDES;
      else process.env.NODE_PROFILE_OVERRIDES = prev;
    }
  }

  log('\n── Combined verification pass ──');
  let downsized = outcomes.filter(o => o.chosenRung);
  let combinedE2e = baselineE2e;
  let manualReview = false;

  if (downsized.length === 0) {
    log('No nodes downsized; combined pass uses baseline.');
  } else {
    combinedE2e = await runCombined(downsized);
    log(`Combined e2e: ${combinedE2e.toFixed(3)} (baseline ${baselineE2e.toFixed(3)}, ε ${e2eEps.toFixed(4)})`);

    if (combinedE2e < baselineE2e - e2eEps) {
      // Revert the most-recoverable node first. A combined-pass regression is by
      // construction an e2e (overallScore) regression, so it can only be cured by
      // reverting a node whose quality is observed THROUGH e2e — i.e. an e2e-critical
      // node. A non-e2e-critical node (clarification/sqlGenerator) already cleared its
      // OWN dedicated gate-metric within ε; reverting it cannot recover an e2e
      // regression and merely wastes a revert cycle, escalating to manual review
      // prematurely. So order e2e-critical nodes ahead of non-critical ones, then by
      // smallest margin within each group.
      //
      // Margin normalizes each node's raw headroom by its own metric ε so margins are
      // in noise-band units — node metrics live on different scales (clarification/
      // sqlGenerator pass-rate ∈ [0,1] vs supervisor e2e overallScore ∈ ~[1,5]), so
      // comparing raw margins would bias the revert toward the narrower-scale node.
      // ε is floored at 0.01 by computeEpsilon, so the division is always safe.
      const withMargin = downsized.map(o => {
        const eps = metricEpsForNode(o.nodeId);
        return { outcome: o, margin: (o.chosen.metric - (o.baseline.metric - eps)) / eps };
      });
      withMargin.sort((a, b) =>
        (Number(b.outcome.e2eCritical) - Number(a.outcome.e2eCritical)) || (a.margin - b.margin),
      );
      const toRevert = withMargin[0].outcome;
      log(`Combined regressed; reverting smallest-margin node ${toRevert.nodeId} to DEFAULT`);
      toRevert.chosenRung = undefined;
      toRevert.chosen = toRevert.baseline;
      downsized = outcomes.filter(o => o.chosenRung);

      combinedE2e = downsized.length > 0 ? await runCombined(downsized) : baselineE2e;
      log(`Combined e2e after revert: ${combinedE2e.toFixed(3)}`);

      if (combinedE2e < baselineE2e - e2eEps) {
        // Revert ALL e2e-critical nodes and flag for manual review.
        manualReview = true;
        for (const o of outcomes) {
          if (o.e2eCritical && o.chosenRung) {
            log(`Combined still regressed; reverting e2e-critical node ${o.nodeId} to DEFAULT`);
            o.chosenRung = undefined;
            o.chosen = o.baseline;
          }
        }
        downsized = outcomes.filter(o => o.chosenRung);
        combinedE2e = downsized.length > 0 ? await runCombined(downsized) : baselineE2e;
        log(`Combined e2e after e2e-critical revert: ${combinedE2e.toFixed(3)} [FLAGGED FOR MANUAL REVIEW]`);
      }
    }
  }

  // ── Report ───────────────────────────────────────────────────────────────────
  const reportLines: string[] = [];
  reportLines.push(`# Node Sweep — ${runDate}`);
  reportLines.push('');
  reportLines.push(`- Swept nodes: ${nodes.join(', ')}`);
  if (version) reportLines.push(`- Global version override: ${version}`);
  reportLines.push(`- Corpus: ${corpusLabel} (${corpusCount} questions)`);
  reportLines.push(`- Baseline e2e: ${baselineE2e.toFixed(3)}`);
  reportLines.push(`- Combined e2e: ${combinedE2e.toFixed(3)}`);
  reportLines.push(`- ε(e2e): ${e2eEps.toFixed(4)}`);
  reportLines.push('');

  for (const o of outcomes) {
    reportLines.push(`## ${o.nodeId}`);
    reportLines.push(`ε(metric): ${metricEpsForNode(o.nodeId).toFixed(4)}`);
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

  return {
    report: reportLines.join('\n'),
    outcomes,
    baselineE2e,
    combinedE2e,
    e2eEps,
    manualReview,
  };
}

// ── Main (IO shell: env + corpus/dbt load + real runCorpusOnce + file write) ───

async function main() {
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

  const runDate = formatDate(new Date());
  const args = parseArgs(process.argv.slice(2));

  console.log(`Node sweep run: ${runDate}`);
  console.log(`Sweeping nodes: ${args.nodes.join(', ')}`);
  if (args.version) console.log(`Global version override: ${args.version}`);

  const ai = new GoogleGenAI({ apiKey });
  const root = join(process.cwd());

  const ladder = buildLadder(args.version);
  if (ladder.length === 0) {
    throw new Error(`No ladder rungs survive --version ${args.version}: no (tier, version) pair resolves to a model`);
  }
  console.log(`Ladder: ${ladder.map(r => `${r.rung}(${r.tier}/${r.version})`).join(', ')}`);

  // Preflight: resolve every kept rung's model id plus each node's baseline model.
  const rungModelIds = ladder.map(rung => resolveModelId(rung.tier, rung.version));
  const baselineModelIds = args.nodes.map(node => resolveNodeModel(node));
  const requiredModels = [...new Set([judgeModel, ...rungModelIds, ...baselineModelIds])];
  await assertGenerateContentModelsAvailable(apiKey, requiredModels);

  initBigQuery(projectId);

  const corpusPath = join(root, args.corpus);
  const corpusRaw = await readFile(corpusPath, 'utf-8');
  const corpus = JSON.parse(corpusRaw) as CorpusEntry[];
  console.log(`Corpus: ${corpus.length} questions`);

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

  // The real corpus pass: classify → quality loop → judge, with per-node telemetry.
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
          const clarification = await classifyQuestion(entry.question, [], knowledgeSummaries, apiKey);
          const clarifyPassed = clarificationPassed(entry.expectedClarificationConfidence, clarification.confidence);

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
                apiKey,
                fileSearchStoreId,
                bqml_hint: clarification.bqml_hint ?? undefined,
              },
              apiKey,
              resolved,
              MAX_BYTES,
            );
            const observedTables = extractTablesFromSql(quality.sqlResult.sql, knownBenchmarkTables);
            result = buildResult(entry, quality.sqlResult.sql, {
              confidence: quality.finalConfidence,
              qualityVerdict: quality.verdict,
              retryCount: quality.retryCount,
              supervisorNotes: quality.supervisorNotes,
              bytesProcessed: quality.bytesProcessed ?? null,
              observedTables,
            });
          }

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
          perEntry.push({ id: entry.id, clarificationPassed: false, sqlGenMetric: 0, overallScore: 1 });
        }
      }
    });

    return { perEntry, nodeUsage };
  }

  const { report } = await runSweep({
    nodes: args.nodes,
    version: args.version,
    ladder,
    corpusCount: corpus.length,
    corpusLabel: args.corpus,
    runDate,
    runCorpusOnce,
  });

  const resultsDir = join(root, 'benchmarks', 'results');
  await mkdir(resultsDir, { recursive: true });
  const outputPath = join(resultsDir, `node-sweep-${runDate}.md`);
  await writeFile(outputPath, report, 'utf-8');
  console.log(`\nReport written to benchmarks/results/node-sweep-${runDate}.md`);
}

// Only self-execute when invoked directly (tsx scripts/node-sweep.ts), never on import.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().then(() => {
    process.exit(0);
  }).catch(err => {
    console.error('Node sweep failed:', err);
    process.exit(1);
  });
}
