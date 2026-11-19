import { expect, test, vi } from 'vitest';
import { listAllRegisteredModels, type RegisteredModel } from '../../src/agents/modelConfig.js';
import { diffModels, discoveryExitCode, formatRegistryStub, isTextGenerationModel, probeThinkingLevels, templateDefaultIds } from '../../scripts/model-discover-core.js';

test('isTextGenerationModel excludes non-text and aliases', () => {
  const excluded = [
    'gemini-3-pro-image',
    'gemini-3.8-flash-tts',
    'gemini-3.5-transcribe',
    'gemini-2.5-computer-use-preview-10-2025',
    'gemini-robotics-er-2-preview',
    'gemini-nano-banana-2.1',
    'gemini-omni-1.2-flash',
    'gemini-3.1-pro-preview-customtools',
    'gemini-flash-latest',
  ];
  for (const id of excluded) expect(isTextGenerationModel(id), id).toBe(false);
  for (const id of ['gemini-3.8-flash', 'gemini-4-neon', 'gemini-3.5-flash-lite']) {
    expect(isTextGenerationModel(id), id).toBe(true);
  }
});

test('diffModels flags missing models referenced by defaults', () => {
  const registered: RegisteredModel = {
    tier: 'flash',
    version: '3',
    id: 'gemini-3-flash-preview',
    thinkingLevels: ['low'],
    inputPricePerMTok: 0.50,
    outputPricePerMTok: 3.00,
    status: 'default-eligible',
  };
  const retired = { ...registered, id: 'gemini-2.0-flash', status: 'retired' } as const;
  expect(diffModels(['gemini-3.8-flash', retired.id], [registered, retired], new Map([
    ['dbtStatus', registered.id],
  ]))).toEqual({
    added: ['gemini-3.8-flash'],
    missing: [{ id: 'gemini-3-flash-preview', usedByDefaults: ['dbtStatus'] }],
    unchanged: [retired.id],
  });
});

test('template defaults identify the missing registry model under a runtime override', () => {
  vi.stubEnv('MODEL_ID_OVERRIDES', JSON.stringify({ 'flash/3': 'gemini-3.8-flash' }));
  try {
    const registry = listAllRegisteredModels();
    const liveIds = registry.map(({ id }) => id).filter(id => id !== 'gemini-3-flash-preview');
    liveIds.push('gemini-3.8-flash');

    const { missing } = diffModels(liveIds, registry, templateDefaultIds());
    expect(missing[0]?.id).toBe('gemini-3-flash-preview');
    expect(missing[0]?.usedByDefaults).toContain('dbtStatus');
  } finally {
    vi.unstubAllEnvs();
  }
});

test('discoveryExitCode signals a missing model', () => {
  expect(discoveryExitCode({
    added: ['gemini-3.8-flash'],
    missing: [{ id: 'gemini-3-flash-preview', usedByDefaults: ['dbtStatus'] }],
    unchanged: [],
  })).toBe(1);
});

test('discoveryExitCode succeeds with additions only', () => {
  expect(discoveryExitCode({ added: ['gemini-3.8-flash'], missing: [], unchanged: [] })).toBe(0);
});

test('probeThinkingLevels records rejected levels', async () => {
  const id = 'gemini-3.8-flash';
  const attempts: [string, string][] = [];
  const levels = await probeThinkingLevels(id, async (model, level) => {
    attempts.push([model, level]);
    if (level === 'minimal') throw new Error('unsupported');
  });

  expect(attempts).toEqual(['minimal', 'low', 'medium', 'high'].map(level => [id, level]));
  expect(levels).toEqual(['low', 'medium', 'high']);
});

test('formatRegistryStub emits a candidate entry with TODO placeholders', () => {
  expect(formatRegistryStub('gemini-4-neon', ['low', 'high'])).toBe(`  'tier/version': { // TODO
    tier: 'flash', // TODO
    version: 'version', // TODO
    id: 'gemini-4-neon',
    thinkingLevels: ['low', 'high'],
    inputPricePerMTok: 0, // TODO
    outputPricePerMTok: 0, // TODO
    status: 'candidate',
  },`);
});

test('discovery reports a missing retired model without failing when no default uses it', () => {
  const retired: RegisteredModel = {
    tier: 'flash', version: '2.0', id: 'gemini-2.0-flash', status: 'retired',
    thinkingLevels: [], inputPricePerMTok: 0, outputPricePerMTok: 0,
  };
  const diff = diffModels([], [retired], new Map());
  expect(diff.missing).toEqual([{ id: retired.id, usedByDefaults: [] }]);
  expect(discoveryExitCode(diff)).toBe(0);
});
