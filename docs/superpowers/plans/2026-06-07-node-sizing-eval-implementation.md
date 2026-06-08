# Per-Node Model Sizing Eval — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make per-node Gemini model + thinking level a runtime config wired into all ~10 agents, then add a coordinate-descent sweep that recommends the smallest viable `(model, thinkingLevel)` per node.

**Architecture:** A `nodeProfiles` registry (NodeId → profile, defaults = pinned Gemini 3.x) and a thin `generateForNode` seam replace the hardcoded `getFlashModel()`/`getProModel()` call sites. The seam resolves the profile, applies `thinkingConfig.thinkingLevel`, and emits per-node token/latency telemetry via `AsyncLocalStorage` (no-op in prod). A dev-only `scripts/node-sweep.ts` drives the existing benchmark corpus one node at a time and applies the latency≻quality≻cost decision rule.

**Tech Stack:** TypeScript (ESM, `module: NodeNext`), `@google/genai` v1.41+, vitest, tsx. Reuses `scripts/benchmark*.ts`.

**Design doc:** `docs/superpowers/plans/2026-06-07-node-sizing-eval-design.md` — read it first.

**Conventions for this repo:**
- Tests mirror source under `tests/` with `.test.ts`. Pure functions tested without mocks.
- `GoogleGenAI` mocks **must use class syntax** (`new`-ed). `vi.clearAllMocks()` then re-setup in `beforeEach`.
- Run a single test: `npx vitest run tests/path/file.test.ts`. Typecheck: `npm run typecheck`.
- Commit messages end with the `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` trailer.

---

## PR 1 — Runtime layer (registry + seam + agent wiring)

### Task 1: Extend `modelConfig.ts` with the explicit Gemini 3.x model map

**Files:**
- Modify: `src/agents/modelConfig.ts`
- Test: `tests/agents/modelConfig.test.ts`

**Step 1: Write the failing tests** (append to the existing describe block)

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';

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
```

**Step 2: Run to verify failure**
Run: `npx vitest run tests/agents/modelConfig.test.ts`
Expected: FAIL — `resolveModelId` is not exported.

**Step 3: Implement** — add to `src/agents/modelConfig.ts` (keep the existing `getFlashModel`/`getProModel`/`getJudgeModel` exports unchanged for now; they are removed in Task 4 once nothing imports them):

```ts
export type ModelTier = 'flash-lite' | 'flash' | 'pro';

// Sparse, real Gemini 3.x lineup. Keys are `${tier}/${version}`.
// Verify exact ids against the live model list before first deploy.
const GEMINI_3X_MODELS: Record<string, string> = {
  'flash-lite/3.1': 'gemini-3.1-flash-lite',
  'flash/3': 'gemini-3-flash-preview',
  'flash/3.5': 'gemini-3.5-flash',
  'pro/3': 'gemini-3-pro-preview',
  'pro/3.1': 'gemini-3.1-pro-preview',
};

function modelIdOverrides(): Record<string, string> {
  const raw = process.env.MODEL_ID_OVERRIDES;
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

export function resolveModelId(tier: ModelTier, version: string): string {
  const key = `${tier}/${version}`;
  const override = modelIdOverrides()[key];
  if (override) return override;
  const id = GEMINI_3X_MODELS[key];
  if (!id) throw new Error(`no Gemini 3.x model for tier=${tier} version=${version}`);
  return id;
}
```

**Step 4: Run to verify pass**
Run: `npx vitest run tests/agents/modelConfig.test.ts`
Expected: PASS (including the pre-existing flash/pro/judge tests).

**Step 5: Commit**
```bash
git add src/agents/modelConfig.ts tests/agents/modelConfig.test.ts
git commit -m "feat: explicit Gemini 3.x model map + resolveModelId

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: `nodeProfiles` registry

**Files:**
- Create: `src/agents/nodeProfiles.ts`
- Test: `tests/agents/nodeProfiles.test.ts`

**Step 1: Write the failing tests**

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';

const FLASH_NODES = ['clarification','slackIntake','followUpClassifier','dbtStatus','metaQuestion','chart','teachingCandidate'] as const;
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
});
```

**Step 2: Run to verify failure**
Run: `npx vitest run tests/agents/nodeProfiles.test.ts`
Expected: FAIL — module not found.

**Step 3: Implement** `src/agents/nodeProfiles.ts`

```ts
import { resolveModelId, type ModelTier } from './modelConfig.js';

