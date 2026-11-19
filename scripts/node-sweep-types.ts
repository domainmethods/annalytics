import type { NodeId, ThinkingLevel } from '../src/agents/nodeProfiles.js';
import type { ModelTier } from '../src/agents/modelConfig.js';

export type { NodeId };

export type SweepFailure =
  | { category: 'provider'; code: 'model-request' | 'judge-request' }
  | { category: 'reference' | 'warehouse' | 'candidate'; code: 'sql-validation' | 'sql-lineage' | 'sql-execution' | 'sql-result-limit' }
  | { category: 'candidate'; code: 'agent-output' | 'classifier-fallback' | 'intake-timeout' };

export function exhaustionRate(entries: { exhausted?: boolean }[]): number {
  return entries.filter(entry => entry.exhausted).length / (entries.length || 1);
}

/**
 * A concrete point in the (model, thinking) search space — the thing a sweep pins
 * NODE_PROFILE_OVERRIDES to for one corpus pass. Structurally identical to a
 * nodeProfiles override entry, so it can be written straight into the env.
 */
export interface SweepProfile {
  tier: ModelTier;
  version: string;
  thinkingLevel: ThinkingLevel;
}

export function formatSweepProfile({ tier, version, thinkingLevel }: SweepProfile): string {
  return `${tier}/${version}@${thinkingLevel}`;
}

/**
 * One evaluated point: its human-readable label plus the four numbers the decision
 * rule weighs. `metric` is the node's own quality proxy; `e2e` is the end-to-end
 * judge score; `p95LatencyMs` and `cost` are the trade-off levers.
 */
export interface PointScore {
  label: string;
  metric: number;
  e2e: number;
  p95LatencyMs: number;
  cost: number;
  exhaustionRate?: number;
}
