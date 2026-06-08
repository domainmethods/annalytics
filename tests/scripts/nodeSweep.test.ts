import { describe, it, expect, afterEach } from 'vitest';
import {
  runSweep,
  runCombinedVerification,
  type CorpusRunResult,
  type PerEntry,
  type NodeOutcome,
} from '../../scripts/node-sweep.js';
import type { PointScore, SweepProfile } from '../../scripts/node-sweep-types.js';
import { defaultProfileForNode, type NodeId, type ThinkingLevel } from '../../src/agents/nodeProfiles.js';
import type { ModelTier } from '../../src/agents/modelConfig.js';

// ── Synthetic, override-sensitive corpus model ─────────────────────────────────
// runSweep touches Gemini/BigQuery ONLY through the injected runCorpusOnce. A
// deterministic model that reads NODE_PROFILE_OVERRIDES drives the entire two-stage
// machinery — ε calibration, the Stage-1 model sweep, the Stage-2 thinking sweep,
// the decision rule, and the keepDefault guard — with no credentials.
//
// Each swept node derives its baseline from the REAL default (defaultProfileForNode)
// so "landed back on the default" is meaningful. Only sqlGenerator is TIER-SENSITIVE:
// its metric collapses far below its ε gate off the `pro` tier (and so does e2e),
// which is what keeps a reasoning node pinned to pro while flat nodes downsize. All
// other nodes are FLAT — quality is independent of model/thinking — so Stage 1 takes
// the cheapest model (flash-lite) and Stage 2 trims thinking to `minimal`.

const TIER_SENSITIVE = new Set<NodeId>(['sqlGenerator']);
const OFF_PRO_METRIC = 0.40; // sqlGenMetric drop off pro — dwarfs ε(metric)≈0.02
const OFF_PRO_E2E = 0.40;    // e2e drop off pro for tier-sensitive nodes
const BASE_OVERALL = 4.30;
const BASE_SQLMETRIC = 0.95;

const THINK_TOKENS: Record<ThinkingLevel, number> = { minimal: 50, low: 150, medium: 400, high: 900, default: 300 };
const TIER_LAT: Record<ModelTier, number> = { 'flash-lite': 100, 'flash': 200, 'pro': 500 };

interface EffProfile { tier: ModelTier; version: string; level: ThinkingLevel; }

function effectiveProfiles(nodes: NodeId[]): Record<string, EffProfile> {
  let overrides: Record<string, { tier?: ModelTier; version?: string; thinkingLevel?: ThinkingLevel }> = {};
  const raw = process.env.NODE_PROFILE_OVERRIDES;
  if (raw) { try { overrides = JSON.parse(raw); } catch { overrides = {}; } }
  const out: Record<string, EffProfile> = {};
  for (const node of nodes) {
    const def = defaultProfileForNode(node);
    const o = overrides[node];
    out[node] = {
      tier: o?.tier ?? def.tier,
      version: o?.version ?? def.version,
      level: o?.thinkingLevel ?? def.thinkingLevel,
    };
  }
  return out;
}

// Deterministic per-(entry,call) jitter → two baseline runs differ (non-floor ε on
// the continuous overallScore series), but the spread is small enough never to flip
// an engineered gate decision. clarificationPassed is constant → ε(metric_clar) floors.
const jitterMetric = (i: number, call: number): number => ((i * 3 + call * 4) % 6) * 0.005; // 0..0.025
const jitterE2e = (i: number, call: number): number => ((i * 5 + call * 7) % 11) * 0.01;     // 0..0.10

