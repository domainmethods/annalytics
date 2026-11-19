import { describe, it, expect, vi, afterEach } from 'vitest';

describe('agent model config', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('defaults Flash and Pro calls to pinned Gemini 3.x model ids', async () => {
    const { getFlashModel, getProModel } = await import('../../src/agents/modelConfig.js');

    expect(getFlashModel()).toBe('gemini-3-flash-preview');
    expect(getProModel()).toBe('gemini-3.1-pro-preview');
  });

  it('allows environment overrides for Flash and Pro model names', async () => {
    vi.stubEnv('GEMINI_FLASH_MODEL', 'gemini-3-flash-preview');
    vi.stubEnv('GEMINI_MODEL', 'gemini-3-pro-preview');

    const { getFlashModel, getProModel } = await import('../../src/agents/modelConfig.js');

    expect(getFlashModel()).toBe('gemini-3-flash-preview');
    expect(getProModel()).toBe('gemini-3-pro-preview');
  });
});

describe('Gemini 3.x model resolution', () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

  it('resolves explicit tier+version to the published 3.x id', async () => {
    const { resolveModelId } = await import('../../src/agents/modelConfig.js');
    expect(resolveModelId('pro', '3.1')).toBe('gemini-3.1-pro-preview');
    expect(resolveModelId('flash', '3')).toBe('gemini-3-flash-preview');
    expect(resolveModelId('flash-lite', '3.1')).toBe('gemini-3.1-flash-lite');
  });

  it('throws on a (tier,version) pair that is not a real model', async () => {
    const { resolveModelId } = await import('../../src/agents/modelConfig.js');
    expect(() => resolveModelId('pro', '3.5')).toThrow(/no registered Gemini model/i);
    expect(() => resolveModelId('flash-lite', '3')).toThrow(/no registered Gemini model/i);
  });

  it('honors MODEL_ID_OVERRIDES for a (tier,version) pair', async () => {
    vi.stubEnv('MODEL_ID_OVERRIDES', JSON.stringify({ 'pro/3.1': 'gemini-3.1-pro-001' }));
    const { resolveModelId } = await import('../../src/agents/modelConfig.js');
    expect(resolveModelId('pro', '3.1')).toBe('gemini-3.1-pro-001');
  });

  it('legacy override formats still resolve', async () => {
    vi.stubEnv('MODEL_ID_OVERRIDES', '{"flash/3":"x-model"}');
    const { resolveModelId } = await import('../../src/agents/modelConfig.js');
    expect(resolveModelId('flash', '3')).toBe('x-model');
  });
});

describe('registry metadata', () => {
  it('every registered model has positive input and output prices', async () => {
    const { listAllRegisteredModels } = await import('../../src/agents/modelConfig.js');
    for (const model of listAllRegisteredModels()) {
      expect(model.inputPricePerMTok).toBeGreaterThan(0);
      expect(model.outputPricePerMTok).toBeGreaterThan(0);
    }
  });

  it('listRegisteredModels excludes retired', async () => {
    const { listAllRegisteredModels, listRegisteredModels, getRegisteredModel } =
      await import('../../src/agents/modelConfig.js');
    const all = listAllRegisteredModels();
    const active = listRegisteredModels();
    for (const { tier, version } of active) {
      expect(getRegisteredModel(tier, version)!.status).not.toBe('retired');
    }
    expect(all.length).toBeGreaterThanOrEqual(active.length);
  });

  it('no registered id ends with -latest', async () => {
    const { listAllRegisteredModels } = await import('../../src/agents/modelConfig.js');
    for (const { id } of listAllRegisteredModels()) {
      expect(id).not.toMatch(/-latest$/);
    }
  });
});

describe('listRegisteredModels — the sweep enumeration source of truth', () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

  it('enumerates EVERY published 3.x model (no silent subset)', async () => {
    const { listRegisteredModels, resolveModelId } = await import('../../src/agents/modelConfig.js');
    const models = listRegisteredModels();
    // The whole point of this helper: a sweep that walks it can never cover a
    // subset. There are exactly four real 3.x coordinates today — assert all four,
    // and that each one actually resolves to a model id.
    const keys = models.map((m) => `${m.tier}/${m.version}`).sort();
    expect(keys).toEqual(
      ['flash-lite/3.1', 'flash/3', 'flash/3.5', 'pro/3.1'].sort(),
    );
    for (const m of models) {
      expect(() => resolveModelId(m.tier, m.version)).not.toThrow();
    }
  });

  it('orders cheapest tier first (flash-lite → flash → pro) so floor-up reads left to right', async () => {
    const { listRegisteredModels } = await import('../../src/agents/modelConfig.js');
    const tiers = listRegisteredModels().map((m) => m.tier);
    const rank: Record<string, number> = { 'flash-lite': 0, flash: 1, pro: 2 };
    for (let i = 1; i < tiers.length; i++) {
      expect(rank[tiers[i]]).toBeGreaterThanOrEqual(rank[tiers[i - 1]]);
    }
  });

  it('returns fresh arrays/objects so a caller cannot mutate the registry', async () => {
    const { listRegisteredModels } = await import('../../src/agents/modelConfig.js');
    const a = listRegisteredModels();
    a.pop();
    (a[0] as { tier: string }).tier = 'mutated';
    expect(listRegisteredModels()).toHaveLength(4);
    expect(listRegisteredModels()[0].tier).not.toBe('mutated');
  });
});

describe('getSupportedThinkingLevels — per-model thinking_level capability', () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

  it('reports pro/3.1 does NOT support `minimal` (the one asymmetric model)', async () => {
    const { getSupportedThinkingLevels } = await import('../../src/agents/modelConfig.js');
    const pro = getSupportedThinkingLevels('pro', '3.1');
    expect(pro).not.toContain('minimal');           // Gemini 3.1 Pro: minimal "Not supported"
    expect(pro).toEqual(['low', 'medium', 'high']);  // low/medium/high all Supported
  });

  it('reports every Flash-family model supports all four discrete levels (incl. `minimal`)', async () => {
    const { getSupportedThinkingLevels } = await import('../../src/agents/modelConfig.js');
    for (const [tier, version] of [['flash-lite', '3.1'], ['flash', '3'], ['flash', '3.5']] as const) {
      expect(getSupportedThinkingLevels(tier, version)).toEqual(['minimal', 'low', 'medium', 'high']);
    }
  });

  it('omits `default` from the discrete set — it is the omit-thinkingConfig sentinel, universally safe', async () => {
    const { getSupportedThinkingLevels } = await import('../../src/agents/modelConfig.js');
    for (const [tier, version] of [['pro', '3.1'], ['flash-lite', '3.1']] as const) {
      expect(getSupportedThinkingLevels(tier, version)).not.toContain('default');
    }
  });

  it('every registered model declares its thinking levels', async () => {
    const { listAllRegisteredModels, getSupportedThinkingLevels } =
      await import('../../src/agents/modelConfig.js');
    for (const { thinkingLevels } of listAllRegisteredModels()) {
      expect(thinkingLevels.length).toBeGreaterThan(0);
    }
    expect(getSupportedThinkingLevels('pro', '3.1')).not.toContain('minimal');
  });

  it('returns an empty set for an unknown coordinate (fail-closed for a non-registry model)', async () => {
    const { getSupportedThinkingLevels } = await import('../../src/agents/modelConfig.js');
    expect(getSupportedThinkingLevels('pro', '3.5')).toEqual([]);
  });
});
