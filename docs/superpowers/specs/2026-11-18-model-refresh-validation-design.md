# Repeatable Model Refresh via a Quorum-Labeled Template Validation Set — Design

**Date:** 2026-11-18
**Status:** Approved 2026-11-18; amended at planning (see "Planning amendments")
**Plan:** `docs/superpowers/plans/2026-11-18-model-refresh-validation.md`
**Builds on:** `docs/superpowers/plans/2026-06-07-node-sizing-eval-design.md` (registry +
gateway + sweeps), `src/agents/CLAUDE.md` (template-default rule)

## Intent

The template's per-node model defaults in `src/agents/nodeProfiles.ts` are out of date.
They are pinned to Gemini 3.x preview IDs (`gemini-3-flash-preview`, `gemini-3.1-pro-preview`).
The live model list on 2026-11-18 also offers `gemini-3.5-flash-lite`, `gemini-3.6/3.7/3.8-flash`,
the `gemini-4-{argon,carbon,hydrogen,neon}` family, and `*-latest` aliases. Model
obsolescence will keep happening, and this repo is a **public template**. That means:

- defaults must be justified by evidence that can be committed publicly (no client data);
- nine of the twelve nodes have never been measured, mostly because there is no labeled
  data to measure them against;
- the owner does not have time to hand-label data.

The goal is a **repeatable refresh procedure**. When new models appear, an operator can
discover them, register them, run the sweeps against a **fixed, committed validation
set**, and update every node's template default from a report. The validation set is
**labeled once by a consensus quorum of trusted LLMs**, not by a human.

A template default from this procedure means: *a sensible, measured starting point on
generic data*. Installs can still size the install-coupled nodes against their own
data via `NODE_PROFILE_OVERRIDES`.

## Goals

1. All 12 `generateForNode` nodes have a template default backed by a measurement on the
   template validation set, tagged with the set version and date.
2. A committed, versioned, template-safe validation set covering all 12 nodes, labeled by
   an LLM quorum, with provenance and per-item agreement recorded.
3. Scorers that are judge-free wherever the node allows it (exact match, executed-result
   equivalence, rule checks). A judge is used only for the free-text nodes, and the report
   flags those results as the weaker signal.
4. A documented refresh runbook (discover → register → sweep → review → apply) that a
   future operator can follow without re-deriving this design.
5. Model discovery that does not require hand-transcribing docs: diff the live model list
   against the registry, and **probe** each new model's supported thinking levels.

## Non-goals

- Auto-applying new defaults. A human reviews the report and edits `nodeProfiles.ts`.
- Running other providers' models at runtime. Runtime stays Gemini-only. Other families
  appear **only** as labelers, reached through the developer's local agent CLIs.
- Automating labeling. It is a developer-run, attended step.
- Replaying production traffic, shadow-mode evaluation, scheduled re-sweeps.
- Human labeling now. Items the quorum disagrees on are set aside for optional later review.
- Re-labeling on every refresh. The set changes only with an explicit version bump.

## Anti-goals (a failure even if it technically works)

- Labels that drift between refreshes, so a changed default can't be attributed to the model.
- Any client data, project ID, ReferenceCard, or install-specific schema in the set.
- A default changed on a flat-at-floor result or with a vacuous ε (the traps in
  `src/agents/CLAUDE.md` still apply).
- A quorum made only of the candidate family **without** that being flagged in the set's
  provenance and the report.
- Swapping in the newest model without measuring it.

## Constraints