function makeRunCorpusOnce(nodes: NodeId[], corpusSize = 12): () => Promise<CorpusRunResult> {
  // sqlGenerator's tier must be readable even when it isn't being swept (it drives
  // sqlGenMetric globally); fall back to its real default tier.
  const sqlNodes = nodes.includes('sqlGenerator') ? nodes : [...nodes, 'sqlGenerator' as NodeId];
  let call = -1;
  return async () => {
    call += 1;
    const eff = effectiveProfiles(sqlNodes);

    let e2eDelta = 0;
    for (const node of nodes) {
      if (TIER_SENSITIVE.has(node) && eff[node].tier !== 'pro') e2eDelta -= OFF_PRO_E2E;
    }
    const sqlTier = eff['sqlGenerator'].tier;
    const sqlMetricDelta = sqlTier === 'pro' ? 0 : -OFF_PRO_METRIC;

    const perEntry: PerEntry[] = [];
    const nodeUsage = new Map<NodeId, { latencies: number[]; tokens: number }>();
    const bump = (node: NodeId, prof: EffProfile): void => {
      const tokens = 500 + THINK_TOKENS[prof.level];
      const latency = 200 + tokens * 0.5 + TIER_LAT[prof.tier];
      let b = nodeUsage.get(node);
      if (!b) { b = { latencies: [], tokens: 0 }; nodeUsage.set(node, b); }
      b.latencies.push(latency);
      b.tokens += tokens;
    };

    for (let i = 0; i < corpusSize; i++) {
      perEntry.push({
        id: `q${i}`,
        clarificationPassed: true,
        sqlGenMetric: BASE_SQLMETRIC + sqlMetricDelta + jitterMetric(i, call),
        overallScore: BASE_OVERALL + e2eDelta + jitterE2e(i, call),
      });
      for (const node of nodes) bump(node, eff[node]);
    }
    return { perEntry, nodeUsage };
  };
}

const sweep = (nodes: NodeId[]) => runSweep({
  nodes,
  corpusCount: 12,
  corpusLabel: 'synthetic',
  runDate: '2026-06-08',
  runCorpusOnce: makeRunCorpusOnce(nodes),
  log: () => {},
});

// Parse a point label "tier/version@level" back into its axes for assertions.
const parseLabel = (label: string): { tier: string; version: string; level: string } => {
  const [model, level] = label.split('@');
  const slash = model.indexOf('/');
  return { tier: model.slice(0, slash), version: model.slice(slash + 1), level };
};

afterEach(() => { delete process.env.NODE_PROFILE_OVERRIDES; });

