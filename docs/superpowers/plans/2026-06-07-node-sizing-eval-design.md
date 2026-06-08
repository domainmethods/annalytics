# Per-Node Model Sizing Eval — Design

**Date:** 2026-06-07
**Status:** Approved (design phase, via brainstorming skill)
**Next step:** writing-plans → implementation plan

## Problem

Every LLM node in the pipeline hardcodes its model at the call site — `getFlashModel()`
or `getProModel()` — and no node uses a thinking budget at all (`grep thinkingConfig` →
nothing). The only knob is a global env var that flips Flash/Pro everywhere at once. We
cannot vary one node and hold the rest fixed, which is exactly what right-sizing requires.

We want a lightweight, evals-like system that, per node, finds the smallest viable
`(model, thinkingLevel)` — and makes that choice a real runtime config so the
recommendation can be applied in production without code edits.

## Goal & Non-Goals

- **Goal:** measure the right size per node AND make per-node model + thinking a runtime
  config (the `nodeProfiles` registry wired into all ~10 agents).
- **Non-goal (deferred):** a closed-loop autotuner that re-sweeps and auto-applies on a
  schedule. YAGNI for v1.

## Optimization Objective

Lexicographic preference: **latency ≻ quality ≻ cost**, with quality as a hard floor.

**Decision rule** (per node):
1. **Gate (quality floor):** a candidate config is viable iff its node metric ≥ baseline − ε
   **AND** the end-to-end judge score ≥ baseline − ε. The **baseline (DEFAULT) profile is
   always a candidate** and is trivially viable, so the viable set is never empty.
2. **Latency (with equivalence band):** `fastest = min(viable.p95Latency)`;
   `contenders = viable.filter(p95 ≤ fastest × 1.05)`. A config must be ≥5% faster to win
   on latency alone — otherwise quality/cost decide.
3. **Quality:** among contenders, highest node metric.
4. **Cost:** tie-break on lowest cost (tokens incl. thoughts × tier price).

`ε` is **calibrated, not guessed:** run the baseline corpus twice, measure per-metric
run-to-run jitter, set ε to that noise band. As the corpus is hardened, ε shrinks and the
gate automatically tightens — no code change. This is the antidote to the small-corpus
(~12 entries) concern: the gate never fires on a delta smaller than the harness's own
variance.

## Gemini 3.x model facts (authoritative)

Only Gemini 3.x models are used. Thinking is **discrete** in Gemini 3.x (not a token budget).

- JS SDK: `config: { thinkingConfig: { thinkingLevel: '…' } }`
- Allowed values: `"minimal" | "low" | "medium" | "high"`
- Model defaults vary: 3.1 Pro / 3 Flash → `high`; 3.1 Flash-Lite → `minimal`; 3.5 Flash → `medium`.
- Exact model ids (verify exact strings against the live model list at impl time):
  - Pro: `gemini-3.1-pro-preview`, `gemini-3-pro-preview`
  - Flash: `gemini-3-flash-preview`, `gemini-3.5-flash`
  - Flash-Lite: `gemini-3.1-flash-lite`
- The tier×version grid is **sparse** (no 3.5 Pro, no 3 Flash-Lite). Model selection uses an
  explicit availability map, not `gemini-<version>-<tier>` composition (which would synthesize
  nonexistent ids).

Sources:
- https://ai.google.dev/gemini-api/docs/gemini-3
- https://ai.google.dev/gemini-api/docs/thinking
- https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/thinking

## Approach (chosen): registry + thin seam + coordinate-descent sweep

Two new runtime modules + one sweep script; everything else reuses the existing benchmark
harness (corpus, judge, latency capture, `detectRegressions`).

### Module map

```
src/agents/modelConfig.ts    (EXTEND)  explicit Gemini-3.x model map + resolveModelId(tier, version)
src/agents/nodeProfiles.ts   (NEW)     NodeId → NodeProfile registry, defaults = pinned 3.x, runtime override
src/agents/modelGateway.ts   (NEW)     generateForNode() seam + optional usage-telemetry collector
scripts/node-sweep.ts        (NEW)     coordinate-descent driver, decision rule, combined pass, report
scripts/node-sweep-types.ts  (NEW)     NodeId, ladder rungs, SweepResult, NodeRecommendation
```

