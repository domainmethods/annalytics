/**
 * node-sweep-smoke — cheap go/no-go pre-check for the per-node sizing sweep.
 *
 * Runs the corpus N times at the DEFAULT profile (no NODE_PROFILE_OVERRIDES) and
 * reports, per swept node, the run-to-run noise band ε computed EXACTLY as
 * runSweep's calibration does (id-aligned per-entry diff via computeEpsilon).
 * It builds its corpus pass through the SAME createRunCorpusOnce seam the real
 * sweep uses, so there is zero logic drift between this estimate and the full run.
 *
 * Why it exists: node-sweep's auto-verdict is vacuous when ε is a large fraction of
 * the metric scale (see src/agents/CLAUDE.md "Large ε makes the auto-verdict
 * vacuous"). Before paying for a ~20+ pass sweep, this 2-pass run answers the only
 * question that matters: did growing the corpus shrink ε below a meaningful quality
 * delta? It also prints total latency + token counts so the full sweep's cost can
 * be extrapolated (full sweep ≈ (2 + rungs × nodes + verification) corpus passes).
 *
 * Run from the MAIN REPO (it has node_modules, .env, and dbt artifacts); point
 * --corpus at the gitignored live corpus in the worktree:
 *
 *   cd <main-repo>
 *   npx tsx <worktree>/scripts/node-sweep-smoke.ts \
 *     --corpus <worktree>/benchmarks/corpus.live.json --passes 2
 *
 * Paths (dbt, .env) resolve from cwd exactly like node-sweep.ts main().
 */
import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, resolve, isAbsolute } from 'node:path';
import { GoogleGenAI } from '@google/genai';
import { initBigQuery } from '../src/validation/dryRun.js';
import { parseDbtArtifacts } from '../src/dbt/parser.js';
import type { KnowledgeSummary } from '../src/teachings/types.js';
import type { TableContext } from '../src/dbt/types.js';
import type { CorpusEntry } from './benchmark-types.js';
import { getJudgeModel, type ModelTier } from '../src/agents/modelConfig.js';
import { resolveNodeModel, defaultTierForNode, type NodeId } from '../src/agents/nodeProfiles.js';
import { assertGenerateContentModelsAvailable } from './benchmarkPreflight.js';
import { loadLocalKnowledgeSummaries } from './benchmarkInputs.js';
import { createRunCorpusOnce, type CorpusRunResult, type PerEntry } from './node-sweep.js';
import { computeEpsilon } from './node-sweep-calibrate.js';

// Nodes the smoke pre-check reports ε for — the SQL-path reasoning nodes the full
// sweep aims to size, plus clarification as the known-clean (ε≈0.01) control.
const SMOKE_NODES: NodeId[] = ['clarification', 'sqlGenerator', 'supervisor'];

// Relative per-token cost weights — mirror node-sweep.ts TIER_PRICES. Only the
// ratio across tiers is meaningful; absolute cost is a rough extrapolation aid.
const TIER_PRICES: Record<ModelTier, number> = {
  'flash-lite': 0.0000001,
  'flash': 0.0000003,
  'pro': 0.000002,
};

const MAX_BYTES = 1 * 1024 * 1024 * 1024; // mirror node-sweep.ts cost gate

interface SmokeArgs { corpus: string; passes: number; envFile?: string; bypassClarification: boolean; }

function parseArgs(argv: string[]): SmokeArgs {
  let corpus = 'benchmarks/corpus.json';
  let passes = 2;
  let envFile: string | undefined;
  let bypassClarification = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--corpus') corpus = argv[++i] ?? corpus;
    else if (a === '--passes') passes = Math.max(2, Number(argv[++i]) || 2);
    else if (a === '--env') envFile = argv[++i];
    else if (a === '--bypass-clarification') bypassClarification = true;
  }
  return { corpus, passes, envFile, bypassClarification };
}

async function fileExists(path: string): Promise<boolean> {
  try { await access(path, constants.R_OK); return true; } catch { return false; }
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((s, v) => s + v, 0) / values.length;
}

function p95(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(0.95 * sorted.length) - 1)];
}

// Per-entry node metric — IDENTICAL definition to node-sweep.ts perEntryNodeMetric.
function perEntryNodeMetric(nodeId: NodeId, e: PerEntry): number {
  if (nodeId === 'clarification') return e.clarificationPassed ? 1 : 0;
  if (nodeId === 'sqlGenerator') return e.sqlGenMetric;
  return e.overallScore;
}

