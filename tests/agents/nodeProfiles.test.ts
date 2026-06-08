import { describe, it, expect, vi, afterEach } from 'vitest';

// flash/3 nodes — the un-measured minimal/low roles still pinned to flash-preview.
const FLASH_NODES = ['clarification','dbtStatus','metaQuestion','chart','teachingCandidate','summaryOverride'] as const;
// MEASURED classifier nodes — the judge-free floor-up sweep found them perfect at
// every rung, so the cheapest model (flash-lite/3.1) is the right-sized default.
const CLASSIFIER_LITE_NODES = ['slackIntake','followUpClassifier'] as const;
const PRO_NODES = ['sqlGenerator','supervisor','discrepancy'] as const;

describe('nodeProfiles', () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

  it('defaults every un-measured Flash node to gemini-3-flash-preview', async () => {
    const { resolveNodeModel } = await import('../../src/agents/nodeProfiles.js');
    for (const n of FLASH_NODES) expect(resolveNodeModel(n)).toBe('gemini-3-flash-preview');
  });

  it('defaults the measured classifier nodes to gemini-3.1-flash-lite (floor-up pick)', async () => {
    const { resolveNodeModel } = await import('../../src/agents/nodeProfiles.js');
    for (const n of CLASSIFIER_LITE_NODES) expect(resolveNodeModel(n)).toBe('gemini-3.1-flash-lite');
  });

  it('defaults every Pro node to gemini-3.1-pro-preview', async () => {
    const { resolveNodeModel } = await import('../../src/agents/nodeProfiles.js');
    for (const n of PRO_NODES) expect(resolveNodeModel(n)).toBe('gemini-3.1-pro-preview');
  });

  it('assigns provisional role-based thinking levels (minimal/low for flash, default for pro)', async () => {
    const { getNodeProfile } = await import('../../src/agents/nodeProfiles.js');
    // minimal — closed-set routing / structured selection / reformatting
    for (const n of ['slackIntake', 'followUpClassifier', 'dbtStatus', 'chart', 'summaryOverride'] as const) {
      expect(getNodeProfile(n).thinkingLevel).toBe('minimal');
    }
    // low — light open judgment over provided context
    for (const n of ['clarification', 'metaQuestion', 'teachingCandidate'] as const) {
      expect(getNodeProfile(n).thinkingLevel).toBe('low');
    }
    // default — hard reasoning nodes stay model-managed
    for (const n of PRO_NODES) expect(getNodeProfile(n).thinkingLevel).toBe('default');
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
