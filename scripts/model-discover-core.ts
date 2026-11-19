import type { RegisteredModel, ThinkingLevel } from '../src/agents/modelConfig.js';
import type { NodeId } from '../src/agents/nodeProfiles.js';

const THINKING_LEVELS = ['minimal', 'low', 'medium', 'high'] satisfies Exclude<ThinkingLevel, 'default'>[];

export function isTextGenerationModel(id: string): boolean {
  return id.startsWith('gemini-') && !id.endsWith('-latest') &&
    !/-(image|tts|transcribe|computer-use|robotics|nano-banana|omni|customtools|embedding)(-|$)/.test(id);
}

export interface ModelDiff {
  added: string[];
  missing: { id: string; usedByDefaults: NodeId[] }[];
  unchanged: string[];
}

export function diffModels(liveIds: string[], registry: RegisteredModel[], defaultIds: Map<NodeId, string>): ModelDiff {
  const live = new Set(liveIds);
  const registered = new Set(registry.map(({ id }) => id));
  return {
    added: [...live].filter(id => !registered.has(id)).sort(),
    missing: [...registered].filter(id => !live.has(id)).sort().map(id => ({
      id,
      usedByDefaults: [...defaultIds].filter(([, modelId]) => modelId === id).map(([node]) => node),
    })),
    unchanged: [...live].filter(id => registered.has(id)).sort(),
  };
}

export function discoveryExitCode(diff: ModelDiff): 0 | 1 {
  return diff.missing.length > 0 ? 1 : 0;
}

export async function probeThinkingLevels(id: string, call: (id: string, level: string) => Promise<void>): Promise<string[]> {
  const accepted: string[] = [];
  for (const level of THINKING_LEVELS) {
    try {
      await call(id, level);
      accepted.push(level);
    } catch {
      // A rejected request leaves this level out of the result.
    }
  }
  return accepted;
}

export function formatRegistryStub(id: string, levels: string[]): string {
  const quote = (value: string) => `'${value.replace(/['\\]/g, '\\$&')}'`;
  return `  'tier/version': { // TODO
    tier: 'flash', // TODO
    version: 'version', // TODO
    id: ${quote(id)},
    thinkingLevels: [${levels.map(quote).join(', ')}],
    inputPricePerMTok: 0, // TODO
    outputPricePerMTok: 0, // TODO
    status: 'candidate',
  },`;
}