// Align two runs by sorted intersection of ids — IDENTICAL to node-sweep.ts alignById.
function alignById(a: PerEntry[], b: PerEntry[], read: (e: PerEntry) => number): { a: number[]; b: number[] } {
  const mapA = new Map(a.map(e => [e.id, e]));
  const mapB = new Map(b.map(e => [e.id, e]));
  const ids = [...mapA.keys()].filter(id => mapB.has(id)).sort();
  return { a: ids.map(id => read(mapA.get(id)!)), b: ids.map(id => read(mapB.get(id)!)) };
}

function nodeMetricMean(nodeId: NodeId, perEntry: PerEntry[]): number {
  return mean(perEntry.map(e => perEntryNodeMetric(nodeId, e)));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.envFile) process.loadEnvFile(args.envFile);

  const apiKey = process.env.GEMINI_API_KEY;
  const projectId = process.env.GCP_PROJECT_ID;
  const fileSearchStoreId = process.env.FILE_SEARCH_STORE_ID;
  const manifestPath = process.env.DBT_MANIFEST_PATH || './dbt/manifest.json';
  const catalogPath = process.env.DBT_CATALOG_PATH || './dbt/catalog.json';
  const judgeModel = getJudgeModel();

  if (!apiKey || !projectId) {
    const missing = [!apiKey && 'GEMINI_API_KEY', !projectId && 'GCP_PROJECT_ID'].filter(Boolean).join(', ');
    console.error(`Error: Missing required environment variable(s): ${missing}`);
    process.exit(1);
  }

  const root = process.cwd();
  const ai = new GoogleGenAI({ apiKey });

  // Preflight: only the baseline (DEFAULT-profile) models the smoke actually calls.
  const requiredModels = [...new Set([judgeModel, ...SMOKE_NODES.map(n => resolveNodeModel(n))])];
  await assertGenerateContentModelsAvailable(apiKey, requiredModels);

  initBigQuery(projectId);

  // Corpus path: resolve() (not join) so an ABSOLUTE --corpus path to the worktree
  // is honoured even when cwd is the main repo.
  const corpusPath = isAbsolute(args.corpus) ? args.corpus : resolve(root, args.corpus);
  const corpus = JSON.parse(await readFile(corpusPath, 'utf-8')) as CorpusEntry[];
  console.log(`Corpus: ${corpus.length} questions (${corpusPath})`);
  console.log(`Passes: ${args.passes}  Judge: ${judgeModel}`);

  const knowledgeSummaries: KnowledgeSummary[] = await loadLocalKnowledgeSummaries(root);
  console.log(`Loaded ${knowledgeSummaries.length} local knowledge summaries`);

  const resolvedManifestPath = join(root, manifestPath);
  const resolvedCatalogPath = join(root, catalogPath);
  let tables: TableContext[] = [];
  if (await fileExists(resolvedManifestPath) && await fileExists(resolvedCatalogPath)) {
    const manifest = JSON.parse(await readFile(resolvedManifestPath, 'utf-8')) as { nodes: Record<string, unknown> };
    const catalog = JSON.parse(await readFile(resolvedCatalogPath, 'utf-8')) as { nodes: Record<string, unknown> };
    tables = parseDbtArtifacts(
      manifest as Parameters<typeof parseDbtArtifacts>[0],
      catalog as Parameters<typeof parseDbtArtifacts>[1],
    );
    console.log(`Loaded ${tables.length} dbt tables`);
  } else {
    console.warn('Warning: dbt artifacts not found. Running without schema context (queries will fail dry-run).');
  }

  const knownBenchmarkTables = [...new Set([
    ...tables.map(t => t.name),
    ...corpus.flatMap(e => e.expectedTables ?? []),
  ])];

  if (args.bypassClarification) {
    console.log('⚠ Clarification gate BYPASSED: every entry runs the quality loop (SQL-path node sizing mode).');
  }

  const runCorpusOnce = createRunCorpusOnce({
    ai, apiKey, corpus, tables, knowledgeSummaries, knownBenchmarkTables,
    judgeModel, fileSearchStoreId, maxBytes: MAX_BYTES,
    bypassClarification: args.bypassClarification,
  });

  // ── Run N baseline passes ────────────────────────────────────────────────────
  const runs: CorpusRunResult[] = [];
  const wallMs: number[] = [];
  for (let i = 0; i < args.passes; i++) {
    process.stdout.write(`\nPass ${i + 1}/${args.passes}... `);
    const t0 = process.hrtime.bigint();
    const run = await runCorpusOnce();
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    wallMs.push(ms);
    runs.push(run);
    console.log(`done in ${(ms / 1000).toFixed(1)}s (${run.perEntry.length} entries scored)`);
  }

  // ── ε per node (id-aligned per-entry max diff across the first two passes) ─────
  const runA = runs[0], runB = runs[1];
  console.log('\n══ Per-node ε (run-to-run noise band, lower = more sizable) ══');
  console.log('node           ε(metric)   baseline metric   scale');
  for (const node of SMOKE_NODES) {
    const aligned = alignById(runA.perEntry, runB.perEntry, e => perEntryNodeMetric(node, e));
    const eps = computeEpsilon(aligned.a, aligned.b);
    const baselineMetric = nodeMetricMean(node, runA.perEntry);
    const scale = node === 'supervisor' ? '1–5' : '0–1';
    const epsPctOfScale = node === 'supervisor' ? (eps / 4) * 100 : eps * 100;
    console.log(
      `${node.padEnd(14)} ${eps.toFixed(4).padStart(9)}   ${baselineMetric.toFixed(3).padStart(15)}   ${scale}  (ε≈${epsPctOfScale.toFixed(1)}% of scale)`,
    );
  }

  // e2e ε (overallScore series; node-independent)
  const e2eAligned = alignById(runA.perEntry, runB.perEntry, e => e.overallScore);
  const e2eEps = computeEpsilon(e2eAligned.a, e2eAligned.b);
  const e2eBaseline = mean(runA.perEntry.map(e => e.overallScore));
  console.log(`\ne2e (overallScore 1–5): baseline ${e2eBaseline.toFixed(3)}  ε ${e2eEps.toFixed(4)} (≈${((e2eEps / 4) * 100).toFixed(1)}% of scale)`);

  // ── Cost + latency extrapolation ──────────────────────────────────────────────
  console.log('\n══ Cost / latency (per baseline pass) ══');
  let totalTokens = 0, totalCost = 0;
  for (const node of SMOKE_NODES) {
    const usage = runA.nodeUsage.get(node);
    const tokens = usage?.tokens ?? 0;
    const tier = defaultTierForNode(node);
    const cost = tokens * TIER_PRICES[tier];
    totalTokens += tokens;
    totalCost += cost;
    console.log(`${node.padEnd(14)} tier=${tier.padEnd(10)} tokens=${String(tokens).padStart(8)}  p95=${p95(usage?.latencies ?? []).toFixed(0)}ms  cost≈${cost.toExponential(2)}`);
  }
  // Include any non-swept nodes' tokens (e.g. internal flash calls) in the pass total.
  let allTokens = 0;
  for (const [, u] of runA.nodeUsage) allTokens += u.tokens;
  const meanWall = mean(wallMs);
  console.log(`\nAll-node tokens/pass: ${allTokens}   swept-node cost/pass≈${totalCost.toExponential(2)}`);
  console.log(`Wall-clock/pass: ${(meanWall / 1000).toFixed(1)}s (mean of ${wallMs.length})`);

  // Full sweep size: 2 calibration + (rungs × nodes) ladder + (1..3) verification.
  // DEFAULT_LADDER has 6 rungs; SMOKE_NODES has 3 → 2 + 18 + ~2 ≈ 22 passes.
  const estPasses = 2 + 6 * SMOKE_NODES.length + 2;
  console.log(`\nFull sweep ≈ ${estPasses} passes → ~${((meanWall * estPasses) / 60000).toFixed(0)} min wall, ~${(allTokens * estPasses / 1e6).toFixed(1)}M tokens (order-of-magnitude).`);

  console.log('\nDecision rule: a node is sizable only if ε(metric) is small vs the quality delta');
  console.log('between rungs. Compare against the held-default rationale in');
  console.log('docs/superpowers/plans/2026-06-07-node-sizing-eval-goal.md before launching the full sweep.');
}

main().then(() => process.exit(0)).catch(err => {
  console.error('\nSmoke run failed:', err);
  process.exit(1);
});