- Only `GEMINI_API_KEY` + `GCP_PROJECT_ID` are available; `@google/genai` is the only LLM dependency.
- `docs/trajectory-governance.md` orders net-new sizing machinery last. **This change set must
  update the governance doc** (Current Decision #2 / T3 queue / Deferred Work table), with
  model obsolescence as the reason. The `src/agents/CLAUDE.md` template-default rule must be
  amended in the same change set (see "Rule change").
- Module boundaries in the root `CLAUDE.md` hold. Labeling code lives in `scripts/` and never
  in `src/`. **No new LLM SDK dependency.** Non-Gemini labelers are reached through agent CLIs
  the developer already has installed and signed in. Vertex AI is disabled on the current
  project, and that's fine, because this design doesn't use it.
- **Refresh reports are not committed** (owner decision). They stay in the gitignored
  `benchmarks/results/`. The existing "no benchmark evidence" rule in the root `CLAUDE.md`
  stands unchanged. The committed validation set (items + provenance) **is** allowed: it is
  test data on a public dataset, not results.
- Existing `NODE_PROFILE_OVERRIDES` / `MODEL_ID_OVERRIDES` values in deployed installs must
  keep parsing (they use `{tier, version, thinkingLevel}` and `"tier/version"` keys).
- Don't run the two sweeps concurrently (shared quota; existing note in `universal-sweep.ts`).

## Approaches considered

- **A. Extend the two existing sweeps (chosen).** Add a committed template validation set and
  a one-off quorum labeling script. `universal-sweep` absorbs the closed-set and rule-scored
  nodes; `node-sweep` reads the SQL-path set. Least new code; reuses ε calibration, two-stage
  search, and model-aware thinking levels. Cost: each new kind of node needs a scorer added by
  hand to one of two scripts.
- **B. One sweep runner with a small adapter for each node.** Cleaner long term, but it rewrites
  working, hard-won tools before any new default ships. Can be migrated to later if node types
  keep multiplying.
- **C. Re-label on every refresh with the newest quorum.** Rejected: labels would move each time,
  which defeats the static-set requirement and makes changes unattributable.

Chosen by owner: **A**.

## Planning amendments (2026-11-18)

Writing the plan surfaced facts that change parts of the design below. Where a section
below conflicts with this list, this list wins.

1. **One sizing engine in template mode.** Every node, including the two classifiers,
   is sized in template mode by `node-sweep`'s existing `runSweep` (ε calibration on two
   baseline runs, two-stage search, `pickWithinEpsilon`), each with a per-node scorer.
   `universal-sweep` is **not** extended; it stays as-is for its existing install-corpus
   classifier sizing. Reason: §5 already requires every template node to use `runSweep`'s
   rule, so a second engine would only duplicate it. `sweep:template` therefore runs
   `node-sweep --corpus template` alone. This still counts as approach A (reuse the existing
   engine, add a set + labeling script), with less new code.
2. **Warehouse = views in the operator's project.** The dbt parser names tables
   `schema.name` with no project, so models can't point at `bigquery-public-data` directly.
   `tv:setup` creates a `tv_thelook` dataset of `SELECT *` views over the public tables in
   the operator's project. The template-safety allowlist is `tv_thelook.*` plus
   `bigquery-public-data.thelook_ecommerce.*`.
3. **No dbt install.** The committed `manifest.json`/`catalog.json` are generated by a
   script from a hand-written `models.yml` + `INFORMATION_SCHEMA.COLUMNS`, and
   round-trip tested through `parseDbtArtifacts`.
4. **`teachingCandidate` label.** `generateTeachingCandidate` always returns a candidate,
   so "should-create yes/no" is measured as "`sanctionedSql` present vs null", plus
   `requiredModels ⊆ modelsReferenced`.
5. **`summaryOverride` is extracted** into `src/agents/summaryAgent.ts`
   (`summarizeResults`) so it can be called by the runner; `responseOverrides.ts` behavior
   is unchanged.
6. **`sqlGenerator` items bypass clarification.** `clarification` is sized on its own
   items; on `sqlGenerator` items it would only add noise (a suspension scores 0), so the
   template `sqlGenerator` runner bypasses it.

## Design

### 1. Model registry generalization (`src/agents/modelConfig.ts`)

The registry outgrows its "3.x" naming and its tier-from-name assumption (e.g. Gemini 4 uses
codenames).

- Each entry carries: `id`, cost tier (`flash-lite | flash | pro`, **assigned by hand** when
  registering; the name is never parsed), `version` key, supported thinking levels,
  **per-Mtoken input/output price**, and `status: 'candidate' | 'default-eligible' | 'retired'`.
