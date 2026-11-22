import { existsSync } from 'node:fs';
import { ApiError, GoogleGenAI, ThinkingLevel } from '@google/genai';
import { listAllRegisteredModels } from '../src/agents/modelConfig.js';
import { diffModels, discoveryExitCode, formatRegistryStub, isTextGenerationModel, probeThinkingLevels, sunsetWarnings, templateDefaultIds } from './model-discover-core.js';

async function main(): Promise<void> {
  if (existsSync('.env') && typeof process.loadEnvFile === 'function') {
    process.loadEnvFile('.env');
  }
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

  const registry = listAllRegisteredModels();
  const defaults = templateDefaultIds();
  const diff = diffModels(liveIds, registry, defaults);
  const sunsets = sunsetWarnings(registry, defaults, new Date());
  process.exitCode = discoveryExitCode(diff, sunsets);
  if (sunsets.length > 0) {
    console.error('Registered models with a Google deprecation notice');
    for (const { notice, usedByDefaults, daysLeft } of sunsets) {
      const nodes = usedByDefaults.length > 0 ? usedByDefaults.join(', ') : 'none';
      const days = daysLeft === undefined ? '' : ` (${daysLeft} days)`;
      console.error(`- ${notice}${days} (template defaults: ${nodes})`);
    }
  }
  if (diff.missing.length > 0) {
    console.error('Missing registered models');
    for (const { id, usedByDefaults } of diff.missing) {
      const nodes = usedByDefaults.length > 0 ? usedByDefaults.join(', ') : 'none';
      console.error(`- ${id} (template defaults: ${nodes})`);
    }
  }
  console.log(JSON.stringify(diff, null, 2));

  const incomplete: string[] = [];
  for (const id of diff.added) {
    const failureReasons = new Set<string>();
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
          failureReasons.add(error instanceof ApiError ? `HTTP ${error.status}` : 'request failed');
        }
        throw error;
      }
    });
    if (failureReasons.size > 0) {
      incomplete.push(`- ${id} (${[...failureReasons].join(', ')})`);
    } else {
      console.log(formatRegistryStub(id, levels));
    }
  }
  if (incomplete.length > 0) {
    console.error(['Probe incomplete', ...incomplete].join('\n'));
  }
}

main().catch((error: unknown) => {
  const reason = error instanceof ApiError ? ` (HTTP ${error.status})` : '';
  console.error(`Model discovery failed${reason}.`);
  process.exitCode = 1;
});