export type NodeId =
  | 'clarification' | 'slackIntake' | 'followUpClassifier' | 'dbtStatus'
  | 'metaQuestion' | 'chart' | 'sqlGenerator' | 'supervisor'
  | 'discrepancy' | 'teachingCandidate';

export type ThinkingLevel = 'minimal' | 'low' | 'medium' | 'high' | 'default';

export interface NodeProfile {
  tier: ModelTier;
  version: string;            // resolved via the explicit Gemini 3.x map
  thinkingLevel: ThinkingLevel;
}

const flash = (): NodeProfile => ({ tier: 'flash', version: '3', thinkingLevel: 'default' });
const pro = (): NodeProfile => ({ tier: 'pro', version: '3.1', thinkingLevel: 'default' });

const DEFAULTS: Record<NodeId, NodeProfile> = {
  clarification: flash(), slackIntake: flash(), followUpClassifier: flash(),
  dbtStatus: flash(), metaQuestion: flash(), chart: flash(), teachingCandidate: flash(),
  sqlGenerator: pro(), supervisor: pro(), discrepancy: pro(),
};

const TIERS: ModelTier[] = ['flash-lite', 'flash', 'pro'];
const LEVELS: ThinkingLevel[] = ['minimal', 'low', 'medium', 'high', 'default'];

function isValidPartial(v: unknown): v is Partial<NodeProfile> {
  if (!v || typeof v !== 'object') return false;
  const p = v as Record<string, unknown>;
  if ('tier' in p && !TIERS.includes(p.tier as ModelTier)) return false;
  if ('version' in p && typeof p.version !== 'string') return false;
  if ('thinkingLevel' in p && !LEVELS.includes(p.thinkingLevel as ThinkingLevel)) return false;
  return true;
}

function loadOverrides(): Partial<Record<NodeId, Partial<NodeProfile>>> {
  const raw = process.env.NODE_PROFILE_OVERRIDES;
  if (!raw) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch {
    console.warn('NODE_PROFILE_OVERRIDES is not valid JSON; ignoring');
    return {};
  }
  if (!parsed || typeof parsed !== 'object') return {};
  const out: Partial<Record<NodeId, Partial<NodeProfile>>> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (k in DEFAULTS && isValidPartial(v)) out[k as NodeId] = v;
  }
  return out;
}

export function getNodeProfile(id: NodeId): NodeProfile {
  return { ...DEFAULTS[id], ...loadOverrides()[id] };
}

export function resolveNodeModel(id: NodeId): string {
  const p = getNodeProfile(id);
  return resolveModelId(p.tier, p.version);
}
```

**Step 4: Run to verify pass**
Run: `npx vitest run tests/agents/nodeProfiles.test.ts`
Expected: PASS.

**Step 5: Commit**
```bash
git add src/agents/nodeProfiles.ts tests/agents/nodeProfiles.test.ts
git commit -m "feat: nodeProfiles registry with validated runtime overrides

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: `modelGateway` seam + telemetry

**Files:**
- Create: `src/agents/modelGateway.ts`
- Test: `tests/agents/modelGateway.test.ts`

Read @superpowers:test-driven-development. The seam is pure plumbing — test it directly with a fake `ai`.

**Step 1: Write the failing tests**

```ts
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
```

**Step 2: Run to verify failure**
Run: `npx vitest run tests/agents/modelGateway.test.ts`
Expected: FAIL — module not found.

**Step 3: Implement** `src/agents/modelGateway.ts`

