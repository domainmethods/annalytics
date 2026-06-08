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
