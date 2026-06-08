import { resolveModelId, type ModelTier } from './modelConfig.js';

export type NodeId =
  | 'clarification' | 'slackIntake' | 'followUpClassifier' | 'dbtStatus'
  | 'metaQuestion' | 'chart' | 'sqlGenerator' | 'supervisor'
  | 'discrepancy' | 'teachingCandidate' | 'summaryOverride';

export type ThinkingLevel = 'minimal' | 'low' | 'medium' | 'high' | 'default';

export interface NodeProfile {
  tier: ModelTier;
  version: string;            // resolved via the explicit Gemini 3.x map
  thinkingLevel: ThinkingLevel;
}

// Shared constants — safe because getNodeProfile NEVER hands out a DEFAULTS
// reference directly; every return is a fresh spread (see below).
//
// MEASURED vs PROVISIONAL. Two install-invariant classifier nodes (slackIntake,
// followUpClassifier) are MEASURED: the judge-free floor-up sweep
// (scripts/universal-sweep.ts, benchmarks/results/universal-sweep-2026-06-08.md)
// scored exact-match route/intent accuracy across the full ladder and found BOTH
// perfect (1.000) at every rung — including the cheapest model, flash-lite/3.1.
// Flat-at-ceiling means the task sits below the model-difficulty floor, so floor-up
// takes the cheapest rung (CLASSIFIER_LITE) rather than paying for unused capability.
//
// The remaining levels are PROVISIONAL role-based HEURISTICS, not measured (tiers
// are NOT provisional — they encode real domain knowledge: flash for classify/format,
// pro for generate/review). Thinking scales with the openness of the reasoning —
//   minimal → closed-set classification / structured extraction / reformatting
//   low     → light judgment over provided context
//   default → hard open generation & critique (let the model manage its own budget)
// dbtStatus/chart/summaryOverride stay at flash/3 (un-measured: the universal corpus
// only labels intake + follow-up routing). The three pro reasoning nodes are corpus-
// limited on the SQL path (ε too large on the 12-question corpus to size safely) and
// stay model-managed — see docs/superpowers/plans/2026-06-07-node-sizing-eval-goal.md.
const CLASSIFIER_LITE: NodeProfile = { tier: 'flash-lite', version: '3.1', thinkingLevel: 'minimal' };
const FLASH_MINIMAL: NodeProfile = { tier: 'flash', version: '3', thinkingLevel: 'minimal' };
const FLASH_LOW: NodeProfile = { tier: 'flash', version: '3', thinkingLevel: 'low' };
const PRO_DEFAULT: NodeProfile = { tier: 'pro', version: '3.1', thinkingLevel: 'default' };

const DEFAULTS: Record<NodeId, NodeProfile> = {
  // MEASURED — perfect at flash-lite/3.1 across the whole ladder (judge-free floor-up)
  slackIntake: CLASSIFIER_LITE, followUpClassifier: CLASSIFIER_LITE,
  // minimal — closed-set routing / structured selection / reformatting (un-measured)
  dbtStatus: FLASH_MINIMAL, chart: FLASH_MINIMAL, summaryOverride: FLASH_MINIMAL,
  // low — light open judgment over provided context
  clarification: FLASH_LOW, metaQuestion: FLASH_LOW, teachingCandidate: FLASH_LOW,
  // default — hard reasoning, model-managed thinking budget
  sqlGenerator: PRO_DEFAULT, supervisor: PRO_DEFAULT, discrepancy: PRO_DEFAULT,
};

// Runtime list of valid node ids (single source of truth = the DEFAULTS keys),
// so CLIs and config loaders can validate a string against the NodeId union,
// which type-only declarations can't do at runtime.
export const NODE_IDS = Object.keys(DEFAULTS) as NodeId[];
export function isNodeId(value: string): value is NodeId {
  return (NODE_IDS as readonly string[]).includes(value);
}

const TIERS: ModelTier[] = ['flash-lite', 'flash', 'pro'];
const LEVELS: ThinkingLevel[] = ['minimal', 'low', 'medium', 'high', 'default'];

function isValidPartial(v: unknown): v is Partial<NodeProfile> {
  if (!v || typeof v !== 'object') return false;
  const p = v as Record<string, unknown>;
  if ('tier' in p && !TIERS.includes(p.tier as ModelTier)) return false;
  if ('version' in p && typeof p.version !== 'string') return false;
  if ('thinkingLevel' in p && !LEVELS.includes(p.thinkingLevel as ThinkingLevel)) return false;
  return true;
}

function parseOverrides(raw: string): Partial<Record<NodeId, Partial<NodeProfile>>> {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch {
    console.warn('NODE_PROFILE_OVERRIDES is not valid JSON; ignoring');
    return {};
  }
  if (!parsed || typeof parsed !== 'object') return {};
  const out: Partial<Record<NodeId, Partial<NodeProfile>>> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (k in DEFAULTS && isValidPartial(v)) out[k as NodeId] = v;
  }
  return out;
}

// Cache keyed on the RAW env string — NOT a one-time memo. The sweep mutates
// NODE_PROFILE_OVERRIDES per rung and relies on each getNodeProfile call seeing
// the current value, so we must re-parse whenever the string changes. Caching on
// the raw string preserves that semantics while avoiding (a) a JSON.parse on every
// single agent call and (b) repeated "not valid JSON" warning spam from a malformed
// value that stays constant across thousands of calls.
let cachedRaw: string | undefined;
let cachedOverrides: Partial<Record<NodeId, Partial<NodeProfile>>> = {};
let cacheValid = false;

function loadOverrides(): Partial<Record<NodeId, Partial<NodeProfile>>> {
  const raw = process.env.NODE_PROFILE_OVERRIDES;
  if (!raw) return {};
  if (cacheValid && raw === cachedRaw) return cachedOverrides;
  cachedOverrides = parseOverrides(raw);
  cachedRaw = raw;
  cacheValid = true;
  return cachedOverrides;
}

const warnedBadProfiles = new Set<string>();

export function getNodeProfile(id: NodeId): NodeProfile {
  const merged: NodeProfile = { ...DEFAULTS[id], ...loadOverrides()[id] };
  // A well-SHAPED override can still name an UNRESOLVABLE (tier, version) pair —
  // either directly ({tier:'pro', version:'3.5'}) or by a tier-only override that
  // inherits an incompatible version ({tier:'flash-lite'} → merged 'flash-lite/3',
  // which has no model). isValidPartial only sees the partial; resolvability is a
  // property of the MERGED profile. Re-check it here and fall back rather than
  // throwing on every request that hits this node.
  try {
    resolveModelId(merged.tier, merged.version);
    return merged;
  } catch {
    const key = `${id}:${merged.tier}/${merged.version}`;
    if (!warnedBadProfiles.has(key)) {
      console.warn(`NODE_PROFILE_OVERRIDES[${id}] resolves to no Gemini 3.x model (${merged.tier}/${merged.version}); using default`);
      warnedBadProfiles.add(key);
    }
    return { ...DEFAULTS[id] };   // fresh copy — never a shared DEFAULTS reference
  }
}

export function resolveNodeModel(id: NodeId): string {
  const p = getNodeProfile(id);
  return resolveModelId(p.tier, p.version);   // always resolvable — getNodeProfile guarantees it
}

// The node's *default* tier, independent of any NODE_PROFILE_OVERRIDES in env.
// Single source of truth for tooling (e.g. the sweep's baseline cost weight) that
// must not hardcode the node→tier mapping and drift when DEFAULTS change.
export function defaultTierForNode(id: NodeId): ModelTier {
  return DEFAULTS[id].tier;
}