```ts
import { AsyncLocalStorage } from 'node:async_hooks';
import type { GoogleGenAI } from '@google/genai';
import { getNodeProfile, resolveNodeModel, type NodeId } from './nodeProfiles.js';

export interface UsageRecord {
  nodeId: NodeId;
  promptTokens: number;
  candidatesTokens: number;
  thoughtsTokens: number;
  latencyMs: number;
}
type UsageSink = (r: UsageRecord) => void;

const sinkStore = new AsyncLocalStorage<UsageSink>();

export async function withUsageSink<T>(sink: UsageSink, fn: () => Promise<T>): Promise<T> {
  return sinkStore.run(sink, fn);
}

function num(v: unknown): number {
  return typeof v === 'number' ? v : 0;
}

function recordUsage(nodeId: NodeId, usage: unknown, latencyMs: number): void {
  const sink = sinkStore.getStore();
  if (!sink) return;
  const u = (usage ?? {}) as Record<string, unknown>;
  sink({
    nodeId,
    promptTokens: num(u.promptTokenCount),
    candidatesTokens: num(u.candidatesTokenCount),
    thoughtsTokens: num(u.thoughtsTokenCount),
    latencyMs,
  });
}

// `ai.models.generateContent` parameter type, minus the bits the seam owns.
type GenReq = Parameters<GoogleGenAI['models']['generateContent']>[0];

export async function generateForNode(
  nodeId: NodeId,
  ai: GoogleGenAI,
  request: Omit<GenReq, 'model'>,
  opts?: { modelOverride?: string },
): Promise<Awaited<ReturnType<GoogleGenAI['models']['generateContent']>>> {
  const profile = getNodeProfile(nodeId);
  const model = opts?.modelOverride ?? resolveNodeModel(nodeId);
  const config = {
    ...request.config,
    // 'default' sentinel means "send nothing". Compare against the string —
    // do NOT shorten to a truthiness check (every level is a non-empty string,
    // but keeping the explicit !== guards the sentinel contract).
    ...(profile.thinkingLevel !== 'default' && {
      thinkingConfig: { thinkingLevel: profile.thinkingLevel },
    }),
  };
  const t0 = Date.now();
  const res = await ai.models.generateContent({ ...request, model, config } as GenReq);
  recordUsage(nodeId, (res as { usageMetadata?: unknown }).usageMetadata, Date.now() - t0);
  return res;
}
```

> If the `@google/genai` types make `Parameters<…>` awkward (the SDK overloads
> `generateContent`), fall back to typing `request` as `{ contents: unknown; config?: Record<string, unknown> }`
> and `ai` as `GoogleGenAI`. Run `npm run typecheck` and adjust — do not `any`-cast the whole signature.

**Step 4: Run to verify pass**
Run: `npx vitest run tests/agents/modelGateway.test.ts && npm run typecheck`
Expected: PASS, clean typecheck.

**Step 5: Commit**
```bash
git add src/agents/modelGateway.ts tests/agents/modelGateway.test.ts
git commit -m "feat: generateForNode seam with AsyncLocalStorage usage telemetry

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Wire all 10 agents through the seam (one sub-step per agent)

For **each** agent below, the change is mechanical:
1. Replace `ai.models.generateContent({ model: getXModel(), ...rest })` with `generateForNode('<nodeId>', ai, { ...rest })`.
2. Remove the now-unused `import { getFlashModel | getProModel } from './modelConfig.js'` (keep it only where still referenced).
3. Update that agent's existing test's model-string assertion to the new 3.x id.
4. Run the agent's test + typecheck. Commit.

**Node id ↔ file ↔ new model id:**

| nodeId | file | call site | new id |
|---|---|---|---|
| clarification | `src/agents/clarificationAgent.ts:31` | `classifyQuestion` | gemini-3-flash-preview |
| slackIntake | `src/agents/slackIntakeAgent.ts:90` (inside `withTimeout`) | gemini-3-flash-preview |
| followUpClassifier | `src/agents/followUpClassifier.ts:34` | gemini-3-flash-preview |
| dbtStatus | `src/agents/dbtStatusAgent.ts:22` | gemini-3-flash-preview |
| metaQuestion | `src/agents/metaQuestionHandler.ts:49` | gemini-3-flash-preview |
| chart | `src/agents/chartAgent.ts:46` | gemini-3-flash-preview |
| teachingCandidate | `src/teachings/candidateGenerator.ts:60` | gemini-3-flash-preview |
| supervisor | `src/agents/supervisorAgent.ts:33` | gemini-3.1-pro-preview |
| discrepancy | `src/agents/discrepancyHandler.ts:33` | gemini-3.1-pro-preview |
| sqlGenerator | `src/agents/sqlGenerator.ts:156,170` (two call sites) | gemini-3.1-pro-preview |

**Example — `followUpClassifier.ts`:**

Before:
```ts
import { getFlashModel } from './modelConfig.js';
...
const response = await ai.models.generateContent({
  model: getFlashModel(),
  contents: [{ role: 'user', parts: [{ text: prompt }] }],
  config: { responseMimeType: 'application/json', responseJsonSchema: toJSONSchema(FollowUpSchema) },
});
```
After:
```ts
import { generateForNode } from './modelGateway.js';
...
const response = await generateForNode('followUpClassifier', ai, {
  contents: [{ role: 'user', parts: [{ text: prompt }] }],
  config: { responseMimeType: 'application/json', responseJsonSchema: toJSONSchema(FollowUpSchema) },
});
```
Test update — `tests/agents/followUpClassifier.test.ts`: change any `gemini-flash-latest` assertion to `gemini-3-flash-preview`.

**Special case — `sqlGenerator.ts`:** two call sites (the File Search attempt at :156 and the degraded retry at :170). Both become `generateForNode('sqlGenerator', ai, { contents, config }, opts.model ? { modelOverride: opts.model } : undefined)`. Preserve the `opts.model` override via `modelOverride`. Delete `const model = opts.model || getProModel();` and the `getProModel` import. Update `tests/agents/sqlGenerator*.test.ts` model assertions to `gemini-3.1-pro-preview`.

**Special case — `slackIntakeAgent.ts`:** the call is inside `withTimeout(...)`. Wrap the seam call: `withTimeout(generateForNode('slackIntake', ai, { contents, config }), options.timeoutMs ?? INTAKE_TIMEOUT_MS)`.

**Per-agent step sequence (repeat for all 10):**
1. Edit the agent file (swap call, fix imports).
2. Edit the agent's test model assertion (where present — see grep below).
3. Run: `npx vitest run tests/agents/<agent>.test.ts` → PASS.
4. After all 10: `npm run typecheck` → clean, and `npm test` → green.
5. Commit per agent (or per logical group):
```bash
git add src/agents/<agent>.ts tests/agents/<agent>.test.ts
git commit -m "refactor: route <agent> through generateForNode (Gemini 3.x)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

