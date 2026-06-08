import { describe, it, expect, afterEach } from 'vitest';
import { runSweep, type CorpusRunResult, type PerEntry } from '../../scripts/node-sweep.js';
import { DEFAULT_LADDER } from '../../scripts/node-sweep-types.js';
import type { NodeId, ThinkingLevel } from '../../src/agents/nodeProfiles.js';
import type { ModelTier } from '../../src/agents/modelConfig.js';

// ── Synthetic, override-sensitive corpus model ─────────────────────────────────
// runSweep touches Gemini/BigQuery ONLY through the injected runCorpusOnce. By
// substituting a deterministic model that reads NODE_PROFILE_OVERRIDES, we drive
// the entire coordinate-descent machinery — ε calibration, the per-node ladder
// sweep, the decision rule, and the combined-pass revert cascade — with no
// credentials. Values are tuned so every orchestration path fires deterministically.

const TIER_BASE: Record<ModelTier, number> = { 'flash-lite': 0.0, 'flash': 0.5, 'pro': 1.0 };
const THINK_BONUS: Record<ThinkingLevel, number> = { minimal: 0, low: 0.04, medium: 0.08, high: 0.12, default: 0.06 };
const THINK_TOKENS: Record<ThinkingLevel, number> = { minimal: 50, low: 150, medium: 400, high: 900, default: 300 };
const TIER_LAT: Record<ModelTier, number> = { 'flash-lite': 100, 'flash': 200, 'pro': 500 };

// Baseline profiles — mirror nodeProfiles DEFAULTS for the swept nodes.
const NODE_BASE: Record<string, { tier: ModelTier; level: ThinkingLevel }> = {
  clarification: { tier: 'flash', level: 'default' },
  sqlGenerator: { tier: 'pro', level: 'default' },
  supervisor: { tier: 'pro', level: 'default' },
  discrepancy: { tier: 'pro', level: 'default' },
};
// e2e contribution weight per node. supervisor/discrepancy at 0.09 so a flash
// downsize lands ~-0.05 e2e — comfortably inside ε(e2e)≈0.07 (viable).
const KE2E: Record<string, number> = { clarification: 0.10, sqlGenerator: 0.50, supervisor: 0.09, discrepancy: 0.09 };
const KSQL_METRIC = 0.80; // sqlGenerator tier sensitivity — only pro rungs clear its gate.
const BASE_OVERALL = 4.30;
const BASE_SQLMETRIC = 0.95;

const sOf = (tier: ModelTier, level: ThinkingLevel): number => TIER_BASE[tier] + THINK_BONUS[level];

interface EffProfile { tier: ModelTier; level: ThinkingLevel; }

function effectiveProfiles(): Record<string, EffProfile> {
  let overrides: Record<string, { tier?: ModelTier; thinkingLevel?: ThinkingLevel }> = {};
  const raw = process.env.NODE_PROFILE_OVERRIDES;
  if (raw) { try { overrides = JSON.parse(raw); } catch { overrides = {}; } }
  const out: Record<string, EffProfile> = {};
  for (const [node, base] of Object.entries(NODE_BASE)) {
    const o = overrides[node];
    out[node] = { tier: (o?.tier ?? base.tier), level: (o?.thinkingLevel ?? base.level) };
  }
  return out;
}

// Deterministic per-(entry,call) jitter → two baseline runs differ (non-floor ε),
// but the spread is small enough never to flip an engineered gate decision.
const jitterMetric = (i: number, call: number): number => ((i * 3 + call * 4) % 6) * 0.005; // 0..0.025
const jitterE2e = (i: number, call: number): number => ((i * 5 + call * 7) % 11) * 0.01;     // 0..0.10

