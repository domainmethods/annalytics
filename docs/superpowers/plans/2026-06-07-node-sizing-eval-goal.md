# Per-Node Model Sizing Eval — Goal Statement & Execution Record

> **Status:** Complete (subagent-driven execution). This document is the goal
> statement that governs the work in `2026-06-07-node-sizing-eval-design.md`
> (design) and `2026-06-07-node-sizing-eval-implementation.md` (task plan). It was
> written to record intent, the execution method, and — critically — the boundary
> between what was *proven* and what remains *provisional*.

## Goal

Make per-node Gemini model selection a first-class, right-sizeable runtime config:
every agent call site resolves a `(tier, version, thinkingLevel)` profile from a
central registry, and a dev-only coordinate-descent sweep recommends the smallest
viable profile per node against the benchmark corpus. The end state is the ability
to answer, per node, "what is the cheapest/fastest model that does not measurably
regress quality?" — and to ship those answers as defaults.

Hard constraint: **Gemini 3.x models only** (discrete `thinkingLevel`, explicit
tier×version map — no floating `-latest` aliases).

## Execution method

Subagent-driven development: a fresh implementer subagent per task, followed by a
two-stage review (spec compliance, then code quality) before moving on. After all
tasks, an adversarial whole-branch review. The controller (this session and its
predecessor) curated task text and context, answered subagent questions, and ran
the review loops.

## Phased plan and what each phase delivered

**Phase A/B — Implementation (Tasks 1–9, PR1 runtime + PR2 measurement).**
- Explicit Gemini 3.x model map + pinned defaults (`modelConfig.ts`).
- `nodeProfiles` registry: `NodeId → {tier, version, thinkingLevel}`, runtime
  override via `NODE_PROFILE_OVERRIDES` (validated, deep-merged, fallback on
  unresolvable pairs), model-id escape hatch via `MODEL_ID_OVERRIDES`.
- Thin `generateForNode` seam applying `thinkingConfig` only for non-`default`
  levels, with `AsyncLocalStorage` per-node token/latency telemetry (no-op in prod).
- All ~11 real call sites wired through the seam; `config.geminiModel` severed.
- Sweep measurement layer: ladder + pure decision rule (gate → latency band →
  quality → cost), ε calibration helper, coordinate-descent driver.

**Phase C — Review.** Re-read design + plan, ran an adversarial whole-branch review.
Four findings (none Critical/Important), all addressed: margin scale normalized by
ε; design doc corrected to 11 nodes (the Summary override call site the original
10-node count missed); `setup-check.ts` hardened to reject floating `-latest`
aliases; baseline cost weight sourced from `defaultTierForNode` rather than a
drifting hardcoded helper. Committed `0dca832`.

**Phase D — Run the sizing exercise; fix problems encountered.**
The sweep driver was locked inside a self-executing `main()` runnable only against
live Gemini. It was refactored so `runSweep()` is IO-free except for one injected
seam, `runCorpusOnce` (the sole Gemini/BigQuery boundary). A synthetic,
override-sensitive `runCorpusOnce` then exercised 100% of the orchestration
credential-free.

The exercise surfaced a real ordering weakness: the combined-pass regression revert
sorted *all* downsized nodes by ε-normalized gate margin, so a node with tiny
calibration noise could be reverted ahead of the true e2e culprit — escalating to
manual review prematurely while the culprit stayed downsized. **Fix:** revert
e2e-critical nodes first (a combined regression is an e2e regression; only an
e2e-observed node can cure it), tie-broken by the existing margin. Design-doc
pseudocode updated; the throwaway harness was converted into permanent coverage
(`tests/scripts/nodeSweep.test.ts`). Committed `7ad57fa`.

**Phase E — Recommendations set as defaults.**
Role-based provisional thinking levels per node (tiers unchanged — they encode real
domain knowledge):
- `minimal` — closed-set routing / structured selection / reformatting:
  `slackIntake`, `followUpClassifier`, `dbtStatus`, `chart`, `summaryOverride`.
- `low` — light open judgment over provided context: `clarification`,
  `metaQuestion`, `teachingCandidate`.
- `default` (model-managed) — hard open generation & critique: `sqlGenerator`,
  `supervisor`, `discrepancy`.
Committed `af774be`.

## Live sizing run (2026-06-08)

The sizing exercise was re-run against **live Gemini 3.x** (real `GEMINI_API_KEY`),
which the earlier phases could not do. Two complementary tracks were run, serialized
to avoid shared-quota 429s corrupting the fail-fast SQL sweep.

