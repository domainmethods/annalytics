import { describeSunset, getRegisteredModel, type RegisteredModel, type ThinkingLevel } from '../src/agents/modelConfig.js';
import { NODE_IDS, defaultProfileForNode, type NodeId } from '../src/agents/nodeProfiles.js';

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

export function templateDefaultIds(): Map<NodeId, string> {
  return new Map(NODE_IDS.map(node => {
    const { tier, version } = defaultProfileForNode(node);
    const model = getRegisteredModel(tier, version);
    if (!model) throw new Error(`No registered Gemini model for template default ${node} (${tier}/${version}).`);
    return [node, model.id];
  }));
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

export interface SunsetWarning {
  id: string;
  notice: string;
  usedByDefaults: NodeId[];
  /** Days until the earliest shutdown; undefined when Google gives no date. */
  daysLeft?: number;
}

/** A template default this close to its model's shutdown fails discovery. */
export const SUNSET_FAIL_DAYS = 90;

export function sunsetWarnings(registry: RegisteredModel[], defaultIds: Map<NodeId, string>, today: Date): SunsetWarning[] {
  const day = 24 * 60 * 60 * 1000;
  return registry.filter(model => model.status !== 'retired' && model.sunset).map(model => {
    const shutdown = model.sunset?.shutdownDate;
    return {
      id: model.id,
      notice: describeSunset(model)!,
      usedByDefaults: [...defaultIds].filter(([, modelId]) => modelId === model.id).map(([node]) => node),
      ...(shutdown && { daysLeft: Math.ceil((Date.parse(`${shutdown}T00:00:00Z`) - today.getTime()) / day) }),
    };
  }).sort((a, b) => a.id.localeCompare(b.id));
}

export function discoveryExitCode(diff: ModelDiff, sunsets: SunsetWarning[] = []): 0 | 1 {
  const missingDefault = diff.missing.some(({ usedByDefaults }) => usedByDefaults.length > 0);
  const imminentDefault = sunsets.some(({ usedByDefaults, daysLeft }) =>
    usedByDefaults.length > 0 && daysLeft !== undefined && daysLeft <= SUNSET_FAIL_DAYS);
  return missingDefault || imminentDefault ? 1 : 0;
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