Each of the ~10 agents changes one line:
`ai.models.generateContent({ model: getFlashModel(), … })` → `generateForNode('clarification', ai, { … })`.

Dependency rules stay legal: new modules live in `agents/` and import nothing from
`slack/` or `state/`; `scripts/` already reaches into `agents/` and `validation/`.

**Two layers:**
- **Runtime layer** (registry + gateway) ships to prod. Structure-preserving: same call
  shapes, same config keys. Model identity intentionally moves to pinned 3.x ids.
- **Measurement layer** (sweep script) is dev/CI-only, never imported by `app.ts`.

### Data model

```ts
export type ModelTier = 'flash-lite' | 'flash' | 'pro';

export type NodeId =
  | 'clarification' | 'slackIntake' | 'followUpClassifier' | 'dbtStatus'
  | 'metaQuestion' | 'chart' | 'sqlGenerator' | 'supervisor'
  | 'discrepancy' | 'teachingCandidate' | 'summaryOverride';

export type ThinkingLevel = 'minimal' | 'low' | 'medium' | 'high' | 'default';
// 'default' = omit thinkingConfig entirely → model's own default

export interface NodeProfile {
  tier: ModelTier;
  version?: string;          // '3' | '3.1' | '3.5'; resolved via the explicit model map
  thinkingLevel: ThinkingLevel;
}
```

**Default registry (pinned 3.x, the high reference baseline):**
- Flash nodes (clarification, slackIntake, followUpClassifier, dbtStatus, metaQuestion,
  chart, teachingCandidate, summaryOverride) → `gemini-3-flash-preview`, `thinkingLevel: 'default'`.
- Pro nodes (sqlGenerator, supervisor, discrepancy) → `gemini-3.1-pro-preview`,
  `thinkingLevel: 'default'`.

> **Node count — 11, not 10.** Implementation surfaced an 11th hardcoded `getFlashModel()`
> call site this enumeration originally missed: the **Summary** response-override button
> (`handlers/responseOverrides.ts`), which re-summarizes a result set with Flash. It is a real
> live generation path, so leaving it out would have stranded it off the registry and off the
> 3.x pin. It is registered as `summaryOverride` (Flash default). It is **not** swept in v1 — it
> has no corpus label — so it sits in the same "needs a node metric" deferred bucket as the
> other unlabeled Flash nodes; it is runtime-configurable like the rest.

Rationale: the baseline must be the high reference, not the floor — the no-regression gate
is only meaningful if it's measured against a known-good config. The sweep ratchets down
from there. `gemini-3.5-flash` belongs in the sweep as a ladder/version comparison, not as
the fixed reference.

`getNodeProfile(id)` is **total by construction** (closed `NodeId` union, `DEFAULTS` covers
every member, deep-merged with validated overrides) — never returns `undefined`, so no
optional chaining is needed at the call boundary.

**Runtime override:** `NODE_PROFILE_OVERRIDES` env var = JSON, deep-merged over defaults,
shape-validated (bad entries dropped individually, never crashes boot). The sweep sets it
to one node per run; in prod it's how a recommendation gets applied without a code edit.

**Model resolution:** explicit map `(tier, version) → model id`, Gemini-3.x-only, overlaid
by `MODEL_ID_OVERRIDES` JSON. A `(tier, version)` absent from the map = not a real model,
rejected at sweep preflight (reuse `assertGenerateContentModelsAvailable`).

### The seam

```ts
export async function generateForNode(
  nodeId: NodeId,
  ai: GoogleGenAI,
  request: GenerateContentParameters,   // caller omits model + thinkingConfig
): Promise<GenerateContentResponse> {
  const profile = getNodeProfile(nodeId);            // total — never undefined
  const model = resolveNodeModel(nodeId);
  const config = {
    ...request.config,
    // string compare — note: 'default' sentinel means "send nothing"
    ...(profile.thinkingLevel !== 'default'
        && { thinkingConfig: { thinkingLevel: profile.thinkingLevel } }),
  };
  const t0 = nowMs();
  const res = await ai.models.generateContent({ ...request, model, config });
  recordUsage(nodeId, res.usageMetadata, nowMs() - t0);  // tolerates undefined usageMetadata
  return res;
}
```