- Rename `listGemini3xModels` → `listRegisteredModels` (keep a deprecated alias for one
  release, or update all callers; builder's call). It returns non-retired entries, cheapest tier first.
- `MODEL_THINKING_LEVELS` merges into the entry. The parity test becomes "every entry declares
  its thinking levels."
- Real prices replace the placeholder `TIER_PRICES` in `node-sweep.ts`; the sweep reads
  prices from the registry.
- `*-latest` aliases are **not** registered: a default must pin a concrete model.
- `.env.example` and the `DEFAULT_FLASH_MODEL` / `DEFAULT_PRO_MODEL` constants follow whatever
  the refresh picks.

### 2. Model discovery (`scripts/model-discover.ts`, new)

- Lists live models via `ai.models.list()` and filters to text `generateContent` models
  (excludes `image`, `tts`, `transcribe`, `computer-use`, `robotics`, `nano-banana`, `omni`,
  `customtools`, `-latest`).
- Prints: new (not in registry), missing (registered but no longer live — a deploy risk), unchanged.
- For each new model, **probes** thinking levels by sending a tiny request at each of
  `minimal|low|medium|high` and recording which ones are rejected. Output is a ready-to-paste
  registry entry (tier and price left as `TODO` for the operator).
- Read-only. Never edits source.

### 3. Template validation set (`benchmarks/template-validation/`, new, committed)

**Warehouse:** `bigquery-public-data.thelook_ecommerce` (orders, order_items, users, products,
inventory_items, events, distribution_centers). It is relational (exercises joins), small
(cheap dry-runs and executes), and public. A minimal **template dbt project** under
`benchmarks/template-validation/dbt/` documents those tables as dbt sources/models with
descriptions and columns. Its compiled `manifest.json` + `catalog.json` are committed so the
SQL-path nodes see a realistic semantic layer. Models point straight at the public tables
(no materialization), so generated SQL can be dry-run and executed with the operator's own
BigQuery billing. thelook data is regenerated by Google over time. That's fine, because
equivalence is computed **at sweep time** by executing both reference and candidate SQL,
never against stored numbers.

**Layout:**

```
benchmarks/template-validation/
  VERSION                      # e.g. v1; bump = relabel
  provenance.json              # quorum members (exact model ids), dates, agreement stats, singleFamily flag
  dbt/                         # template dbt project + compiled manifest/catalog
  fixtures/                    # synthetic dbt run history, ResponseContexts, escalation resolutions
  items/<nodeId>.jsonl         # accepted, labeled items, one file per node
  quarantine/<nodeId>.jsonl    # quorum-disagreement items with every member's label
```

**Per-node items and scorers:**

| Node | Item input | Label | Scorer | Signal |
|---|---|---|---|---|
| `slackIntake` | message text | route | exact | strong (fold in existing 14) |
| `followUpClassifier` | thread + message | intent | exact | strong (fold in existing 12) |
| `ambiguityClassifier` | ambiguous question | `user_intent \| org_knowledge` | exact | strong |
| `clarification` | question + template schema | suspends (LOW) vs proceeds | exact on that binary | strong |
| `teachingCandidate` | escalation resolution fixture | should-create yes/no + required fields | exact + field containment | strong |
| `sqlGenerator` | question + template schema | reference SQL | executed-result equivalence | strong |
| `supervisor` | question + candidate SQL (correct or deliberately broken) | accept / reject | exact | strong |
| `dbtStatus` | question + run-history fixture | required facts (model, status, time) | deterministic containment | medium |
| `chart` | question + result columns/rows | allowed chart types | rule check: spec compiles, encodings name real fields, type allowed | medium |
| `summaryOverride` | result rows | — | rule check: every number stated appears in the rows; + rubric | medium |
| `metaQuestion` | ResponseContext fixture + question | required-fact rubric | judge checks each fact | weak (flagged) |
| `discrepancy` | prior answer + complaint + seeded defect | defect to find + rubric | diagnostic SQL validates & executes; judge checks defect named | weak (flagged) |

**Result equivalence (SQL):** compare result sets as multisets of rows after normalization
(column order ignored, numeric tolerance 1e-6 relative, NULL-safe). Row order counts only when
the reference has `ORDER BY` with `LIMIT`. The candidate must pass the existing L1–L4 validation first.

**Supervisor items:** each "broken" item is built by a quorum member mutating a reference query
(wrong join key, missing filter, wrong grain). It is kept only if it passes validation **and** its
executed result differs from the reference. This keeps the supervisor's accept/reject label
grounded in execution, not opinion.

**Size targets:** about 40 items for each closed-set or rule node; about 100 for `sqlGenerator`
and `supervisor`, the amount expected to bring ε below a meaningful delta. The builder adjusts
based on the ε the first calibration run reports; the report must print ε for every node.

**Knowledge layer:** Production clarification receives ReferenceCards and Teachings as
`teachingSummaries`. Template clarification uses synthetic summaries from
`benchmarks/template-validation/knowledge/`. Some items must be ambiguous from the schema
and clear once the supplied ReferenceCard is applied.

Production `sqlGenerator` gets organization knowledge through File Search. The supervisor
gets that knowledge through the generator's File Search citations. The template set cannot
replicate File Search, so it measures SQL generation and supervisor review on schema-only
questions and queries. Drafting, mutation, and blind labeling for both nodes use the documented
schema and omit organization-specific definitions. The standalone supervisor runner reviews
the question and candidate SQL with no citations. Template mode ignores the installation's
knowledge and `FILE_SEARCH_STORE_ID`.

### 4. Quorum labeling (`scripts/label-quorum.ts`, new, run once per set version)

- **Generation:** one model drafts candidate item **inputs** per node from the template schema
  and fixtures, spread across the existing `CorpusEntry.category` values (simple / join /
  aggregate / time_series / ambiguous / edge_case).
- **Labeling:** each quorum member labels every item **independently and blind** to the others,
  at its highest thinking level.
- **Agreement rule (unanimous):**
  - closed-set labels: all members give the same label;
  - SQL: every member's query passes validation and the executed results are equivalent. The
    shortest valid query becomes the reference;
  - rubric facts: a fact is kept only if every member votes to keep it.
  - Anything else goes to `quarantine/`, with each member's label.
- **Labelers are local agent CLIs (owner decision).** Labeling is a dev-facing, attended
  step, so each quorum member is a coding-agent CLI the developer already has installed and
  signed in, run headless. No API keys or SDKs are added.

  | Labeler | Family | Headless invocation (verified flags, 2026-11-18) | Structured output | Lock-down |
  |---|---|---|---|---|
  | Claude Code (`claude` 2.1.x) | Anthropic | `claude -p --output-format json --model <m>` | `--json-schema` | no tools (`--tools ""` or deny-all `--disallowedTools`) |
  | Codex (`codex` 0.167.x) | OpenAI | `codex exec --json -m <m>` | `--output-schema <file>` | `-s read-only` |
  | Antigravity (`agy` 1.5.x) | Google | `agy -p --output-format json --model <m>` | `--json-schema` | `--mode plan` |
  | Gemini CLI (`gemini` 0.42.x) | Google | `gemini -p … -o json -m <m>` | none: parse and validate the result against the schema | `--approval-mode plan` |

  - **Adapter config:** `benchmarks/template-validation/labelers.json` holds one entry per
    labeler: `{id, family, argv template, schemaFlag, lockdownFlags, model}`. A new CLI or a
    flag change is a config edit, not a code change. `label-quorum` checks each configured
    CLI with `--version` at startup and reports which ones are usable.
  - **Isolation (keeps labelers blind):** each call runs with its working directory set to a
    fresh empty temp dir that holds only that batch's prompt + items. Tools are disabled or set
    read-only, so a labeler can't read the repo, other labelers' answers, or the existing
    labels, and can't run BigQuery itself. **The script, not the agent, executes SQL** for the
    equivalence check.
  - **Batching + resume:** items go in batches (about 20 per call). Each answer is cached by
    `(labelerId, model, itemHash, promptHash)` in a gitignored cache, so an interrupted run
    resumes without paying twice.
  - **Provenance:** for every member, record the CLI, CLI version, requested model, and the
    model the CLI reports in its JSON output (when it reports one).
  - **Quorum rule:**
    - Default: 3 members from 3 **distinct families**: Claude Code + Codex + one Google CLI
      (Antigravity preferred because it enforces the schema; Gemini CLI as fallback). All
      three must agree.
    - Minimum: 2 distinct families, recorded as `reducedQuorum: true`.
    - One family only: refused unless `--allow-single-family` is passed. Then it is recorded
      as `singleFamily: true`, and every report built on that set prints a warning.
    - Two CLIs from the same family (e.g. `agy` + `gemini`) count as one family.
- **Bias guard:** the report marks any node whose winning candidate is also a quorum member, and
  `provenance.json` records the per-category drop rate. Unanimity removes hard items more often,
  so a high drop rate on a category is a sign the set is skewed toward easy items.
- **Freezing:** the script writes items + provenance and stops. The set is committed. Sweeps
  record the set's content hash. Re-labeling requires bumping `VERSION`.
- **Template-safety check:** before writing, scan items for project IDs, emails, and anything
  outside `bigquery-public-data.thelook_ecommerce`; fail if found.

### 5. Sweep integration

- *(Superseded by planning amendment 1.)* `universal-sweep.ts` gains the closed-set and rule-scored nodes (`ambiguityClassifier`,
  `clarification`, `teachingCandidate`, `dbtStatus`, `chart`, `summaryOverride`) using the
  existing floor-up pick, plus the judge-scored `metaQuestion` and `discrepancy` behind a
  "weak signal" flag. (Builder's call whether the judge-scored pair lives here or in
  `node-sweep`, which already owns judge + ε logic.)
- `node-sweep.ts` gains `--corpus template`. This loads the template dbt artifacts plus
  `items/sqlGenerator.jsonl` and `items/supervisor.jsonl`, scores `sqlGenerator` by result
  equivalence, and scores `supervisor` **in isolation** on its accept/reject items. The
  existing two-stage search, ε calibration and `pickWithinEpsilon` are reused unchanged.
  `--bypass-clarification` stays available.
- Both sweeps enumerate `listRegisteredModels()` and model-aware thinking levels, so a newly
  registered model enters every sweep automatically.
- **Pass bar and ε (my call, after the builder check):** `universal-sweep`'s fixed
  `DEFAULT_THRESHOLD = 1.0` would reject everything on a quorum-labeled set of about 40 items.
  In template mode, every node uses the same rule:
  - calibrate ε by running the baseline (current default) twice on the node's own metric;
  - pick with `pickWithinEpsilon` (cheapest within ε of the best);
  - search in two stages: model axis, then the thinking axis on the chosen model, as
    `node-sweep` does today. `universal-sweep`'s `minimal`-only anchor applies only to its
    existing two classifiers.
  - **Meaningful delta = 0.05** on a 0–1 metric. The report marks a row *applicable* only if
    ε ≤ 0.05 and the result isn't flat-at-floor.
- **No judge in template mode for strong-signal nodes (my call):** for `sqlGenerator` and
  `supervisor`, ε and the pick use the node's own metric (result equivalence; accept/reject
  accuracy), not the judge's `overallScore`.
  - The `sqlGenerator` pass runs with `supervisor` held at its **current default**.
  - `supervisor` is sized in a separate isolated pass over its own items.
  - Combined verification then re-runs the `sqlGenerator` set with both picks applied, and
    reverts the `supervisor` pick if equivalence falls by more than ε.
  - The judge runs only for the weak-signal nodes.
