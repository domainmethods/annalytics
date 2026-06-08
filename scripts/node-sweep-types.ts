import type { NodeId, ThinkingLevel } from '../src/agents/nodeProfiles.js';
import type { ModelTier } from '../src/agents/modelConfig.js';

export interface LadderRung { rung: string; tier: ModelTier; version: string; thinkingLevel: ThinkingLevel; }

export const DEFAULT_LADDER: LadderRung[] = [
  { rung: 'R0', tier: 'flash-lite', version: '3.1', thinkingLevel: 'minimal' },
  { rung: 'R1', tier: 'flash-lite', version: '3.1', thinkingLevel: 'low' },
  { rung: 'R2', tier: 'flash', version: '3', thinkingLevel: 'minimal' },
  { rung: 'R3', tier: 'flash', version: '3', thinkingLevel: 'medium' },
  { rung: 'R4', tier: 'pro', version: '3.1', thinkingLevel: 'low' },
  { rung: 'R5', tier: 'pro', version: '3.1', thinkingLevel: 'high' },
];

export interface RungScore { rung: string; metric: number; e2e: number; p95LatencyMs: number; cost: number; }
export interface NodeRecommendation { nodeId: NodeId; baseline: RungScore; chosen: RungScore; allViable: RungScore[]; }