The seam is deliberately thin: resolve profile → call → record usage. It does **not** own
retries, File Search degradation, or timeouts — those stay in the agents that need them
(sqlGenerator's File Search fallback, slackIntake's timeout wrapper).

**Telemetry collector:** an `AsyncLocalStorage<UsageSink>`. Production installs none, so
`recordUsage` early-returns (one branch, no allocation). The sweep installs a sink that
accumulates `{ nodeId, promptTokens, thoughtsTokens, candidatesTokens, latencyMs }` per
corpus run — making `thoughtsTokenCount` attributable to a specific node even though the
harness only calls agents, not Gemini directly. `recordUsage` zero-fills missing token
counts when `usageMetadata` is undefined (safety blocks, mocked responses).

### Residual model aliases (judge + config) — pin to 3.x

Routing the agents through the seam does **not** by itself satisfy "only Gemini 3.x":
two paths bypass `nodeProfiles` and must be pinned explicitly.

1. **Benchmark judge.** `getJudgeModel()` → `getProModel()` → `DEFAULT_PRO_MODEL`. Pin
   `DEFAULT_FLASH_MODEL`/`DEFAULT_PRO_MODEL` to `gemini-3-flash-preview` /
   `gemini-3.1-pro-preview` so every residual consumer (judge, and any leftover
   `getProModel()` reference) defaults to 3.x.
2. **`config.gemini.model` shadowing `sqlGenerator`.** `config.gemini.model` (= `getProModel()`)
   is threaded as `opts.model` into `generateSql` (`pipeline.ts:254 → qualityLoop → generateSql`),
   and the old `const model = opts.model || getProModel()` makes it an **always-on** override.
   Left as-is it would (a) keep `sqlGenerator` off `nodeProfiles` and (b) make the `sqlGenerator`
   sweep a no-op (`NODE_PROFILE_OVERRIDES.sqlGenerator` never applies, because `modelOverride`
   always wins). **Sever it:** the seam owns `sqlGenerator`'s model; `modelOverride` stays
   available in `generateForNode` for a future genuine per-call override but is **not** fed from
   config. Without this, the primary labeled sweep target is un-sweepable.

### Ladder (cheapest → dearest)

| Rung | model | thinkingLevel |
|------|-------|---------------|
| R0 | gemini-3.1-flash-lite | minimal |
| R1 | gemini-3.1-flash-lite | low |
| R2 | gemini-3-flash-preview | minimal |
| R3 | gemini-3-flash-preview | medium |
| R4 | gemini-3.1-pro-preview | low |
| R5 | gemini-3.1-pro-preview | high |

Discrete `thinkingLevel` makes the ladder exhaustively enumerable per model (no arbitrary
budget sampling). **Version is an outer loop, not an inner rung:** crossing 3 versions into
the ladder triples every node's sweep cost for a question you ask rarely. Pin one version
per sweep (or `SWEEP_VERSION`); a version comparison is a deliberate second run (sweep at
3.5, sweep at 3, diff the reports).

### Sweep algorithm (coordinate descent)

```
calibrate ε:  run baseline corpus twice → per-metric noise band
for each sweepable node:
   baseline = run corpus at DEFAULT profile → (metric, e2e-judge, p95-latency, cost)
   candidates = [DEFAULT, ...ladder rungs]              // baseline always present
   for each non-default rung:
      NODE_PROFILE_OVERRIDES = { [node]: rung }
      run corpus → record candidate metrics
      (a rung whose run throws is recorded as failed, sweep continues;
       a baseline run that throws aborts THAT node — can't calibrate the gate)
   viable     = candidates where metric ≥ base−ε AND e2e ≥ base−ε   // never empty
   contenders = viable where p95 ≤ min(viable.p95) × 1.05
   recommend  = argmax(contenders, quality), tie → argmin(cost)
combined pass: set ALL recommended overrides at once → run corpus →
   assert e2e ≥ baseline − e2eEps; if regressed, revert the most-recoverable node:
   e2e-critical nodes FIRST (a combined regression is an e2e regression, so only a
   node whose quality is seen THROUGH e2e can cure it — reverting a node that already
   cleared its own dedicated gate-metric wastes a cycle), tie-broken by smallest
   ε-normalized gate margin = (chosen.metric − (baseline.metric − metricEps)) /
   metricEps; re-run; if still regressed, revert ALL e2e-critical nodes + flag for
   manual review.
emit node-sweep-report.md (ladder table per node, recommended rung circled, combined verdict)
```

