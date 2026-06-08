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

## Proven vs. provisional — the load-bearing caveat

- **Proven:** the right-sizing *machinery* (calibration, per-node ladder sweep,
  decision rule, combined-pass revert cascade, report generation) works end-to-end
  and is regression-tested. The runtime registry + seam + telemetry are wired and
  tested.
- **Provisional:** the per-node *default thinking levels* are role-based heuristics,
  **not** measured. No live Gemini 3.x credentials were available in this
  environment, so the sizing exercise ran against a synthetic corpus model that
  validates orchestration, not real per-node quality/latency/cost.

**To finish the job for real:** run `npx tsx scripts/node-sweep.ts` with live
Gemini 3.x credentials (Task 8 — explicitly not in CI), then replace the provisional
`thinkingLevel` defaults in `src/agents/nodeProfiles.ts` with the measured picks
from `benchmarks/results/node-sweep-<date>.md`. Tiers should change only if the
live sweep shows a tier downsize holds within ε.

## Verification at completion

- `npm run typecheck` clean; `npm test` → 719 passing (102 files).
- Commits this work: `0dca832` (Phase C), `7ad57fa` (Phase D), `af774be` (Phase E).
