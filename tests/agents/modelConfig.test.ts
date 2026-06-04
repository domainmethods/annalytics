import { describe, it, expect, vi, afterEach } from 'vitest';

describe('agent model config', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('defaults Flash and Pro calls to available latest model aliases', async () => {
    const { getFlashModel, getProModel } = await import('../../src/agents/modelConfig.js');

    expect(getFlashModel()).toBe('gemini-flash-latest');
    expect(getProModel()).toBe('gemini-pro-latest');
  });

  it('allows environment overrides for Flash and Pro model names', async () => {
    vi.stubEnv('GEMINI_FLASH_MODEL', 'gemini-3-flash-preview');
    vi.stubEnv('GEMINI_MODEL', 'gemini-3-pro-preview');

    const { getFlashModel, getProModel } = await import('../../src/agents/modelConfig.js');

    expect(getFlashModel()).toBe('gemini-3-flash-preview');
    expect(getProModel()).toBe('gemini-3-pro-preview');
  });
});
