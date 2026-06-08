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
    expect(() => resolveModelId('pro', '3.5')).toThrow(/no Gemini 3\.x model/i);
    expect(() => resolveModelId('flash-lite', '3')).toThrow(/no Gemini 3\.x model/i);
  });

  it('honors MODEL_ID_OVERRIDES for a (tier,version) pair', async () => {
    vi.stubEnv('MODEL_ID_OVERRIDES', JSON.stringify({ 'pro/3.1': 'gemini-3.1-pro-001' }));
    const { resolveModelId } = await import('../../src/agents/modelConfig.js');
    expect(resolveModelId('pro', '3.1')).toBe('gemini-3.1-pro-001');
  });
});

describe('listGemini3xModels — the sweep enumeration source of truth', () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

  it('enumerates EVERY published 3.x model (no silent subset)', async () => {
    const { listGemini3xModels, resolveModelId } = await import('../../src/agents/modelConfig.js');
    const models = listGemini3xModels();
    // The whole point of this helper: a sweep that walks it can never cover a
    // subset. There are exactly five real 3.x coordinates today — assert all five,
    // and that each one actually resolves to a model id.
    const keys = models.map((m) => `${m.tier}/${m.version}`).sort();
    expect(keys).toEqual(
      ['flash-lite/3.1', 'flash/3', 'flash/3.5', 'pro/3', 'pro/3.1'].sort(),
    );
    for (const m of models) {
      expect(() => resolveModelId(m.tier, m.version)).not.toThrow();
    }
  });

  it('orders cheapest tier first (flash-lite → flash → pro) so floor-up reads left to right', async () => {
    const { listGemini3xModels } = await import('../../src/agents/modelConfig.js');
    const tiers = listGemini3xModels().map((m) => m.tier);
    const rank: Record<string, number> = { 'flash-lite': 0, flash: 1, pro: 2 };
    for (let i = 1; i < tiers.length; i++) {
      expect(rank[tiers[i]]).toBeGreaterThanOrEqual(rank[tiers[i - 1]]);
    }
  });

  it('returns fresh arrays/objects so a caller cannot mutate the registry', async () => {
    const { listGemini3xModels } = await import('../../src/agents/modelConfig.js');
    const a = listGemini3xModels();
    a.pop();
    (a[0] as { tier: string }).tier = 'mutated';
    expect(listGemini3xModels()).toHaveLength(5);
    expect(listGemini3xModels()[0].tier).not.toBe('mutated');
  });
});