describe('runSweep — two-stage coordinate isolation', () => {
  it('reports the Stage-1 thinking anchor it held fixed', async () => {
    const r = await sweep(['clarification']);
    expect(r.stage1Anchor).toBe('high');
  });

  it('Stage 1 evaluates ALL FOUR Gemini 3.x models, every one at the fixed anchor (axis isolation)', async () => {
    const r = await sweep(['clarification']);
    const o = r.outcomes[0];
    expect(o.stage1).toHaveLength(4);
    // Every Stage-1 point holds thinking at the anchor — only the model varies.
    for (const p of o.stage1) expect(parseLabel(p.label).level).toBe('high');
    // All four distinct models appear.
    const models = o.stage1.map(p => { const x = parseLabel(p.label); return `${x.tier}/${x.version}`; });
    expect(new Set(models)).toEqual(new Set(['flash-lite/3.1', 'flash/3', 'flash/3.5', 'pro/3.1']));
  });

  it('Stage 2 holds the winning model fixed and walks every thinking level incl. `default` (axis isolation)', async () => {
    const r = await sweep(['clarification']);
    const o = r.outcomes[0];
    expect(o.stage2).toHaveLength(5);
    const w = o.stage1Winner;
    // Every Stage-2 point is the SAME model as the Stage-1 winner — only thinking varies.
    for (const p of o.stage2) {
      const x = parseLabel(p.label);
      expect(`${x.tier}/${x.version}`).toBe(`${w.tier}/${w.version}`);
    }
    const levels = o.stage2.map(p => parseLabel(p.label).level);
    expect(new Set(levels)).toEqual(new Set(['minimal', 'low', 'medium', 'high', 'default']));
  });

  it('calibrates a non-floor ε from run-to-run noise on the continuous e2e signal', async () => {
    const r = await sweep(['clarification']);
    expect(r.e2eEps).toBeGreaterThan(0.01); // jitter on overallScore exceeds the floor
  });

  it('downsizes a tier-insensitive node to the cheapest model and trims thinking (clarification → flash-lite/minimal)', async () => {
    const r = await sweep(['clarification']);
    const o = r.outcomes[0];
    // Stage 1: every model is quality-equal → cheapest tier wins.
    expect(o.stage1Winner.tier).toBe('flash-lite');
    // Stage 2: thinking is quality-equal → fastest (minimal) wins.
    expect(o.chosenRung).toBeDefined();
    expect(o.chosenRung!.tier).toBe('flash-lite');
    expect(o.chosenRung!.version).toBe('3.1');
    expect(o.chosenRung!.thinkingLevel).toBe('minimal');
  });

  it('keeps a tier-sensitive node on pro (the quality gate excludes cheap tiers)', async () => {
    const r = await sweep(['sqlGenerator']);
    const o = r.outcomes[0];
    expect(o.stage1Winner.tier).toBe('pro');
    expect(o.chosenRung).toBeDefined();
    expect(o.chosenRung!.tier).toBe('pro');
  });

  it('keeps the DEFAULT (no change) when the search lands back on the node\'s existing default', async () => {
    // slackIntake's default is the cheapest, fastest point (flash-lite/3.1@minimal),
    // so the flat search reproduces it exactly → sameAsDefault → no override emitted.
    const r = await sweep(['slackIntake']);
    const o = r.outcomes[0];
    const def = defaultProfileForNode('slackIntake');
    expect(o.stage1Winner.tier).toBe(def.tier);
    expect(o.chosenRung).toBeUndefined();
    expect(o.chosen.label).toBe('DEFAULT');
  });

  it('accepts a multi-node downsize whose combined e2e holds within ε (no revert)', async () => {
    const r = await sweep(['clarification', 'sqlGenerator', 'supervisor']);
    const byId = new Map(r.outcomes.map(o => [o.nodeId, o]));
    expect(byId.get('clarification')!.chosenRung!.tier).toBe('flash-lite');
    expect(byId.get('sqlGenerator')!.chosenRung!.tier).toBe('pro');
    expect(byId.get('supervisor')!.chosenRung!.tier).toBe('flash-lite'); // flat e2e-critical node downsizes cleanly
    expect(r.manualReview).toBe(false);
    expect(r.combinedE2e).toBeGreaterThanOrEqual(r.baselineE2e - r.e2eEps);
  });

  it('restores NODE_PROFILE_OVERRIDES to its prior absence after the sweep', async () => {
    expect(process.env.NODE_PROFILE_OVERRIDES).toBeUndefined();
    await sweep(['clarification']);
    expect(process.env.NODE_PROFILE_OVERRIDES).toBeUndefined();
  });

  it('aborts (does not zero-fill) when a point run throws — a transient API error must not corrupt sizing', async () => {
    // The two calibration runs at baseline must succeed so calibration completes;
    // the first scored point then throws (simulating a rate-limit/quota error). A
    // zero-filled metric would make the point look broken and silently get gated out,
    // corrupting the recommendation. The sweep must surface the error instead.
    const inner = makeRunCorpusOnce(['clarification']);
    let call = -1;
    const runCorpusOnce = async (): Promise<CorpusRunResult> => {
      call += 1;
      if (call >= 2) throw new Error('simulated rate limit');
      return inner();
    };
    await expect(
      runSweep({
        nodes: ['clarification'],
        corpusCount: 12,
        corpusLabel: 'synthetic',
        runDate: '2026-06-08',
        runCorpusOnce,
        log: () => {},
      }),
    ).rejects.toThrow('simulated rate limit');
    // The env-restoring finally must still run on the abort path.
    expect(process.env.NODE_PROFILE_OVERRIDES).toBeUndefined();
  });
});

// ── Direct combined-verification revert cascade ────────────────────────────────
// The full two-stage search rarely produces a combined regression on a quiet
// corpus, so the revert/escalation cascade is tested directly with hand-built
// outcomes and a scripted runCombined that reacts to which nodes remain downsized.

const pt = (over: Partial<PointScore>): PointScore => ({
  label: 'x', metric: 0.9, e2e: 4.0, p95LatencyMs: 1000, cost: 100, ...over,
});

