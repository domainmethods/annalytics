import { ApiError, GoogleGenAI, ThinkingLevel } from '@google/genai';
import { listAllRegisteredModels, resolveModelId } from '../src/agents/modelConfig.js';
import { NODE_IDS, defaultProfileForNode, type NodeId } from '../src/agents/nodeProfiles.js';
import { diffModels, formatRegistryStub, isTextGenerationModel, probeThinkingLevels } from './model-discover-core.js';

async function main(): Promise<void> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error('GEMINI_API_KEY is required.');
    process.exitCode = 1;
    return;
  }

  const ai = new GoogleGenAI({ apiKey });
  const liveIds: string[] = [];
  for await (const model of await ai.models.list()) {
    const id = model.name?.replace(/^models\//, '');
    if (id && isTextGenerationModel(id) && model.supportedActions?.includes('generateContent')) {
      liveIds.push(id);
    }
  }

  const defaultIds = new Map<NodeId, string>(NODE_IDS.map(node => {
    const { tier, version } = defaultProfileForNode(node);
    return [node, resolveModelId(tier, version)];
  }));
  const diff = diffModels(liveIds, listAllRegisteredModels(), defaultIds);
  console.log(JSON.stringify(diff, null, 2));

  for (const id of diff.added) {
    let incomplete = false;
    const levels = await probeThinkingLevels(id, async (model, level) => {
      try {
        await ai.models.generateContent({
          model,
          contents: 'Say OK.',
          config: {
            maxOutputTokens: 1,
            thinkingConfig: { thinkingLevel: ThinkingLevel[level.toUpperCase() as keyof typeof ThinkingLevel] },
          },
        });
      } catch (error) {
        if (!(error instanceof ApiError) || error.status !== 400) {
          incomplete = true;
          const reason = error instanceof ApiError ? `HTTP ${error.status}` : 'request failed';
          console.error(`Probe failed for ${model} at ${level} (${reason}).`);
        }
        throw error;
      }
    });
    if (incomplete) {
      process.exitCode = 1;
    } else {
      console.log(formatRegistryStub(id, levels));
    }
  }
}

main().catch((error: unknown) => {
  const reason = error instanceof ApiError ? ` (HTTP ${error.status})` : '';
  console.error(`Model discovery failed${reason}.`);
  process.exitCode = 1;
});