The **combined pass** closes coordinate descent: each node is recommended in isolation, but
the *combination* is never otherwise run together; cross-node coupling could regress the
whole. The combined pass makes the end-to-end guard hold for the shipped configuration.

### Per-node metric — and v1 scope cut

| Node | Metric source | Sweepable in v1? |
|------|---------------|------------------|
| clarification | `clarificationPassed` (confidence match, in corpus) | yes |
| sqlGenerator | `tableSelectionPassed` + `sqlShapePassed` + judge correctness | yes |
| supervisor | end-to-end judge as proxy (no direct label yet) | proxy-only |
| followUpClassifier, slackIntake, dbtStatus, metaQuestion, chart, discrepancy, teachingCandidate, summaryOverride | no corpus labels today | deferred |

The registry/gateway is wired into **all 11** (all runtime-configurable now), but the
**sizing recommendation in v1 covers only labeled nodes** + supervisor via the e2e proxy.
(`summaryOverride`, the 11th node, sits in the deferred bucket above — see the node-count
note in "Default registry".)
The rest are flagged "needs a node metric" — deliberate YAGNI, aligned with the governance
doc's benchmark-hardening tranche. During the supervisor proxy sweep, all other nodes are
pinned at baseline, so any e2e movement is attributable to the supervisor.

### Cost model

`tokens × tierPrice`, with a `TIER_PRICES` config map (flash-lite < flash < pro). Prices are
config, not hardcoded — same rationale as model ids.

## Error handling

| Failure | Behavior |
|---------|----------|
| Malformed `NODE_PROFILE_OVERRIDES` JSON | caught, logged once, `{}` → DEFAULTS. Boot never fails. |
| Override entry with invalid shape | validated; bad entries dropped individually. |
| Well-shaped override, unresolvable merged `(tier,version)` | `getNodeProfile` re-checks the **merged** profile via `resolveModelId` (catches both direct `pro/3.5` and tier-only overrides that inherit an incompatible version); on failure it logs once and falls back to that node's default. No per-request crash. |
| `usageMetadata` undefined | `recordUsage` zero-fills token counts. |
| No telemetry sink (prod) | `recordUsage` early-returns. |
| Gateway gets API/timeout error | pass-through; agent's existing handling owns it. |
| Sweep: one rung run throws | record rung as failed, continue the ladder. |
| Sweep: baseline run throws | abort that node with a clear message. |
| Sweep preflight | `assertGenerateContentModelsAvailable` fails fast on unavailable model. |

## Testing

**Pure unit (CI):**
- `modelConfig`: flash-lite + version resolution from the explicit 3.x map;
  `MODEL_ID_OVERRIDES` escape hatch.
- `nodeProfiles`: the no-op-structure proof — `resolveNodeModel(id)` equals the pinned 3.x
  id for every node; override deep-merge; malformed override ignored; registry is total.
- `modelGateway`: `thinkingConfig` present for each non-default level, omitted for
  `'default'`; `usageMetadata: undefined` tolerated; sink receives a record when installed,
  no-op when not; request otherwise passed through unchanged.
- `node-sweep` decision rule (pure functions): baseline-always-a-candidate (never-empty
  viable); latency equivalence band; lexicographic latency→quality→cost; ε calibration math;
  combined-pass regression check.

**Integration / manual (real Gemini, not CI):** the actual corpus sweep — same posture as
the existing `benchmark.ts`.

**Regression safety net:** the ~10 agents' existing model-string assertions are updated to
the pinned 3.x ids; those tests passing is the audit trail that the model move was
deliberate and the call shapes are otherwise unchanged.

## Rollout (two PRs)

1. **Runtime layer:** `modelConfig` extension + `nodeProfiles` + `modelGateway` + wire all
   11 agents + update agent model-string tests to pinned 3.x ids. Behavior change limited to
   model identity (→ 3.x); structure preserved.
2. **Measurement layer:** `node-sweep` script + types + pure decision-rule/ε/combined-pass
   tests. Additive; never imported by `app.ts`.