Model-string assertions to update (from grep):
`tests/agents/discrepancyHandler.test.ts:86`, `tests/agents/dbtStatusAgent.test.ts:79`,
`tests/teachings/candidateGenerator.test.ts:110`, `tests/agents/metaQuestionHandler.test.ts:74`,
`tests/agents/slackIntakeAgent.test.ts:66`, `tests/agents/supervisorAgent.test.ts:142`.
Also delete the two obsolete assertions in `tests/agents/modelConfig.test.ts:12-13` only if `getFlashModel`/`getProModel` are removed; otherwise leave them. **Recommendation:** keep `getFlashModel`/`getProModel`/`getFlashLiteModel`/`getJudgeModel` for now — `getJudgeModel` is still used by the benchmark. Add a `getFlashLiteModel` env helper only if a test needs it.

**Definition of done for Task 4:** `npm test` and `npm run typecheck` both green; no agent imports `getFlashModel`/`getProModel` except where genuinely still needed; production behavior is structure-identical with model identity on pinned 3.x.

---

### Task 5: Document the new env vars

**Files:** Modify `.env.example`, `CLAUDE.md` (Key SDK Patterns section).

Add to `.env.example`:
```
# Per-node model sizing (optional). JSON keyed by nodeId; deep-merged over Gemini 3.x defaults.
# NODE_PROFILE_OVERRIDES={"clarification":{"tier":"flash-lite","version":"3.1","thinkingLevel":"minimal"}}
# MODEL_ID_OVERRIDES={"pro/3.1":"gemini-3.1-pro-001"}
```
Add one line to `CLAUDE.md` under Google GenAI SDK patterns noting thinking is discrete in 3.x (`thinkingConfig.thinkingLevel: minimal|low|medium|high`) and that nodes resolve their model via `nodeProfiles`.

Commit:
```bash
git add .env.example CLAUDE.md
git commit -m "docs: document NODE_PROFILE_OVERRIDES / MODEL_ID_OVERRIDES

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

**PR 1 ends here.** Open the PR; it is a self-contained, behavior-structure-preserving refactor that pins to Gemini 3.x and unlocks per-node config. Merge before PR 2.

---

## PR 2 — Measurement layer (sweep)

### Task 6: Sweep types + pure decision rule

**Files:**
- Create: `scripts/node-sweep-types.ts`, `scripts/node-sweep-decision.ts`
- Test: `tests/scripts/nodeSweepDecision.test.ts`

**Step 1: Write the failing tests** (pure functions, no network)

```ts
import { describe, it, expect } from 'vitest';
import { pickRecommendation } from '../../scripts/node-sweep-decision.js';

