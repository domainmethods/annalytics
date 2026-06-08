import { access, readFile, mkdir, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, resolve, isAbsolute } from 'node:path';
import { GoogleGenAI } from '@google/genai';
import { initBigQuery } from '../src/validation/dryRun.js';
import { classifyQuestion } from '../src/agents/clarificationAgent.js';
import { qualityLoop } from '../src/qualityLoop.js';
import { parseDbtArtifacts } from '../src/dbt/parser.js';
import type { KnowledgeSummary } from '../src/teachings/types.js';
import type { TableContext } from '../src/dbt/types.js';
import type { CorpusEntry, BenchmarkResult } from './benchmark-types.js';
import { getJudgeModel, resolveModelId, listGemini3xModels, type ModelTier } from '../src/agents/modelConfig.js';
import {
  resolveNodeModel,
  defaultTierForNode,
  defaultProfileForNode,
  isNodeId,
  NODE_IDS,
  type NodeId,
  type ThinkingLevel,
} from '../src/agents/nodeProfiles.js';
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
import { type SweepProfile, type PointScore } from './node-sweep-types.js';
import { pickWithinEpsilon } from './node-sweep-decision.js';
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

// ── Two-stage coordinate isolation ────────────────────────────────────────────
//
// The old design swept a single hand-authored "diagonal ladder" that (a) covered
// only 3 of the 4 Gemini 3.x models and (b) changed model AND thinking level at
// each step, so a quality move could never be attributed to one axis. This sweep
// separates the two axes:
//
//   Stage 1 (MODEL axis): hold thinking at a fixed anchor, evaluate ALL models
//     (listGemini3xModels — the registry, not a hand list), pick the cheapest
//     within ε of the best.
//   Stage 2 (THINKING axis): hold the winning model fixed, walk every thinking
//     level (incl. `default`), pick the fastest within ε of the best.
//
// The anchor is `high` on purpose: give every model ample reasoning budget in
// Stage 1 so the model comparison reflects each one's best-case capability (we
// don't want a cheap model to look adequate only because nobody was allowed to
// think). Stage 2 then trims thinking down to the cheapest level the WINNER still
// needs. Capability-first, cost-second.
//
// Caveat (documented, accepted): this is greedy coordinate descent, not a full
// model×thinking grid, so it can miss an interaction where a pricier model would
// have won only at a thinking level the anchor didn't use. That's the deliberate
// ~10-evals/node trade vs. 25; the anchor=high choice is what blunts the risk.
const STAGE1_ANCHOR: ThinkingLevel = 'high';
const THINKING_LEVELS: ThinkingLevel[] = ['minimal', 'low', 'medium', 'high', 'default'];

// ── Arg parsing ─────────────────────────────────────────────────────────────

interface SweepArgs {
  nodes: NodeId[];
  corpus: string;
  bypassClarification: boolean;
}

function parseArgs(argv: string[]): SweepArgs {
  const nodes: NodeId[] = [];
  let corpus = 'benchmarks/corpus.json';
  let bypassClarification = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--bypass-clarification') {
      bypassClarification = true;
    } else if (arg === '--node') {
      const value = argv[++i];
      if (value) {
        // Validate at the CLI boundary: an unknown node otherwise crashes deep in
        // the search with a cryptic "no Gemini 3.x model for tier=undefined".
        if (!isNodeId(value)) {
          throw new Error(`Unknown --node "${value}". Valid nodes: ${NODE_IDS.join(', ')}`);
        }
        nodes.push(value);
      }
    } else if (arg === '--corpus') {
      corpus = argv[++i] ?? corpus;
    }
  }

  return {
    nodes: nodes.length > 0 ? nodes : [...DEFAULT_SWEEP_NODES],
    corpus,
    bypassClarification,
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
  baseline: PointScore;
  chosen: PointScore;
  /** All Stage-1 points (every model at the anchor thinking level). */
  stage1: PointScore[];
  /** All Stage-2 points (every thinking level on the winning model). */
  stage2: PointScore[];
  /** The model Stage 1 settled on, carried into Stage 2. */
  stage1Winner: SweepProfile;
  /** The final (model, thinking) profile to apply — undefined when the search
   *  landed back on the node's existing default (no change). */
  chosenRung?: SweepProfile;
  e2eCritical: boolean;
}