const outcome = (over: Partial<NodeOutcome>): NodeOutcome => ({
  nodeId: 'supervisor',
  baseline: pt({ metric: 4.0, e2e: 4.0, label: 'DEFAULT' }),
  chosen: pt({ metric: 3.95, e2e: 3.95 }),
  stage1: [],
  stage2: [],
  stage1Winner: { tier: 'flash', version: '3', thinkingLevel: 'high' } as SweepProfile,
  chosenRung: { tier: 'flash', version: '3', thinkingLevel: 'minimal' } as SweepProfile,
  e2eCritical: true,
  ...over,
});

describe('runCombinedVerification — revert cascade', () => {
  it('accepts cleanly when the combined downsize holds within ε (no reverts)', async () => {
    const outcomes = [
      outcome({ nodeId: 'supervisor', e2eCritical: true }),
      outcome({ nodeId: 'clarification', e2eCritical: false }),
    ];
    let calls = 0;
    const { combinedE2e, manualReview } = await runCombinedVerification({
      outcomes,
      baselineE2e: 4.0,
      e2eEps: 0.1,
      metricEpsForNode: () => 0.5,
      runCombined: async () => { calls++; return 4.0; }, // holds at baseline
      log: () => {},
    });
    expect(manualReview).toBe(false);
    expect(combinedE2e).toBe(4.0);
    expect(calls).toBe(1); // one combined run, no revert re-runs
    expect(outcomes.every(o => o.chosenRung)).toBe(true); // nothing reverted
  });

  it('reverts the e2e-critical node FIRST, even when a non-critical node has a smaller margin', async () => {
    // sqlGenerator (non-critical) is given the smaller raw margin, so a margin-only
    // sort would revert it first. The e2e-critical priority must override that and
    // revert supervisor — the only node whose quality is observed through e2e.
    const supervisor = outcome({
      nodeId: 'supervisor', e2eCritical: true,
      chosen: pt({ metric: 4.0, e2e: 3.9 }), baseline: pt({ metric: 4.0, e2e: 4.0 }), // large margin
    });
    const sqlGenerator = outcome({
      nodeId: 'sqlGenerator', e2eCritical: false,
      chosen: pt({ metric: 0.90, e2e: 3.9 }), baseline: pt({ metric: 0.90, e2e: 4.0 }), // tiny margin
    });
    const outcomes = [sqlGenerator, supervisor];
    const { manualReview } = await runCombinedVerification({
      outcomes,
      baselineE2e: 4.0,
      e2eEps: 0.1,
      metricEpsForNode: () => 0.1,
      // Regressed while supervisor is still downsized; recovers once it's reverted.
      runCombined: async (ds) => (ds.some(o => o.nodeId === 'supervisor' && o.chosenRung) ? 3.5 : 4.0),
      log: () => {},
    });
    expect(manualReview).toBe(false);
    expect(supervisor.chosenRung).toBeUndefined();   // e2e-critical reverted first
    expect(supervisor.chosen).toBe(supervisor.baseline);
    expect(sqlGenerator.chosenRung).toBeDefined();   // non-critical left downsized
  });

  it('reverts ALL e2e-critical nodes and flags manual review when one revert cannot recover e2e', async () => {
    const supervisor = outcome({ nodeId: 'supervisor', e2eCritical: true });
    const discrepancy = outcome({ nodeId: 'discrepancy', e2eCritical: true });
    const outcomes = [supervisor, discrepancy];
    const { manualReview } = await runCombinedVerification({
      outcomes,
      baselineE2e: 4.0,
      e2eEps: 0.1,
      metricEpsForNode: () => 0.1,
      // Stays regressed until NO e2e-critical node remains downsized.
      runCombined: async (ds) => (ds.some(o => o.e2eCritical && o.chosenRung) ? 3.0 : 4.0),
      log: () => {},
    });
    expect(manualReview).toBe(true);
    expect(supervisor.chosenRung).toBeUndefined();
    expect(discrepancy.chosenRung).toBeUndefined();
  });
});
