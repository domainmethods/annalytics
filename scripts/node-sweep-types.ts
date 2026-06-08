import type { NodeId, ThinkingLevel } from '../src/agents/nodeProfiles.js';
import type { ModelTier } from '../src/agents/modelConfig.js';

export type { NodeId };

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
}