export interface SweepConfig {
  nodes: NodeId[];
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
  /** The fixed thinking level held constant across Stage 1's model comparison. */
  stage1Anchor: ThinkingLevel;
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

export interface CombinedVerificationParams {
  /** The per-node outcomes from the two-stage search. MUTATED in place on revert:
   *  a reverted node has `chosenRung` cleared and `chosen` reset to `baseline`. */
  outcomes: NodeOutcome[];
  baselineE2e: number;
  e2eEps: number;
  /** Per-node metric ε, used to normalize revert margins into noise-band units. */
  metricEpsForNode: (node: NodeId) => number;
  /** Run the corpus once with every still-downsized node's override applied,
   *  returning the combined end-to-end score. The only Gemini/BigQuery seam. */
  runCombined: (downsized: NodeOutcome[]) => Promise<number>;
  log: (msg: string) => void;
}

/**
 * Combined verification pass with a two-step revert cascade. Extracted from
 * `runSweep` as a pure-of-IO function (the corpus seam is the injected
 * `runCombined`) so its revert/escalation logic can be unit-tested directly with
 * hand-built outcomes — the full two-stage search rarely produces a combined
 * regression on a quiet corpus, so testing it end-to-end can't exercise the cascade.
 *
 * Cascade:
 *  1. Run all downsized nodes together. If combined e2e holds within ε → done.
 *  2. On regression, revert ONE node — e2e-critical nodes first (only they can
 *     recover an e2e regression), then smallest ε-normalized margin within that
 *     group — and re-run.
 *  3. If still regressed, revert ALL e2e-critical nodes and flag manual review.
 *
 * Returns the final combined e2e (or baseline when nothing remains downsized) and
 * whether the run needs manual review.
 */
export async function runCombinedVerification(
  params: CombinedVerificationParams,
): Promise<{ combinedE2e: number; manualReview: boolean }> {
  const { outcomes, baselineE2e, e2eEps, metricEpsForNode, runCombined, log } = params;

  let downsized = outcomes.filter(o => o.chosenRung);
  let combinedE2e = baselineE2e;
  let manualReview = false;

  if (downsized.length === 0) {
    log('No nodes downsized; combined pass uses baseline.');
    return { combinedE2e, manualReview };
  }

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

  return { combinedE2e, manualReview };
}

/**
 * Two-stage coordinate-isolation orchestration: ε calibration → per-node
 * (model-axis → thinking-axis) search → combined verification pass with
 * margin-ordered revert → markdown report. Pure of all IO except the injected
 * `runCorpusOnce`, which is the only seam that touches Gemini/BigQuery. Every
 * scored point mutates `process.env.NODE_PROFILE_OVERRIDES` and always restores
 * it (try/finally), so a caller's env is left untouched.
 */
export async function runSweep(cfg: SweepConfig): Promise<SweepResult> {
  const { nodes, corpusCount, corpusLabel, runDate, runCorpusOnce } = cfg;
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

  // Score one (model, thinking) point for a node: pin NODE_PROFILE_OVERRIDES to it,
  // run the corpus once, read the per-node metrics, and ALWAYS restore env. A throw
  // (transient API error) aborts — never zero-fill, which would make a point look
  // broken and silently corrupt the sizing while emitting a plausible report.
  const scorePoint = async (node: NodeId, profile: SweepProfile, label: string): Promise<PointScore> => {
    const prev = process.env.NODE_PROFILE_OVERRIDES;
    process.env.NODE_PROFILE_OVERRIDES = JSON.stringify({ [node]: profile });
    try {
      const run = await runCorpusOnce();
      return {
        label,
        metric: nodeMetric(node, run.perEntry),
        e2e: e2eOf(run.perEntry),
        p95LatencyMs: nodeP95(node, run.nodeUsage),
        cost: nodeCost(node, profile.tier, run.nodeUsage),
      };
    } catch (err) {
      log(`  [ERROR] ${label} failed: ${(err as Error).message}. Aborting sweep to avoid corrupted sizing results.`);
      throw err;
    } finally {
      if (prev === undefined) delete process.env.NODE_PROFILE_OVERRIDES;
      else process.env.NODE_PROFILE_OVERRIDES = prev;
    }
  };

  const labelOf = (p: SweepProfile): string => `${p.tier}/${p.version}@${p.thinkingLevel}`;

  // ── Per-node two-stage search ─────────────────────────────────────────────────
  for (const node of nodes) {
    log(`\n── Node: ${node} ──`);
    const metricEps = metricEpsForNode(node);
    log(`  ε(metric)=${metricEps.toFixed(4)}  ε(e2e)=${e2eEps.toFixed(4)}`);

    const baseline: PointScore = {
      label: 'DEFAULT',
      metric: nodeMetric(node, baselineRunA.perEntry),
      e2e: e2eOf(baselineRunA.perEntry),
      p95LatencyMs: nodeP95(node, baselineRunA.nodeUsage),
      cost: nodeCost(node, defaultTierForNode(node), baselineRunA.nodeUsage),
    };

    // Map every label we score back to its concrete profile so the winners can be
    // reconstructed without re-parsing the label string.
    const profileByLabel = new Map<string, SweepProfile>();

    // Stage 1 — MODEL axis. Every Gemini 3.x model at the fixed anchor thinking
    // level (so only the model varies). listGemini3xModels() is the registry, so
    // coverage is always complete — no hand-authored subset.
    log(`  Stage 1 (model axis @ thinking=${STAGE1_ANCHOR}):`);
    const stage1: PointScore[] = [];
    for (const model of listGemini3xModels()) {
      const profile: SweepProfile = { tier: model.tier, version: model.version, thinkingLevel: STAGE1_ANCHOR };
      const label = labelOf(profile);
      profileByLabel.set(label, profile);
      const score = await scorePoint(node, profile, label);
      stage1.push(score);
      log(`    ${label}: metric=${score.metric.toFixed(3)} e2e=${score.e2e.toFixed(3)} p95=${score.p95LatencyMs}ms`);
    }
    const modelWinnerScore = pickWithinEpsilon(stage1, metricEps, e2eEps, 'cost');
    const stage1Winner = profileByLabel.get(modelWinnerScore.label)!;
    log(`  → Stage 1 winner (cheapest within ε): ${stage1Winner.tier}/${stage1Winner.version}`);

    // Stage 2 — THINKING axis. Hold the winning model fixed, walk every thinking
    // level incl. `default`. Reuse the Stage-1 measurement at the anchor level
    // (same model+thinking) rather than paying to re-run it.
    log(`  Stage 2 (thinking axis on ${stage1Winner.tier}/${stage1Winner.version}):`);
    const stage2: PointScore[] = [];
    for (const level of THINKING_LEVELS) {
      const profile: SweepProfile = { tier: stage1Winner.tier, version: stage1Winner.version, thinkingLevel: level };
      const label = labelOf(profile);
      profileByLabel.set(label, profile);
      if (level === STAGE1_ANCHOR) {
        stage2.push({ ...modelWinnerScore, label });
        log(`    ${label}: metric=${modelWinnerScore.metric.toFixed(3)} (reused from Stage 1)`);
        continue;
      }
      const score = await scorePoint(node, profile, label);
      stage2.push(score);
      log(`    ${label}: metric=${score.metric.toFixed(3)} e2e=${score.e2e.toFixed(3)} p95=${score.p95LatencyMs}ms`);
    }
    const thinkingWinnerScore = pickWithinEpsilon(stage2, metricEps, e2eEps, 'latency');
    const chosenProfile = profileByLabel.get(thinkingWinnerScore.label)!;

    // Guard against the search landing somewhere worse than the node's current
    // DEFAULT (corpus noise can make the best-in-stage point still regress the
    // baseline) — or simply back on the default itself. Either way: don't change
    // the node. Otherwise adopt the (model, thinking) the search found.
    const def = defaultProfileForNode(node);
    const sameAsDefault =
      chosenProfile.tier === def.tier &&
      chosenProfile.version === def.version &&
      chosenProfile.thinkingLevel === def.thinkingLevel;
    const regressed =
      thinkingWinnerScore.metric < baseline.metric - metricEps ||
      thinkingWinnerScore.e2e < baseline.e2e - e2eEps;
    const keepDefault = sameAsDefault || regressed;
    log(`  → chosen: ${keepDefault ? 'DEFAULT (no change)' : labelOf(chosenProfile)}`);

    outcomes.push({
      nodeId: node,
      baseline,
      chosen: keepDefault ? baseline : thinkingWinnerScore,
      stage1,
      stage2,
      stage1Winner,
      chosenRung: keepDefault ? undefined : chosenProfile,
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
  const { combinedE2e, manualReview } = await runCombinedVerification({
    outcomes,
    baselineE2e,
    e2eEps,
    metricEpsForNode,
    runCombined,
    log,
  });

  // ── Report ───────────────────────────────────────────────────────────────────
  const reportLines: string[] = [];
  reportLines.push(`# Node Sweep (two-stage coordinate isolation) — ${runDate}`);
  reportLines.push('');
  reportLines.push(`- Swept nodes: ${nodes.join(', ')}`);
  reportLines.push(`- Corpus: ${corpusLabel} (${corpusCount} questions)`);
  reportLines.push(`- Stage 1 thinking anchor: ${STAGE1_ANCHOR}`);
  reportLines.push(`- Baseline e2e: ${baselineE2e.toFixed(3)}`);
  reportLines.push(`- Combined e2e: ${combinedE2e.toFixed(3)}`);
  reportLines.push(`- ε(e2e): ${e2eEps.toFixed(4)}`);
  reportLines.push('');

  const pointTable = (points: PointScore[], chosenLabel: string): string[] => {
    const lines: string[] = [];
    lines.push('| point | metric | e2e | p95ms | cost | chosen |');
    lines.push('|-------|--------|-----|-------|------|--------|');
    for (const c of points) {
      const rec = c.label === chosenLabel ? '✓' : '';
      lines.push(
        `| ${c.label} | ${c.metric.toFixed(3)} | ${c.e2e.toFixed(3)} | ${c.p95LatencyMs} | ${c.cost.toExponential(2)} | ${rec} |`,
      );
    }
    return lines;
  };

  for (const o of outcomes) {
    const chosenLabel = o.chosenRung ? `${o.chosenRung.tier}/${o.chosenRung.version}@${o.chosenRung.thinkingLevel}` : 'DEFAULT';
    reportLines.push(`## ${o.nodeId}`);
    reportLines.push(`- Default model: ${resolveNodeModel(o.nodeId)}`);
    reportLines.push(`- ε(metric): ${metricEpsForNode(o.nodeId).toFixed(4)}`);
    reportLines.push(`- Final: ${o.chosenRung ? chosenLabel : 'DEFAULT (no change)'}`);
    reportLines.push('');
    reportLines.push(`**Stage 1 — model axis @ thinking=${STAGE1_ANCHOR}** (winner: ${o.stage1Winner.tier}/${o.stage1Winner.version})`);
    reportLines.push('');
    reportLines.push(...pointTable(o.stage1, chosenLabel));
    reportLines.push('');
    reportLines.push(`**Stage 2 — thinking axis on ${o.stage1Winner.tier}/${o.stage1Winner.version}**`);
    reportLines.push('');
    reportLines.push(...pointTable(o.stage2, chosenLabel));
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
  reportLines.push(`- Final downsized nodes: ${outcomes.filter(o => o.chosenRung).map(o => `${o.nodeId}→${o.chosen.label}`).join(', ') || 'none'}`);
  reportLines.push('');

  return {
    report: reportLines.join('\n'),
    outcomes,
    baselineE2e,
    combinedE2e,
    e2eEps,
    manualReview,
    stage1Anchor: STAGE1_ANCHOR,
  };
}

// ── Real corpus pass factory ───────────────────────────────────────────────────
// The single Gemini/BigQuery-touching seam, extracted so both main() and the
// dev smoke harness (scripts/node-sweep-smoke.ts) build the EXACT same corpus
// pass — no logic drift between the cheap ε pre-check and the full sweep.

export interface RealCorpusDeps {
  ai: GoogleGenAI;
  apiKey: string;
  corpus: CorpusEntry[];
  tables: TableContext[];
  knowledgeSummaries: KnowledgeSummary[];
  knownBenchmarkTables: string[];
  judgeModel: string;
  fileSearchStoreId?: string;
  maxBytes?: number;
  /**
   * When true, a LOW clarification verdict no longer short-circuits the quality
   * loop — every entry runs SQL generation + supervisor. Default false (the
   * production gate). Enable ONLY when sizing the SQL-path nodes
   * (sqlGenerator/supervisor) on an install whose knowledge layer is too thin to
   * give the clarifier canonical context (e.g. this template, which ships one
   * generic ReferenceCard). With the gate live, ~68% of a real-domain corpus is
   * suspended LOW before reaching the reasoning nodes, leaving them unmeasurable.
   * Bypassing is a faithful proxy for a populated install (whose clarifier WOULD
   * pass in-domain questions); clarification itself is sized separately and is
   * already clean (ε≈0.01). classifyQuestion is still CALLED so the clarification
   * metric stays measurable — only its skip decision is ignored.
   */
  bypassClarification?: boolean;
}

export function createRunCorpusOnce(deps: RealCorpusDeps): () => Promise<CorpusRunResult> {
  const {
    ai, apiKey, corpus, tables, knowledgeSummaries,
    knownBenchmarkTables, judgeModel, fileSearchStoreId,
  } = deps;
  const maxBytes = deps.maxBytes ?? MAX_BYTES;
  const bypassClarification = deps.bypassClarification ?? false;

  // The real corpus pass: classify → quality loop → judge, with per-node telemetry.
  return async function runCorpusOnce(): Promise<CorpusRunResult> {
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

          if (clarification.confidence === 'low' && !bypassClarification) {
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
              maxBytes,
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

          // No SQL was generated (LOW clarification skip with the gate live) — judging
          // a missing query is a wasted judge LLM call (quota + latency + tokens), and
          // a null query is unambiguously the worst outcome. Assign the 1–5 floor
          // deterministically; this also removes a noise source from ε. Only the skip
          // branch ever sets generatedSql=null, so this never short-circuits a real
          // SQL-path measurement (bypass mode always reaches the judge).
          let correctness: number;
          let overallScore: number;
          if (result.generatedSql === null) {
            correctness = 1;
            overallScore = 1;
          } else {
            const judge = await judgeSingleResult(ai, entry, result, judgeModel);
            correctness = judge.scores.correctness;
            overallScore = judge.overallScore;
          }

          const tableSel = tableSelectionPassed(entry.expectedTables, result.observedTables);
          const sqlShape = sqlShapePassed(entry.expectedSqlContains, result.generatedSql);
          const sqlGenMetric = mean([
            tableSel ? 1 : 0,
            sqlShape ? 1 : 0,
            // Normalize 1–5 judge correctness to 0..1 (the plan said "/10"; that
            // is WRONG — the judge scores correctness on a 1–5 scale).
            correctness / 5,
          ]);

          perEntry.push({
            id: entry.id,
            clarificationPassed: clarifyPassed === true,
            sqlGenMetric,
            overallScore,
          });
        } catch (err) {
          // Do NOT zero-fill. A genuine measurement outcome (wrong table, bad SQL
          // shape, low-confidence clarification) is *scored* above, never thrown —
          // so any exception reaching here is an exceptional failure: a transient
          // API error (429/timeout/overload), a parse error, or a bug. Scoring it
          // as a 0 would masquerade infrastructure noise as a real rung result and
          // corrupt the sizing. Re-throw so the rung-level loop in runSweep aborts
          // the whole sweep (and restores NODE_PROFILE_OVERRIDES in its finally).
          throw new Error(`corpus entry "${entry.id}" failed: ${(err as Error).message}`);
        }
      }
    });

    return { perEntry, nodeUsage };
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

  const ai = new GoogleGenAI({ apiKey });
  const root = join(process.cwd());

  const allModels = listGemini3xModels();
  console.log(`Stage 1 models (${allModels.length}): ${allModels.map(m => `${m.tier}/${m.version}`).join(', ')}`);
  console.log(`Stage 1 thinking anchor: ${STAGE1_ANCHOR}; Stage 2 thinking levels: ${THINKING_LEVELS.join(', ')}`);

  // Preflight: resolve every Gemini 3.x model id (Stage 1 touches them all) plus
  // each node's baseline model.
  const allModelIds = allModels.map(m => resolveModelId(m.tier, m.version));
  const baselineModelIds = args.nodes.map(node => resolveNodeModel(node));
  const requiredModels = [...new Set([judgeModel, ...allModelIds, ...baselineModelIds])];
  await assertGenerateContentModelsAvailable(apiKey, requiredModels);

  initBigQuery(projectId);

  // resolve() (not join) so an ABSOLUTE --corpus path — e.g. running this from the
  // main repo against <worktree>/benchmarks/corpus.live.json — is honoured rather
  // than appended to root (which would ENOENT). Mirrors node-sweep-smoke.ts.
  const corpusPath = isAbsolute(args.corpus) ? args.corpus : resolve(root, args.corpus);
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

  if (args.bypassClarification) {
    console.log('⚠ Clarification gate BYPASSED: every entry runs the quality loop (SQL-path node sizing mode).');
  }

  const runCorpusOnce = createRunCorpusOnce({
    ai,
    apiKey,
    corpus,
    tables,
    knowledgeSummaries,
    knownBenchmarkTables,
    judgeModel,
    fileSearchStoreId,
    maxBytes: MAX_BYTES,
    bypassClarification: args.bypassClarification,
  });

  const { report } = await runSweep({
    nodes: args.nodes,
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
// A suffix match on argv[1] is robust across tsx (.ts) and compiled (.js) launch
// without the loader-specific URL/path normalization that fileURLToPath comparison
// is sensitive to (symlinks, trailing slashes, file:// scheme differences).
if (process.argv[1]?.endsWith('node-sweep.ts') || process.argv[1]?.endsWith('node-sweep.js')) {
  main().then(() => {
    process.exit(0);
  }).catch(err => {
    console.error('Node sweep failed:', err);
    process.exit(1);
  });
}
