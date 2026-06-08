import { describe, it, expect, vi, afterEach } from 'vitest';

const FLASH_NODES = ['clarification','slackIntake','followUpClassifier','dbtStatus','metaQuestion','chart','teachingCandidate','summaryOverride'] as const;
const PRO_NODES = ['sqlGenerator','supervisor','discrepancy'] as const;

describe('nodeProfiles', () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

  it('defaults every Flash node to gemini-3-flash-preview', async () => {
    const { resolveNodeModel } = await import('../../src/agents/nodeProfiles.js');
    for (const n of FLASH_NODES) expect(resolveNodeModel(n)).toBe('gemini-3-flash-preview');
  });

  it('defaults every Pro node to gemini-3.1-pro-preview', async () => {
    const { resolveNodeModel } = await import('../../src/agents/nodeProfiles.js');
    for (const n of PRO_NODES) expect(resolveNodeModel(n)).toBe('gemini-3.1-pro-preview');
  });

  it('defaults thinkingLevel to "default" (omit) for every node', async () => {
    const { getNodeProfile } = await import('../../src/agents/nodeProfiles.js');
    expect(getNodeProfile('clarification').thinkingLevel).toBe('default');
  });

  it('deep-merges a valid override over defaults', async () => {
    vi.stubEnv('NODE_PROFILE_OVERRIDES', JSON.stringify({
      clarification: { tier: 'flash-lite', version: '3.1', thinkingLevel: 'minimal' },
    }));
    const { getNodeProfile, resolveNodeModel } = await import('../../src/agents/nodeProfiles.js');
    expect(resolveNodeModel('clarification')).toBe('gemini-3.1-flash-lite');
    expect(getNodeProfile('clarification').thinkingLevel).toBe('minimal');
    // untouched node keeps its default
    expect(resolveNodeModel('sqlGenerator')).toBe('gemini-3.1-pro-preview');
  });

  it('ignores a malformed override and falls back to defaults', async () => {
    vi.stubEnv('NODE_PROFILE_OVERRIDES', '{ not valid json');
    const { resolveNodeModel } = await import('../../src/agents/nodeProfiles.js');
    expect(resolveNodeModel('clarification')).toBe('gemini-3-flash-preview');
  });

  it('drops an individual invalid override entry but keeps valid ones', async () => {
    vi.stubEnv('NODE_PROFILE_OVERRIDES', JSON.stringify({
      clarification: { tier: 'banana' },                  // invalid tier
      supervisor: { thinkingLevel: 'low' },               // valid partial
    }));
    const { getNodeProfile, resolveNodeModel } = await import('../../src/agents/nodeProfiles.js');
    expect(resolveNodeModel('clarification')).toBe('gemini-3-flash-preview'); // dropped
    expect(getNodeProfile('supervisor').thinkingLevel).toBe('low');           // kept
  });

  it('falls back to default when a well-shaped override names an unresolvable model', async () => {
    vi.stubEnv('NODE_PROFILE_OVERRIDES', JSON.stringify({
      sqlGenerator: { tier: 'pro', version: '3.5', thinkingLevel: 'low' }, // shape ok, no pro/3.5 model
    }));
    const { resolveNodeModel } = await import('../../src/agents/nodeProfiles.js');
    expect(resolveNodeModel('sqlGenerator')).toBe('gemini-3.1-pro-preview'); // default, no throw
  });

  it('falls back when a tier-only override inherits an incompatible version', async () => {
    // {tier:'flash-lite'} merges with the flash default's version '3' → 'flash-lite/3', which has no model.
    vi.stubEnv('NODE_PROFILE_OVERRIDES', JSON.stringify({ clarification: { tier: 'flash-lite' } }));
    const { resolveNodeModel } = await import('../../src/agents/nodeProfiles.js');
    expect(resolveNodeModel('clarification')).toBe('gemini-3-flash-preview'); // default, no throw
  });
});
