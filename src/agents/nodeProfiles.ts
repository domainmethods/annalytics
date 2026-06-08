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
const FLASH_DEFAULT: NodeProfile = { tier: 'flash', version: '3', thinkingLevel: 'default' };
const PRO_DEFAULT: NodeProfile = { tier: 'pro', version: '3.1', thinkingLevel: 'default' };

const DEFAULTS: Record<NodeId, NodeProfile> = {
  clarification: FLASH_DEFAULT, slackIntake: FLASH_DEFAULT, followUpClassifier: FLASH_DEFAULT,
  dbtStatus: FLASH_DEFAULT, metaQuestion: FLASH_DEFAULT, chart: FLASH_DEFAULT, teachingCandidate: FLASH_DEFAULT,
  summaryOverride: FLASH_DEFAULT,
  sqlGenerator: PRO_DEFAULT, supervisor: PRO_DEFAULT, discrepancy: PRO_DEFAULT,
};

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

function loadOverrides(): Partial<Record<NodeId, Partial<NodeProfile>>> {
  const raw = process.env.NODE_PROFILE_OVERRIDES;
  if (!raw) return {};
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
