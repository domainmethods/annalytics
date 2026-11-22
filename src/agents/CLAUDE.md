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
  Classifiers flat at **1.000** on the 2026-06-08 corpus = cheapest model already wins
  *on that corpus* → downsize was safe there; a harder set can separate them (below).
  `clarification` flat at **0.083** = every model (incl. pro/3.1/high) scores the same
  *low* value → no evidence the cheap model is *adequate*, only that it's no worse on a
  corpus that barely tests it. A flat-at-floor result blocks a default change.
- **Large ε makes `node-sweep`'s auto-verdict vacuous.** When ε(metric/e2e) is a large
  fraction of scale (`sqlGenerator` ε=0.33, `supervisor` ε=2.85 on the 12-question
  corpus), the quality gate passes everything "within ε" and the cost tie-break hands
  back the cheapest point as a fake downsize. An earlier run printed "ACCEPTED — downsize
  all three"; only `clarification` (ε=0.01) was real. **For template results,
  ε > 0.05 on the 0–1 metric blocks a change.** For install-corpus sizing, grow
  the corpus if ε exceeds a meaningful quality delta. The ε figures above (`sqlGenerator` 0.33, `supervisor` 2.85, `clarification` 0.01) used the old max-per-case band;
  since 2026-11-21 `computeEpsilon` measures noise on the mean (`2·√Σd²/n` over paired diffs, centered on 0),
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
The frozen tv-v1 sweep (2026-11-22, ε 0.01) measured both, plus `ambiguityClassifier`.
`slackIntake` stays at `flash-lite/3.5`@low and `followUpClassifier` moved to
`flash/4-hydrogen`@low. Both are owner overrides of the sweep's cost tie-break,
made for model-sunset risk rather than for score. `ambiguityClassifier` stays
provisional because its ε was 0.054 (governance Evidence Log, 2026-11-22).
**Sunsets live in the registry.** A `RegisteredModel` can carry `sunset`
(`shutdownDate`, `replacement`), copied by hand from
https://aistudio.google.com/docs/deprecations. Stage 1's cost tie-break ranks a model
with a `shutdownDate` after every other viable model, though it still sets the quality
bar. The refresh report withholds a dated pick and notes a dateless one, and
`model:discover` lists both and fails when a template default is within 90 days of its
shutdown. The page is still the source: re-read it during every refresh.
For intake, latency matters as much as accuracy: models that blow the 8s
`INTAKE_TIMEOUT_MS` lose to smaller ones, so higher thinking is not free here.
Keep corpora template-safe (generic metrics, no client names/IDs); `benchmarks/results/`
is gitignored on purpose.