- **Refresh report** (`benchmarks/results/<date>-model-refresh.md`, **gitignored, local only**,
  written by a small aggregator): one row per node with current default, recommended profile, metric for both,
  ε, signal strength, cost and p95 latency, quorum-member-winner flag, set version + hash.

### 6. Rule change (`src/agents/CLAUDE.md` + `nodeProfiles.ts` tags)

The current rule forbids template defaults for install-coupled nodes. Amend it:

- Install-invariant nodes measured on the template set → `MEASURED` (as today).
- Install-coupled nodes (`clarification`, `sqlGenerator`, `supervisor`, `discrepancy`,
  `dbtStatus`, `teachingCandidate`) measured on the template set → `TEMPLATE-MEASURED
  (starting point)`. Allowed as a default because the template set has a real schema and
  non-empty fixtures. Installs are still expected to size these
  via `NODE_PROFILE_OVERRIDES` against their own data.
- The flat-at-floor and vacuous-ε traps still block any change.
- Each `DEFAULTS` entry comment records the set version and date it was measured on.

### 7. Refresh runbook (`docs/model-refresh.md`, new; linked from README)

1. `npm run model:discover`: review new/missing models; paste probed entries; set tier + price
   from the live pricing page.
2. First time on a machine/project: `npm run tv:setup` (creates the `tv_thelook` views).
   Run `npm run tv:label` to build the initial set and when the set version changes.
   Verify all node item files and matching provenance before sweeping. Later refreshes
   reuse the completed frozen set.
