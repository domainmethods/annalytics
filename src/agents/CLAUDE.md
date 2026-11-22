# Agents — per-node model sizing rules

Guidance for `nodeProfiles.ts`, `modelConfig.ts`, the `modelGateway` seam, and the
sizing scripts (`scripts/node-sweep.ts`, `scripts/universal-sweep.ts`). Read this
before changing a node's default tier/version/thinkingLevel or adding a node.

Full execution record + measured numbers: `docs/superpowers/plans/2026-06-07-node-sizing-eval-goal.md`.

## Template default vs NODE_PROFILE_OVERRIDES — the load-bearing rule

A `DEFAULTS` entry in `nodeProfiles.ts` ships to **every** install. Apply an
eligible template-set result only after checking the traps below.

- **Install-invariant → `MEASURED`.** The prompt and inputs use generic content,
  such as conversation text for routing or generic structure for rendering.
- **Install-coupled → `TEMPLATE-MEASURED (starting point)`.** This applies to
  `clarification`, `sqlGenerator`, `supervisor`, `discrepancy`, `dbtStatus`, and
  `teachingCandidate`. The template set has a real schema and non-empty fixtures.
  Difficulty still depends on the installed knowledge, schema, or run history.
  Installs are expected to size these nodes on their own data and set
  `NODE_PROFILE_OVERRIDES`.
  Production SQL generation gets organization knowledge through File Search, and the
  supervisor gets it through the generator's citations. The template set cannot replicate
  File Search and measures both nodes on schema-only questions and queries.
- **`PROVISIONAL`.** The default is based on the node's role and awaits sizing.

Once measured, each `DEFAULTS` entry comment must cite the set version and
measurement date. The [model refresh runbook](../../docs/model-refresh.md) covers
reviewing and applying the template results.

## Reading a sweep result — two traps

- **Flat-at-ceiling ≠ flat-at-floor.** Both look "flat across rungs," opposite meaning.
  Classifiers flat at **1.000** = cheapest model already wins → downsize is safe.
  `clarification` flat at **0.083** = every model (incl. pro/3.1/high) scores the same
  *low* value → no evidence the cheap model is *adequate*, only that it's no worse on a
  corpus that barely tests it. A flat-at-floor result blocks a default change.
- **Large ε makes `node-sweep`'s auto-verdict vacuous.** When ε(metric/e2e) is a large
  fraction of scale (`sqlGenerator` ε=0.33, `supervisor` ε=2.85 on the 12-question
  corpus), the quality gate passes everything "within ε" and the cost tie-break hands
  back the cheapest point as a fake downsize. An earlier run printed "ACCEPTED — downsize
  all three"; only `clarification` (ε=0.01) was real. **For template results,
  ε > 0.05 on the 0–1 metric blocks a change.** For install-corpus sizing, grow
  the corpus if ε exceeds a meaningful quality delta. Those ε figures used the old max-per-case band;
  since 2026-11-21 `computeEpsilon` measures noise on the mean (`2·sd(paired diffs)/√n`),
  because one flipped case under the old band tied every candidate (governance Evidence Log).

## Two-stage coordinate isolation (the sweep search shape)

`node-sweep.ts` no longer walks a hand-authored diagonal "ladder". The old ladder had
two flaws now both fixed: it covered only **3 of the 4** Gemini 3.x models, and each step
changed model **and** thinking together, so a quality move could never be attributed to
one axis (`thinkingLevel` was confounded with tier — never sized in isolation). The sweep
now separates the axes:

- **Stage 1 — MODEL axis.** Hold thinking at a fixed anchor (`STAGE1_ANCHOR = 'high'`),
  evaluate all non-retired models (`listRegisteredModels()` — the registry, so coverage can't
  silently drop a model), pick the cheapest within ε of the best (`pickWithinEpsilon`,
  `'cost'`). Anchor is `high` on purpose — **capability-first**: give every model ample
  reasoning so the comparison reflects best-case capability, then trim.
- **Stage 2 — THINKING axis.** Hold the winning model fixed, walk every level incl.
  `default` (model-managed budget — now actually tested), pick the fastest within ε
  (`pickWithinEpsilon`, `'latency'`, 5% latency band). ~10 evals/node total.

`universal-sweep.ts` (judge-free classifiers) got the same coverage fix: `buildModelLadder()`
enumerates non-retired models via `listRegisteredModels()` at a fixed `minimal` anchor (or `default` where the model lacks `minimal`), then floor-up
picks the cheapest that clears exact-match accuracy.

**Residual caveat (documented, accepted):** this is greedy coordinate descent, not a full
model×thinking grid, so it can miss an interaction where a pricier model would have won
only at a level the anchor didn't use. `anchor=high` is what blunts that risk; the ~10-vs-25
evals/node saving is the deliberate trade.

Template refresh uses the same two-stage engine for all 12 nodes. The first live
template refresh is pending. Install-corpus sizing for the reasoning nodes still
requires enough cases to bound ε.

## Judge-free sizing for install-invariant classifiers

`slackIntake`/`followUpClassifier` have objectively-checkable labels (route/intent), so
`scripts/universal-sweep.ts` sizes them with **exact-match accuracy and no LLM judge** —
immune to the ε(e2e) judge noise that sinks the SQL-path reasoning nodes. Both scored
1.000 at every rung on the 2026-06-08 corpus, which was too easy to separate models.
The harder tv-v1 pilot intake items (2026-11-19) moved the template default
(`CLASSIFIER_LITE`) to `flash-lite/3.5`@low: 0.975 vs 0.950 for `flash-lite/3.1`@minimal.
For intake, latency matters as much as accuracy: models that blow the 8s
`INTAKE_TIMEOUT_MS` lose to smaller ones, so higher thinking is not free here.
Keep corpora template-safe (generic metrics, no client names/IDs); `benchmarks/results/`
is gitignored on purpose.
