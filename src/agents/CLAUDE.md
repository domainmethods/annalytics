# Agents — per-node model sizing rules

Guidance for `nodeProfiles.ts`, `modelConfig.ts`, the `modelGateway` seam, and the
sizing scripts (`scripts/node-sweep.ts`, `scripts/universal-sweep.ts`). Read this
before changing a node's default tier/version/thinkingLevel or adding a node.

Full execution record + measured numbers: `docs/superpowers/plans/2026-06-07-node-sizing-eval-goal.md`.

## Template default vs NODE_PROFILE_OVERRIDES — the load-bearing rule

A `DEFAULTS` entry in `nodeProfiles.ts` ships to **every** install of this template.
A measured pick may become a template default **only if both** hold:

1. **Install-invariant** — the node's prompt/inputs contain **zero install-specific
   content**. Test it by reading what the agent feeds the model:
   - ✅ eligible: routes/formats on the **conversation or generic structure** alone —
     `slackIntake` (message text), `followUpClassifier` (thread + message),
     `chart`/`summaryOverride` (generic rendering). Difficulty is fixed by language,
     identical everywhere.
   - ❌ override-only: prompt is **parameterized by per-install data** — `clarification`
     injects `teachingSummaries` (ReferenceCards + Teachings) as "AVAILABLE CONTEXT";
     `sqlGenerator`/`supervisor`/`discrepancy` consume the retrieved dbt schema;
     `dbtStatus` consumes run history. Their task difficulty (and therefore the right
     model size) scales with the installed knowledge/schema, which this template does
     **not** contain. Size these per-install via `NODE_PROFILE_OVERRIDES`, never a default.
2. **Clean signal** — see the interpretation traps below.

The trap to refuse: a node can have a pristine measurement and still fail test #1.
`clarification` had the cleanest signal in the whole SQL sweep (ε=0.01) and is **still**
an override, because its difficulty is set by the install's knowledge layer — which this
template deliberately ships empty (client ReferenceCards are forbidden here), so the sweep
measured it at minimum difficulty. Don't generalize an empty-corpus pick to every install.

## Reading a sweep result — two traps

- **Flat-at-ceiling ≠ flat-at-floor.** Both look "flat across rungs," opposite meaning.
  Classifiers flat at **1.000** = cheapest model already wins → downsize is safe.
  `clarification` flat at **0.083** = every model (incl. pro/3.1/high) scores the same
  *low* value → no evidence the cheap model is *adequate*, only that it's no worse on a
  corpus that barely tests it. Never downsize on a flat-at-floor result.
- **Large ε makes `node-sweep`'s auto-verdict vacuous.** When ε(metric/e2e) is a large
  fraction of scale (`sqlGenerator` ε=0.33, `supervisor` ε=2.85 on the 12-question
  corpus), the quality gate passes everything "within ε" and the cost tie-break hands
  back the cheapest rung as a fake downsize. The script printed "ACCEPTED — downsize all
  three to R0"; only `clarification` (ε=0.01) was real. **Do not trust the auto-verdict
  when ε ≳ a meaningful quality delta.** Root cause is corpus size, not the judge — grow
  `benchmarks/corpus.json` before trying to size the reasoning nodes.

## Judge-free sizing for install-invariant classifiers

`slackIntake`/`followUpClassifier` have objectively-checkable labels (route/intent), so
`scripts/universal-sweep.ts` sizes them with **exact-match accuracy and no LLM judge** —
immune to the ε(e2e) judge noise that sinks the SQL-path reasoning nodes. Both scored
1.000 at every rung → `flash-lite/3.1`/minimal template default (`CLASSIFIER_LITE`).
Keep corpora template-safe (generic metrics, no client names/IDs); `benchmarks/results/`
is gitignored on purpose.
