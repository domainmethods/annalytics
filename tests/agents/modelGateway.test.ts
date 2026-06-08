import { describe, it, expect, vi, afterEach } from 'vitest';

function fakeAi(usageMetadata?: unknown) {
  const generateContent = vi.fn(async () => ({ text: '{}', usageMetadata }));
  return { ai: { models: { generateContent } } as any, generateContent };
}

describe('generateForNode', () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

  it('resolves the node model and passes the request through unchanged', async () => {
    const { generateForNode } = await import('../../src/agents/modelGateway.js');
    const { ai, generateContent } = fakeAi();
    await generateForNode('sqlGenerator', ai, { contents: [{ role: 'user', parts: [{ text: 'hi' }] }], config: { responseMimeType: 'application/json' } });
    const arg = generateContent.mock.calls[0][0];
    expect(arg.model).toBe('gemini-3.1-pro-preview');
    expect(arg.config.responseMimeType).toBe('application/json');
    expect(arg.config.thinkingConfig).toBeUndefined(); // default => omit
  });

  it('omits thinkingConfig when thinkingLevel is "default"', async () => {
    const { generateForNode } = await import('../../src/agents/modelGateway.js');
    const { ai, generateContent } = fakeAi();
    await generateForNode('clarification', ai, { contents: [] });
    expect(generateContent.mock.calls[0][0].config?.thinkingConfig).toBeUndefined();
  });

  it('sets thinkingConfig.thinkingLevel for each non-default level', async () => {
    vi.stubEnv('NODE_PROFILE_OVERRIDES', JSON.stringify({ clarification: { thinkingLevel: 'minimal' } }));
    const { generateForNode } = await import('../../src/agents/modelGateway.js');
    const { ai, generateContent } = fakeAi();
    await generateForNode('clarification', ai, { contents: [] });
    expect(generateContent.mock.calls[0][0].config.thinkingConfig).toEqual({ thinkingLevel: 'minimal' });
  });

  it('honors an explicit modelOverride', async () => {
    const { generateForNode } = await import('../../src/agents/modelGateway.js');
    const { ai, generateContent } = fakeAi();
    await generateForNode('sqlGenerator', ai, { contents: [] }, { modelOverride: 'gemini-3-flash-preview' });
    expect(generateContent.mock.calls[0][0].model).toBe('gemini-3-flash-preview');
  });

  it('does not throw when usageMetadata is undefined', async () => {
    const { generateForNode } = await import('../../src/agents/modelGateway.js');
    const { ai } = fakeAi(undefined);
    await expect(generateForNode('chart', ai, { contents: [] })).resolves.toBeDefined();
  });

  it('records per-node usage to an installed sink', async () => {
    const { generateForNode, withUsageSink } = await import('../../src/agents/modelGateway.js');
    const { ai } = fakeAi({ promptTokenCount: 10, candidatesTokenCount: 5, thoughtsTokenCount: 3 });
    const records: any[] = [];
    await withUsageSink((r) => records.push(r), async () => {
      await generateForNode('supervisor', ai, { contents: [] });
    });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ nodeId: 'supervisor', promptTokens: 10, candidatesTokens: 5, thoughtsTokens: 3 });
    expect(typeof records[0].latencyMs).toBe('number');
  });

  it('is a no-op when no sink is installed', async () => {
    const { generateForNode } = await import('../../src/agents/modelGateway.js');
    const { ai } = fakeAi({ promptTokenCount: 1 });
    await expect(generateForNode('supervisor', ai, { contents: [] })).resolves.toBeDefined();
  });
});