const base = { rung: 'DEFAULT', metric: 0.90, e2e: 8.0, p95LatencyMs: 1000, cost: 100 };

describe('pickRecommendation', () => {
  it('falls back to baseline when no cheaper rung is viable', () => {
    const cands = [base, { rung: 'R0', metric: 0.5, e2e: 8.0, p95LatencyMs: 200, cost: 10 }];
    expect(pickRecommendation(base, cands, 0.02, 0.3).rung).toBe('DEFAULT'); // R0 regresses metric
  });

  it('prefers a >5% faster viable rung over baseline', () => {
    const cands = [base, { rung: 'R2', metric: 0.89, e2e: 7.9, p95LatencyMs: 800, cost: 60 }];
    expect(pickRecommendation(base, cands, 0.02, 0.3).rung).toBe('R2');
  });

  it('within the latency band, prefers higher quality then lower cost', () => {
    const cands = [
      base,
      { rung: 'A', metric: 0.91, e2e: 8.0, p95LatencyMs: 500, cost: 80 },
      { rung: 'B', metric: 0.93, e2e: 8.0, p95LatencyMs: 510, cost: 90 }, // within 5% of 500
      { rung: 'C', metric: 0.93, e2e: 8.0, p95LatencyMs: 505, cost: 70 }, // same quality, cheaper
    ];
    expect(pickRecommendation(base, cands, 0.02, 0.3).rung).toBe('C');
  });

  it('gates on the end-to-end score, not just the node metric', () => {
    const cands = [base, { rung: 'R', metric: 0.90, e2e: 7.5, p95LatencyMs: 300, cost: 20 }];
    expect(pickRecommendation(base, cands, 0.02, 0.3).rung).toBe('DEFAULT'); // e2e drop 0.5 > eps 0.3
  });
});
```

**Step 2: Run to verify failure** → FAIL (module missing).

**Step 3: Implement** `scripts/node-sweep-types.ts`:
```ts
import type { NodeId, ModelTier, ThinkingLevel } from '../src/agents/nodeProfiles.js';

export interface LadderRung { rung: string; tier: ModelTier; version: string; thinkingLevel: ThinkingLevel; }

export const DEFAULT_LADDER: LadderRung[] = [
  { rung: 'R0', tier: 'flash-lite', version: '3.1', thinkingLevel: 'minimal' },
  { rung: 'R1', tier: 'flash-lite', version: '3.1', thinkingLevel: 'low' },
  { rung: 'R2', tier: 'flash', version: '3', thinkingLevel: 'minimal' },
  { rung: 'R3', tier: 'flash', version: '3', thinkingLevel: 'medium' },
  { rung: 'R4', tier: 'pro', version: '3.1', thinkingLevel: 'low' },
  { rung: 'R5', tier: 'pro', version: '3.1', thinkingLevel: 'high' },
];

export interface RungScore { rung: string; metric: number; e2e: number; p95LatencyMs: number; cost: number; }
export interface NodeRecommendation { nodeId: NodeId; baseline: RungScore; chosen: RungScore; allViable: RungScore[]; }
```

`scripts/node-sweep-decision.ts`:
```ts
import type { RungScore } from './node-sweep-types.js';

export function pickRecommendation(
  baseline: RungScore,
  candidates: RungScore[],   // MUST include baseline
  metricEps: number,
  e2eEps: number,
  latencyBand = 0.05,
): RungScore {
  const viable = candidates.filter(c => c.metric >= baseline.metric - metricEps && c.e2e >= baseline.e2e - e2eEps);
  const fastest = Math.min(...viable.map(c => c.p95LatencyMs));
  const contenders = viable.filter(c => c.p95LatencyMs <= fastest * (1 + latencyBand));
  contenders.sort((a, b) => (b.metric - a.metric) || (a.cost - b.cost));
  return contenders[0];
}
```

**Step 4: Run to verify pass** → PASS.

**Step 5: Commit**
```bash
git add scripts/node-sweep-types.ts scripts/node-sweep-decision.ts tests/scripts/nodeSweepDecision.test.ts
git commit -m "feat: node-sweep ladder types + latency>quality>cost decision rule

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: ε calibration helper (pure)