3. `npm run sweep:template`: runs `node-sweep --corpus template` over all 12 nodes against
   the frozen set; writes the refresh report.
4. Use the report's final `Applicable` column. Apply eligible strong/medium rows. Weak
   rows need a judgment call, recorded in the commit. Follow the
   [runbook](../../model-refresh.md) for override cleanup and cross-pass details.
5. Edit `DEFAULTS`, the `.env.example` defaults, and `DEFAULT_*_MODEL`; mark superseded registry
   entries `retired` once no default or documented override uses them.
6. Commit only the default changes. Each `DEFAULTS` comment cites the validation-set version
   and the date measured (e.g. `TEMPLATE-MEASURED tv-v1 2026-12-02`). The report stays local.
7. Installs can export their environment, run `npm run node-sweep -- --corpus <path>`
   on their own corpus, and update overrides.

## Left to the builder

- Exact registry entry shape and the `version` key spelling for codenamed models, provided
  existing `tier/version` overrides keep parsing.
- Where the judge-scored nodes live (universal-sweep vs node-sweep).
- Fixture design for dbt run history, ResponseContexts, and escalation resolutions.
- Prompts for item generation, labeling, and SQL mutation.
- Exact lock-down flags for each CLI version (re-verify with `--help` at build time; the table
  above records what was true on 2026-11-18). Which labeler drafts the item inputs (any one;
  record it in provenance).
- Exact `npm run` script names.
- Final item counts once ε is measured.
