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