**Files:** Create `scripts/node-sweep-calibrate.ts`; Test `tests/scripts/nodeSweepCalibrate.test.ts`.

`computeEpsilon(runA: number[], runB: number[]): number` returns the max absolute per-item
difference between two baseline runs (the harness noise band), with a small floor.

```ts
export function computeEpsilon(runA: number[], runB: number[], floor = 0.01): number {
  const n = Math.min(runA.length, runB.length);
  let maxDiff = 0;
  for (let i = 0; i < n; i++) maxDiff = Math.max(maxDiff, Math.abs(runA[i] - runB[i]));
  return Math.max(maxDiff, floor);
}
```
Tests: identical runs → floor; a single 0.2 jitter → 0.2. Commit.

---

### Task 8: Sweep driver (integration, real Gemini — not in CI)

**Files:** Create `scripts/node-sweep.ts`. No CI test (mirrors `benchmark.ts` posture).

**Structure** (compose, don't reinvent — import the corpus loop pieces from `benchmark.ts`/`benchmarkSupport.ts`):
1. Parse args: `--node <id>` (repeatable; default = sweepable set `clarification,sqlGenerator,supervisor`), `--version <v>` (pins the ladder version line), `--corpus <path>`.
2. Preflight: `assertGenerateContentModelsAvailable` over every model id the ladder will touch (`scripts/benchmarkPreflight.ts`).
3. Install a usage sink via `withUsageSink` from `modelGateway` to capture per-node tokens/latency for each corpus run.
4. **ε calibration:** run baseline corpus twice → `computeEpsilon` over the node's metric series.
5. For each node: run baseline, then each ladder rung by setting `process.env.NODE_PROFILE_OVERRIDES = JSON.stringify({ [node]: rung })` before the run and restoring after. A rung run that throws → record `metric=0` (failed), continue; a baseline throw → skip the node with a logged error.
6. Map each node's metric:
   - `clarification` → `clarificationPassed` rate (from `benchmarkSupport.ts`).
   - `sqlGenerator` → mean of `tableSelectionPassed`, `sqlShapePassed`, judge `correctness/10`.
   - `supervisor` → end-to-end judge `overallScore` (proxy; all other nodes pinned at baseline).
   Cost = `Σ tokens × TIER_PRICES[tier]` (config map at top of file, prices as constants with a comment to update from billing).
7. `pickRecommendation` per node.
8. **Combined pass:** set `NODE_PROFILE_OVERRIDES` to all chosen rungs at once, run the corpus, assert e2e ≥ baseline − ε; if it regresses, revert the node whose chosen rung had the smallest metric margin toward DEFAULT and log it.
9. Write `benchmarks/results/node-sweep-<date>.md`: per-node ladder table (metric / p95 / cost, recommended rung marked) + combined verdict + the ε used.

**Add npm script** to `package.json`: `"node-sweep": "tsx scripts/node-sweep.ts"`.

**Manual verification:**
```bash
GEMINI_API_KEY=… GCP_PROJECT_ID=… npx tsx scripts/node-sweep.ts --node clarification --version 3
# Expect: benchmarks/results/node-sweep-<date>.md with a recommended rung for clarification.
```

Commit:
```bash
git add scripts/node-sweep.ts package.json
git commit -m "feat: coordinate-descent node-sweep driver + combined verification pass

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 9: Final verification

1. `npm run typecheck` → clean.
2. `npm test` → green (all pure sweep tests + unchanged agent suite).
3. Read @superpowers:verification-before-completion and confirm each design claim is met:
   defaults pinned to 3.x, overrides validated, thinking omitted by default, seam telemetry
   attributable per node, decision rule baseline-safe + latency-banded, combined pass present.
4. Open PR 2.

---

## Notes for the executor
- **Do not** add per-agent tests in Task 4 beyond updating the model-string assertion — the existing agent suites are the regression net (design §Testing).
- **Do not** widen the seam to own retries/timeouts/File-Search fallback — those stay in the agents (design §The seam).
- Verify the exact `gemini-3.5-flash` / `*-preview` ids against the live model list before deploy; use `MODEL_ID_OVERRIDES` if any differ. Only Gemini 3.x.
- `tsconfig` is `module: NodeNext` — keep `.js` import extensions.