### Track 1 — SQL-path coordinate-descent sweep (`scripts/node-sweep.ts`)

Judge-scored, 12-question corpus. Results in
`benchmarks/results/node-sweep-2026-06-08.md`.

| Node | ε(metric) | Verdict | Decision |
|------|-----------|---------|----------|
| `clarification` | 0.010 | flat across all rungs (metric 0.083 everywhere); R0 p95 1432ms vs 4798ms baseline | **Genuine downsize available** — but borderline node; documented as recommended `NODE_PROFILE_OVERRIDES`, not a template default |
| `sqlGenerator` | 0.333 | metrics span 0.106–0.222; ε ≈ ⅓ of scale | **HOLD at PRO_DEFAULT** — ε-inflated, noise-dominated, not sizable on this corpus |
| `supervisor` | 2.850 | only signal is the judge; ε ≈ 57% of the 1–5 scale | **HOLD at PRO_DEFAULT** — corpus too small to size |

The script's own auto-verdict ("ACCEPTED — downsize all three to R0") is **rejected**
for `sqlGenerator` + `supervisor`: a large ε makes the quality gate vacuous (everything
"passes within ε"), and the cost tie-break then hands back the cheapest rung by default
— noise masquerading as a downsize. Only `clarification`'s pick reflects a real
flat-quality/lower-latency result.

### Track 2 — universal judge-free floor-up sweep (`scripts/universal-sweep.ts`)

The two install-invariant classifier nodes have objectively-checkable labels
(route / intent), so they were sized with **exact-match accuracy and no judge** —
immune to the ε(e2e) judge noise that sinks Track 1's reasoning nodes. Corpus:
`benchmarks/universal-corpus.json` (14 intake + 12 follow-up entries). Results in
`benchmarks/results/universal-sweep-2026-06-08.md`; run was clean (0 fallbacks/errors).

| Node | R0…R5 accuracy | Floor-up pick |
|------|----------------|---------------|
| `slackIntake` | 1.000 at **every** rung | `flash-lite/3.1` / `minimal` |
| `followUpClassifier` | 1.000 at **every** rung | `flash-lite/3.1` / `minimal` |

Flat-at-ceiling (not flat-at-noise) is positive evidence the task sits *below* the
model-difficulty floor: the cheapest model saturates it. These picks were applied to
the **template** `nodeProfiles.ts` defaults (`CLASSIFIER_LITE`) — they are
install-invariant, so they belong in the template, not in `NODE_PROFILE_OVERRIDES`.

### Consolidated recommendation

| Node | Default | Status | Source |
|------|---------|--------|--------|
| `slackIntake` | `flash-lite/3.1` / minimal | **ADOPTED** (template default) | Track 2, measured |
| `followUpClassifier` | `flash-lite/3.1` / minimal | **ADOPTED** (template default) | Track 2, measured |
| `clarification` | `flash/3` / low | recommended `NODE_PROFILE_OVERRIDES` → R0 | Track 1, borderline node |
| `sqlGenerator` | `pro/3.1` / default | **HELD** — unsized (corpus-limited) | Track 1 |
| `supervisor` | `pro/3.1` / default | **HELD** — unsized (corpus-limited) | Track 1 |
| `discrepancy` | `pro/3.1` / default | provisional (not exercised by corpus) | heuristic |
| `dbtStatus`, `chart`, `summaryOverride` | `flash/3` / minimal | provisional (not in universal corpus) | heuristic |
| `metaQuestion`, `teachingCandidate` | `flash/3` / low | provisional (not exercised by corpus) | heuristic |

**Follow-up (the real fix for the reasoning nodes):** the unifying root cause of the
unsizable Track-1 nodes is corpus size, not a bad judge — 1 question flip = 0.083
metric, a few flips = 0.33 ε. Expand `benchmarks/corpus.json` (currently 12 questions,
exercising only clarification/sqlGenerator/supervisor) to shrink ε below a meaningful
quality delta; only then can `sqlGenerator` + `supervisor` be sized rather than held.

### Corpus-expansion attempt + clarification-gate finding (2026-06-08, later)

Acting on the follow-up above, built a 47-question live corpus against the real
(GA4) schema — `benchmarks/corpus.live.json`, **gitignored** (15 easy / 18 medium /
10 hard / 4 ambiguous), kept out of the template because it is schema-coupled. The
committed template corpus stays generic. A 2-pass smoke pre-check
(`scripts/node-sweep-smoke.ts`) before the expensive full sweep surfaced a *second*,
deeper root cause that corpus size alone cannot fix:

- **The clarification gate suspends ~68% of a real-domain corpus before SQL gen.**
  Classifying all 47 questions at the DEFAULT profile: **32/47 LOW → skip the quality
  loop**, only 15 reach `sqlGenerator`/`supervisor`. Even plain anchors ("page views
  over the last 30 days") classify LOW.
- **Why:** the clarifier's confidence is driven by its injected `AVAILABLE CONTEXT`
  (ReferenceCards/Teachings). This template ships exactly one generic card
  (`references/revenue.yml`, an *orders* definition → `analytics.fct_orders`), so it has
  zero canonical context for any GA4 metric and defaults them to LOW. This is the same
  install-coupling `src/agents/CLAUDE.md` flags: clarification difficulty scales with
  the installed knowledge layer, which the template deliberately ships empty.
- **Consequence:** growing the corpus does **not** by itself size the SQL-path nodes —
  with the gate live, most questions never reach them, so ε stays large for the same
  small-N reason.

**Groundwork landed (opt-in, default OFF — template sweep unchanged):**
`createRunCorpusOnce` + `scripts/node-sweep.ts` + the smoke script now accept
`--bypass-clarification`. When set, a LOW verdict no longer short-circuits the loop —
every entry runs SQL gen + supervisor — while `classifyQuestion` is still called so the
clarification metric stays measurable. This is a faithful proxy for a *populated*
install (whose clarifier would pass in-domain questions), and isolates the SQL-path
nodes; clarification itself is already sized clean (ε≈0.01). Validated end-to-end: a
2-entry bypass run took both previously-skipped questions through the loop
(`sqlGenerator` 0 → 17.5K tokens, `supervisor` 0 → 2.2K tokens).

**Corpus history (2026-06-08).** The original 47-question `benchmarks/corpus.live.json` was
gitignored, never committed, and lived only in the since-removed `silly-mcnulty-73ba04`
worktree — so it was lost and unrecoverable from git or disk. It has since been **rebuilt**
(same 15 easy / 18 medium / 10 hard / 4 ambiguous distribution) targeting the real Velir
dbt-ga4 package schema (dataset `analytics`), with no GCP project ids, client names, or PII.
Per the `benchmarks/results/*` gitignore rationale the rebuilt copy is kept durable **outside
the template** (a path on the operator's machine, recorded in the operator's notes — not
committed here, since the template must stay free of client-derived benchmark evidence).

**Deferred (expensive — not run this session):** the full live sweep is (run from the
**main repo** — it has `node_modules`, `.env`, dbt artifacts):
`cd <main-repo> && npx tsx scripts/node-sweep.ts --corpus <durable-path>/corpus.live.json --node sqlGenerator --node supervisor --bypass-clarification`
Cost (the reason it was deferred): the quality loop is ~63s/entry (Pro SQL gen p95 ~50s on
the 52-table schema). Under two-stage coordinate isolation the pass count is
`2 calibration + nodes × (models + thinkingLevels − 1) + 1 verification` =
`2 + 2 × (4 + 5 − 1) + 1` = **19 passes** with the current 4-model registry (was 5 models
before `pro/3` was dropped). **Note the `thinkingLevels` term is model-dependent, not a
constant 5:** Stage 2 walks only the levels the Stage-1 winner actually serves, and
`gemini-3.1-pro-preview` rejects `minimal` (it walks `low/medium/high/default` = 4, not 5 —
see `getSupportedThinkingLevels`). So if a Pro model wins Stage 1 for a node, that node costs
one fewer pass (`4 models + 4 levels − 1` = 7, vs 8 for a Flash winner). If BOTH
`sqlGenerator` and `supervisor` win Pro (the expected outcome for these reasoning nodes), the
two-node sweep is `2 + 2×7 + 1` = **17 passes**, not 19; it rises toward 19 only if a Flash
model unexpectedly wins. (`node-sweep-smoke.ts`'s printed estimate stays a conservative
upper bound — it runs at the default profile, so it can't know the Stage-1 winners and
assumes the full 5-level walk per node.) **Treat `node-sweep-smoke.ts`'s printed estimate as
authoritative** — it derives passes from `listGemini3xModels()` and self-updates; the
earlier "~13h / 16-pass" figure assumed the deleted 6-rung ladder and is stale. Run the
2-pass smoke first to confirm ε actually shrank under bypass, then the full sweep, and
replace the held `sqlGenerator`/`supervisor` defaults in `src/agents/nodeProfiles.ts` only
if a downsize holds within the now-smaller ε.

## Proven vs. provisional — the load-bearing caveat

- **Proven:** the right-sizing *machinery* (calibration, per-node ladder sweep,
  decision rule, combined-pass revert cascade, report generation) works end-to-end
  and is regression-tested. The runtime registry + seam + telemetry are wired and
  tested. As of the 2026-06-08 live run, the machinery has been exercised against real
  Gemini 3.x, and the two universal classifier nodes are now **measured** picks.
- **Provisional:** the SQL-path reasoning nodes (`sqlGenerator`, `supervisor`) remain
  **unsized** — the 12-question corpus inflates ε past any usable quality delta, so
  they are held at `PRO_DEFAULT` rather than downsized on noise. The un-corpus'd nodes
  (`dbtStatus`, `chart`, `summaryOverride`, `metaQuestion`, `teachingCandidate`,
  `discrepancy`) keep their role-based heuristic defaults.

**To finish the job for real:** expand `benchmarks/corpus.json`, re-run
`npx tsx scripts/node-sweep.ts` (Task 8 — explicitly not in CI), and replace the held
reasoning-node defaults with measured picks from
`benchmarks/results/node-sweep-<date>.md` once ε is small enough to trust.

## Verification at completion

- `npm run typecheck` clean; `npm test` → full suite passing.
- Commits this work: `0dca832` (Phase C), `7ad57fa` (Phase D), `af774be` (Phase E);
  live sizing run + universal floor-up sweep land the measured classifier defaults.

## Two-stage redesign (2026-06-08)

An adversarial re-read of the sweep surfaced **two structural flaws in the diagonal
ladder** (`DEFAULT_LADDER`), serious enough to rebuild the search core:

1. **Incomplete model coverage.** The hand-authored ladder sampled only **3 of the 4**
   Gemini 3.x models (no `flash/3.5`) — so the sweep could never have recommended a model
   it was supposed to choose among.
2. **Confounded axes.** Each ladder step changed model *and* thinking together, so a
   quality move could never be attributed to one axis. `thinkingLevel` was never sized in
   isolation; `default` (model-managed budget) wasn't even on the ladder.

**The fix — two-stage coordinate isolation** (replaces the diagonal descent):

- **Stage 1 (MODEL axis):** hold thinking at `STAGE1_ANCHOR = 'high'`, evaluate **all**
  models via `listGemini3xModels()` (the registry — coverage is now structurally complete,
  not a hand subset), pick the cheapest within ε of the best.
- **Stage 2 (THINKING axis):** hold the winning model fixed, walk every level incl.
  `default`, pick the fastest within ε. ~10 evals/node.
- Anchor is `high` deliberately (**capability-first**): credit each model's best-case
  capability before trimming thinking. Accepted caveat: greedy coordinate descent can miss
  a model×thinking interaction; `anchor=high` blunts the risk, ~10-vs-25 evals is the trade.
- The decision rule is `pickWithinEpsilon` (gate within ε of the **best observed** point on
  **both** the node metric and e2e; tie-break `'cost'` in Stage 1, `'latency'` in Stage 2).
- The same coverage fix landed in the judge-free classifier track: `universal-sweep.ts`
  `buildModelLadder()` enumerates all 4 models at a fixed `minimal` anchor, then floor-up.

**Single source of truth:** both sweeps enumerate `listGemini3xModels()` (derived from the
`modelConfig` registry), so partial model coverage is now structurally impossible — adding a
6th Gemini 3.x model to the registry automatically extends both sweeps.

**Engine built + unit-tested; live re-run still deferred** until `benchmarks/corpus.json`
grows (the corpus-size root cause above is unchanged — a bigger corpus shrinks ε so the
reasoning nodes become sizeable). New/changed modules: `node-sweep-types.ts` (drop ladder,
add `SweepProfile`/`PointScore`), `node-sweep-decision.ts` (`pickWithinEpsilon`),
`node-sweep.ts` (two-stage search + extracted `runCombinedVerification`),
`modelConfig.ts` (`listGemini3xModels`), `universal-sweep.ts`/`universal-sweep-core.ts`
(`buildModelLadder`/`ModelRung`). All exercised by `tests/scripts/nodeSweep*.test.ts`,
`tests/scripts/universalSweep.test.ts`, and `tests/agents/modelConfig.test.ts`.
