import {
  resolveModelId,
  getSupportedThinkingLevels,
  type ModelTier,
  type ThinkingLevel,
} from './modelConfig.js';

export type NodeId =
  | 'clarification' | 'ambiguityClassifier' | 'slackIntake' | 'followUpClassifier' | 'dbtStatus'
  | 'metaQuestion' | 'chart' | 'sqlGenerator' | 'supervisor'
  | 'discrepancy' | 'teachingCandidate' | 'summaryOverride';

// ThinkingLevel now lives in modelConfig (next to the model registry it
// pairs with). Re-export so the existing importers — node-sweep-types, universal-sweep,
// the sweep tests — keep their `from './nodeProfiles.js'` import unchanged.
export type { ThinkingLevel };

export interface NodeProfile {
  tier: ModelTier;
  version: string;            // resolved via the model registry
  thinkingLevel: ThinkingLevel;
}

// Shared constants — safe because getNodeProfile NEVER hands out a DEFAULTS
// reference directly; every return is a fresh spread (see below).
//
// Classifiers, sized on the frozen tv-v1 set (2026-11-22, ε 0.01):
//  - slackIntake: flash-lite/3.5@low. The sweep picked flash-lite/3.1@minimal (1.000);
//    flash-lite/3.5 also scored 1.000 (at high, p95 2.5s). The owner kept 3.5 because
//    Google lists it as the replacement for gemini-3.1-flash-lite, which has an earliest
//    shutdown of 2027-05-07. @low is from the 2026-11-19 pilot (0.975) and was not
//    re-walked on the frozen set. Gemini 4 Pro models lose on the 8s intake budget.
//  - followUpClassifier: flash/4-hydrogen@low. Stage 1 put Hydrogen at 1.000 at high
//    (p95 3.6s; the old default scored 0.889 at high). The sweep's cost pick was
//    flash/3@medium (1.000, p95 6.5s); the owner chose Hydrogen because Google lists
//    gemini-3-flash-preview as superseded by gemini-3.6-flash. A Hydrogen thinking walk
//    (same day, ε 0.01) scored low, medium, high and default all 1.000; low was fastest
//    (p95 3.0s vs 4.3-4.8s at high) and cheapest (~30% below high).
//  - ambiguityClassifier: flash/4-hydrogen@low, sized on tv-v2 (79 items, 2026-11-22,
//    ε 0.025). Stage 1 put Hydrogen first at high (0.861; the old flash-lite/3.5@low
//    default scored ~0.65). Hydrogen's thinking walk: high 0.861 (p95 11.5s), medium and
//    default 0.823 (~7.8s), low 0.810 (4.7s). The sweep's pick is @high; the owner chose
//    @low for latency, accepting 0.051 below it, so @low is outside ε of the pick.
//    pro/4-carbon was not measured (provider timeouts on two attempts).
//
// The remaining levels are PROVISIONAL role-based HEURISTICS, not measured (tiers
// are NOT provisional — they encode real domain knowledge: flash for classify/format,
// pro for generate/review). Thinking scales with the openness of the reasoning —
//   minimal → closed-set classification / structured extraction / reformatting
//             (the classifiers above are excepted; see their notes)
//   low     → light judgment over provided context
//   default → hard open generation & critique (let the model manage its own budget)
// dbtStatus/chart/summaryOverride stay at flash/3 (un-measured: the universal corpus
// only labels intake + follow-up routing). The three pro reasoning nodes are corpus-
// limited on the SQL path (ε too large on the 12-question corpus to size safely) and
// stay model-managed — see docs/superpowers/plans/2026-06-07-node-sizing-eval-goal.md.
const CLASSIFIER_LITE: NodeProfile = { tier: 'flash-lite', version: '3.5', thinkingLevel: 'low' };
const HYDROGEN_LOW: NodeProfile = { tier: 'flash', version: '4-hydrogen', thinkingLevel: 'low' };
const FLASH_MINIMAL: NodeProfile = { tier: 'flash', version: '3', thinkingLevel: 'minimal' };
const FLASH_LOW: NodeProfile = { tier: 'flash', version: '3', thinkingLevel: 'low' };
const PRO_DEFAULT: NodeProfile = { tier: 'pro', version: '3.1', thinkingLevel: 'default' };

// DEFAULTS tag vocabulary: MEASURED | TEMPLATE-MEASURED | PROVISIONAL.
// Template-set results use MEASURED for install-invariant nodes and TEMPLATE-MEASURED
// for install-coupled starting points. PROVISIONAL denotes a heuristic pick.
const DEFAULTS: Record<NodeId, NodeProfile> = {
  // MEASURED — tv-v1, 2026-11-22. slackIntake's @low is from the pilot (its thinking
  // axis was not walked on the frozen set); followUpClassifier's @low is from a Hydrogen
  // thinking walk. Both models are owner overrides of the sweep's cost tie-break for
  // model-sunset risk; see the classifier notes above.
  slackIntake: CLASSIFIER_LITE, followUpClassifier: HYDROGEN_LOW,
  // MEASURED — tv-v2, 2026-11-22 (model). @low is an owner latency override of the
  // sweep's @high pick and sits outside ε of it; see the classifier notes above.
  ambiguityClassifier: HYDROGEN_LOW,
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
function warnProfileOnce(key: string, message: string): void {
  if (warnedBadProfiles.has(key)) return;
  console.warn(message);
  warnedBadProfiles.add(key);
}

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
  } catch {
    warnProfileOnce(
      `${id}:${merged.tier}/${merged.version}`,
      `NODE_PROFILE_OVERRIDES[${id}] resolves to no registered Gemini model (${merged.tier}/${merged.version}); using default`,
    );
    return { ...DEFAULTS[id] };   // fresh copy — never a shared DEFAULTS reference
  }
  // The model resolves, but a resolvable model can still REJECT the requested thinking
  // level — gemini-3.1-pro-preview does not serve `minimal`. isValidPartial only checks
  // the level is a valid STRING, not that this model accepts it; the gateway would pass
  // it straight through as a 400. Guard the (model, level) compatibility here, at the
  // config boundary. The incompatible level is often INHERITED, not chosen: a tier-only
  // override like {tier:'pro'} merges the default's leftover `minimal` onto a Pro model.
  // So COERCE the level to `default` (model-managed, universally safe) and KEEP the
  // explicitly-chosen model — reverting the whole profile would silently undo the user's
  // model choice, the most surprising outcome. `'default'` itself always passes the check.
  if (
    merged.thinkingLevel !== 'default' &&
    !getSupportedThinkingLevels(merged.tier, merged.version).includes(merged.thinkingLevel)
  ) {
    warnProfileOnce(
      `${id}:${merged.tier}/${merged.version}@${merged.thinkingLevel}`,
      `NODE_PROFILE_OVERRIDES[${id}] sets thinkingLevel '${merged.thinkingLevel}', which ${merged.tier}/${merged.version} does not support; using model-managed thinking (default)`,
    );
    return { ...merged, thinkingLevel: 'default' };   // keep the chosen model; safe thinking
  }
  return merged;
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

// The node's full default profile (tier+version+thinkingLevel), ignoring env
// overrides. A fresh copy so callers can't mutate DEFAULTS. Used by the sizing
// sweep to tell "a downsize the node didn't already run" apart from "the search
// landed back on the existing default".
export function defaultProfileForNode(id: NodeId): NodeProfile {
  return { ...DEFAULTS[id] };
}
