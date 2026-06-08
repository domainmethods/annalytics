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

  it('coerces an unsupported thinking level to `default` but KEEPS the explicitly-overridden model', async () => {
    // slackIntake's default is flash-lite/3.1@minimal. Override the model to pro/3.1,
    // which RESOLVES fine but rejects `minimal` (only the Flash family supports it).
    // isValidPartial passes the override (valid strings) and the resolvability guard
    // passes too (pro/3.1 is real) — only the NEW capability guard catches it. The fix
    // must honor the user's pro choice and drop the incompatible level to `default`,
    // NOT silently revert the whole profile back to the flash-lite default.
    vi.stubEnv('NODE_PROFILE_OVERRIDES', JSON.stringify({
      slackIntake: { tier: 'pro', version: '3.1', thinkingLevel: 'minimal' },
    }));
    const { getNodeProfile, resolveNodeModel } = await import('../../src/agents/nodeProfiles.js');
    expect(resolveNodeModel('slackIntake')).toBe('gemini-3.1-pro-preview'); // model PRESERVED, not reverted
    expect(getNodeProfile('slackIntake').thinkingLevel).toBe('default');     // level coerced off 'minimal'
  });

  it('coerces an INHERITED unsupported level when a tier-only override lands on an incompatible model', async () => {
    // The incompatible level is usually an accident of the merge: {tier:'pro',version:'3.1'}
    // with no thinkingLevel inherits slackIntake's default 'minimal' → pro/3.1@minimal.
    // The guard coerces to `default` so the bare model override still works end-to-end.
    vi.stubEnv('NODE_PROFILE_OVERRIDES', JSON.stringify({
      slackIntake: { tier: 'pro', version: '3.1' },
    }));
    const { getNodeProfile, resolveNodeModel } = await import('../../src/agents/nodeProfiles.js');
    expect(resolveNodeModel('slackIntake')).toBe('gemini-3.1-pro-preview');
    expect(getNodeProfile('slackIntake').thinkingLevel).toBe('default');
  });

  it('keeps an override whose thinking level IS supported by the resolved model', async () => {
    // pro/3.1 supports `low`, so this must pass through untouched (no over-eager rejection).
    vi.stubEnv('NODE_PROFILE_OVERRIDES', JSON.stringify({
      supervisor: { tier: 'pro', version: '3.1', thinkingLevel: 'low' },
    }));
    const { getNodeProfile } = await import('../../src/agents/nodeProfiles.js');
    expect(getNodeProfile('supervisor').thinkingLevel).toBe('low');
  });

  it('allows `default` thinking on any model — it is the universally-safe omit sentinel', async () => {
    // pro/3.1@default must never be rejected even though `default` is not a discrete API level.
    vi.stubEnv('NODE_PROFILE_OVERRIDES', JSON.stringify({
      supervisor: { tier: 'pro', version: '3.1', thinkingLevel: 'default' },
    }));
    const { getNodeProfile } = await import('../../src/agents/nodeProfiles.js');
    expect(getNodeProfile('supervisor').thinkingLevel).toBe('default');
  });
});