function makeRunCorpusOnce(corpusSize = 12): () => Promise<CorpusRunResult> {
  let call = -1;
  return async () => {
    call += 1;
    const eff = effectiveProfiles();
    let e2eDelta = 0;
    for (const [node, base] of Object.entries(NODE_BASE)) {
      e2eDelta += (KE2E[node] ?? 0) * (sOf(eff[node].tier, eff[node].level) - sOf(base.tier, base.level));
    }
    const sqlBase = NODE_BASE.sqlGenerator;
    const sqlMetricDelta = KSQL_METRIC * (sOf(eff.sqlGenerator.tier, eff.sqlGenerator.level) - sOf(sqlBase.tier, sqlBase.level));

    const perEntry: PerEntry[] = [];
    const nodeUsage = new Map<NodeId, { latencies: number[]; tokens: number }>();
    const bump = (node: string, prof: EffProfile): void => {
      const tokens = 500 + THINK_TOKENS[prof.level];
      const latency = 200 + tokens * 0.5 + TIER_LAT[prof.tier];
      let b = nodeUsage.get(node as NodeId);
      if (!b) { b = { latencies: [], tokens: 0 }; nodeUsage.set(node as NodeId, b); }
      b.latencies.push(latency);
      b.tokens += tokens;
    };
    for (let i = 0; i < corpusSize; i++) {
      perEntry.push({
        id: `q${i}`,
        clarificationPassed: true, // deterministic → ε_clar floors at 0.01 (boolean series)
        sqlGenMetric: BASE_SQLMETRIC + sqlMetricDelta + jitterMetric(i, call),
        overallScore: BASE_OVERALL + e2eDelta + jitterE2e(i, call),
      });
      for (const [node, prof] of Object.entries(eff)) bump(node, prof);
    }
    return { perEntry, nodeUsage };
  };
}

const sweep = (nodes: NodeId[]) => runSweep({
  nodes,
  ladder: [...DEFAULT_LADDER],
  corpusCount: 12,
  corpusLabel: 'synthetic',
  runDate: '2026-06-07',
  runCorpusOnce: makeRunCorpusOnce(),
  log: () => {},
});

afterEach(() => { delete process.env.NODE_PROFILE_OVERRIDES; });

describe('runSweep orchestration', () => {
  it('calibrates a non-floor ε from run-to-run noise on continuous signals', async () => {
    const r = await sweep(['clarification', 'sqlGenerator', 'supervisor']);
    expect(r.e2eEps).toBeGreaterThan(0.01); // jitter on overallScore exceeds the floor
  });

  it('downsizes cross-tier when quality is tier-insensitive (clarification → R0 flash-lite)', async () => {
    const r = await sweep(['clarification', 'sqlGenerator', 'supervisor']);
    const byId = new Map(r.outcomes.map(o => [o.nodeId, o]));
    expect(byId.get('clarification')!.chosen.rung).toBe('R0');
  });

  it('keeps a tier-sensitive node on pro but downsizes thinking (sqlGenerator → R4 pro/low)', async () => {
    const r = await sweep(['clarification', 'sqlGenerator', 'supervisor']);
    const byId = new Map(r.outcomes.map(o => [o.nodeId, o]));
    // flash rungs fail the metric gate; among viable pro rungs the fastest (least
    // thinking) wins → a within-tier thinking downsize, not a tier drop.
    expect(byId.get('sqlGenerator')!.chosen.rung).toBe('R4');
  });

  it('reverts the e2e-critical node first on a combined regression, not the smaller-ε node', async () => {
    const r = await sweep(['clarification', 'sqlGenerator', 'supervisor']);
    const byId = new Map(r.outcomes.map(o => [o.nodeId, o]));
    // supervisor (e2e-critical) is reverted to recover e2e; sqlGenerator — which has
    // a tighter ε and would sort first by raw margin — is correctly LEFT downsized
    // because reverting it cannot cure an e2e regression.
    expect(byId.get('supervisor')!.chosenRung).toBeUndefined();
    expect(byId.get('supervisor')!.chosen.rung).toBe('DEFAULT');
    expect(byId.get('sqlGenerator')!.chosen.rung).toBe('R4');
    expect(r.manualReview).toBe(false);
    expect(r.combinedE2e).toBeGreaterThanOrEqual(r.baselineE2e - r.e2eEps);
  });

  it('escalates to manual review when reverting one node cannot recover e2e', async () => {
    // Two e2e-critical nodes both downsize within ε individually but stack beyond ε.
    // One revert is insufficient → revert ALL e2e-critical nodes and flag.
    const r = await sweep(['clarification', 'supervisor', 'discrepancy']);
    const byId = new Map(r.outcomes.map(o => [o.nodeId, o]));
    expect(r.manualReview).toBe(true);
    expect(byId.get('supervisor')!.chosenRung).toBeUndefined();
    expect(byId.get('discrepancy')!.chosenRung).toBeUndefined();
    expect(byId.get('clarification')!.chosen.rung).toBe('R0'); // non-critical pick survives
    expect(r.report).toContain('FLAGGED FOR MANUAL REVIEW');
  });

  it('restores NODE_PROFILE_OVERRIDES to its prior absence after the sweep', async () => {
    expect(process.env.NODE_PROFILE_OVERRIDES).toBeUndefined();
    await sweep(['clarification']);
    expect(process.env.NODE_PROFILE_OVERRIDES).toBeUndefined();
  });
});
