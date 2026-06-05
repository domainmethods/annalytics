# Anna Lytics Trajectory Governance

**Created:** 2026-06-04
**Status:** Governing roadmap checkpoint
**Applies to:** Product design, implementation plans, code review, benchmark work, teaching updates, and future Phase 3+ feature proposals.

This document records the current development trajectory for Anna Lytics after review of Anthropic's self-service analytics operating model and the follow-up adversarial audit. Read this before proposing or implementing a new tranche. Update it whenever a major product direction, feature deferral, benchmark result, or adversarial audit changes the trajectory.

## Current Decision

The next development cycle should continue to prioritize trust infrastructure over feature expansion.

The **Revenue ReferenceCard v1 Trust Tranche** and the deterministic **ReferenceCard Evidence Acceptance** analyzer are implemented. The **Revenue ReferenceCard Acceptance Run** has a recorded `NEEDS_REVISION` decision as of 2026-06-04.

The active next tranche is scoped repair of the failing evidence categories from that acceptance report: benchmark/runtime configuration, ReferenceCard retrieval metadata, table selection, SQL shape, and validation metadata.

Do not add another reference-card domain, revive Phase 3 feature expansion, or promote a new runtime behavior until a revised revenue pilot run records an `ACCEPTED` decision or this document is updated with new evidence and rationale.

After the revenue pilot decision is recorded, the trajectory branches:

- If the revenue pilot is `ACCEPTED`, the next product tranche may add exactly one additional high-confusion ReferenceCard domain.
- If the revenue pilot is `NEEDS_REVISION`, the next tranche should be scoped repair of the failing evidence category: card content, prompt behavior, retrieval, table selection, SQL shape, or validation metadata.

## Strategic Rationale

Anna Lytics already has the core self-serve analytics shape: Slack-native intake, dbt metadata, validated SQL generation, supervisor review, escalation, teachings, and response transparency. The highest-leverage gap is not another answer format. It is making the system more governable, measurable, and semantically grounded.

Borrow from Anthropic's self-service analytics approach at the operating-model level:

- Curated, retrievable semantic references that encode how the business defines metrics and tables.
- Human-reviewed knowledge updates instead of broad automatic correction harvesting.
- Evaluation loops that prove whether references and teachings improve answer quality.
- Provenance that helps users and analysts understand why an answer can be trusted.
- Maintenance workflows that keep analytics knowledge fresh and safe to sync.

## Current Tranche

### Revenue ReferenceCard Acceptance Run

Convert the implemented revenue ReferenceCard and deterministic analyzer into recorded evidence before expanding scope.

Scope:

- Execute the real revenue benchmark that emits ReferenceCard retrieval, table-selection, SQL-shape, validation-layer, and provenance fields.
- Run `scripts/benchmark-analyze.ts` against the saved benchmark JSON.
- Review the generated `*-referencecard-acceptance.md` report.
- Update this document with the dated acceptance decision, benchmark artifact path, evidence source, and next branch.

Acceptance criteria:

- A real benchmark JSON exists under `benchmarks/results/`.
- The analyzer writes both `*-summary.md` and `*-referencecard-acceptance.md`.
- The acceptance report returns either `ACCEPTED` or `NEEDS_REVISION`.
- This governance document records the decision and whether the next tranche is one-domain expansion or scoped repair.

Recorded decision on 2026-06-04:

- Decision: `NEEDS_REVISION`.
- Benchmark JSON: `benchmarks/results/2026-06-04.json`.
- Summary report: `benchmarks/results/2026-06-04-summary.md`.
- Acceptance report: `benchmarks/results/2026-06-04-referencecard-acceptance.md`.
- Evidence source: setup-enabled local benchmark rerun using git SHA `5c727002aa91d3f58762396408ccf2354792c5c2`, dirty state `true`, `GCP_PROJECT_ID=dm-website-426721`, `FILE_SEARCH_STORE_ID=fileSearchStores/annalyticsknowledge-s7el62hneuh6`, generated dbt artifact hashes, and `npx tsx scripts/benchmark-analyze.ts benchmarks/results/2026-06-04.json`.
- Evidence summary: the analyzer evaluated 5 revenue ReferenceCard cases and returned `NEEDS_REVISION`; failures included ReferenceCard retrieval misses, table mismatches, SQL-shape mismatches, one quality-loop exhaustion, and final validation failures for the refunds/exclusions case. The run loaded the dm-website/domainmethods dbt artifacts, which do not expose the expected `analytics.fct_orders`, `analytics.fct_revenue`, or `analytics.dim_customers` tables referenced by the revenue ReferenceCards and corpus.
- Next branch: scoped repair of the failing evidence categories before any additional ReferenceCard domain is added. First repair should either provide the intended revenue warehouse dbt artifacts/File Search content or retarget the revenue ReferenceCards and corpus to the actual dm-website dbt schema.

### ReferenceCard v1 Foundation

Build a small typed reference layer before adding broad new product behavior.

Scope:

- Start with one high-confusion domain.
- Create 5-10 cards maximum for the first pass.
- Prefer concise, retrieval-friendly cards over long generic domain documentation.
- Treat cards as product primitives that must be cited, measured, and maintained.

Suggested fields:

- `id`
- `title`
- `domain`
- `grain`
- `canonical_table`
- `canonical_metric`
- `required_filters`
- `exclusions`
- `avoid_tables`
- `aliases`
- `routing_triggers`
- `owner`
- `freshness_sla`
- `related_teachings`
- `updated`

Acceptance criteria:

- Cards are schema-validated in CI.
- Cards can be retrieved or cited in benchmark records.
- At least one benchmark slice shows whether they improve SQL/table/filter choices.
- Ownership and freshness are explicit.

### Benchmark Hardening

Benchmarks must become decision support, not just a pass/fail script.

Maintain:

- Git SHA and dirty state.
- Corpus hash.
- dbt manifest/catalog hashes when available.
- Model names and File Search store ID.
- Validation-layer outcomes for L1, L2, L3, and L4.
- Expected teaching or reference IDs for cases where retrieval matters.

Acceptance criteria:

- Benchmark records explain which validation layer failed.
- Advisory L2 failures remain visible without changing runtime behavior.
- Run provenance is enough to compare two benchmark runs defensibly.

### Teaching Validation Gates

Teachings are production knowledge. They must be validated before sync.

Maintain checks for:

- Duplicate IDs.
- Non-empty question patterns.
- Required `updated` date.
- Valid dbt model/table references when dbt artifacts are available.
- BigQuery dry-run validation for sanctioned SQL when GCP credentials are available.
- CI authentication for GCP-backed validation and Firestore/File Search sync.

Missing compiled dbt artifacts in CI should not block structural validation, but should skip only the table-reference portion.

## Deferred Work

The following are not the next tranche:

- Broad chart-generation expansion.
- BQML prediction expansion as a product priority.
- Domain agents or general documentation routers.
- Automatic correction harvesting from binary feedback.
- Verbose provenance footers on every Slack answer.
- Wide production-corpus ingestion without privacy-safe feedback events.

These may still be valid later, but only after the current trust/evaluation/content tranche produces evidence that the foundation is working.

## Product Guardrails

Use these guardrails when reviewing future plans:

1. Trust before surface area. Prefer changes that improve correctness, maintainability, provenance, or evaluation over new output modes.
2. One domain before many. Prove the content primitive in a narrow domain before generalizing.
3. Human-reviewed knowledge before automatic learning. Do not promote corrections into production retrieval without structured, privacy-safe review.
4. Compact provenance by default. Surface trust context when it changes interpretation; keep detailed reasoning behind the existing reasoning path.
5. Benchmarks decide sequencing. Do not promote a new content primitive or feature without benchmark evidence or a clear manual acceptance criterion.
6. Update governance before reviving deferred work. If charts, BQML, domain agents, or broad correction harvesting become active again, explain why in this document first.

## Maintenance Protocol

Update this document when any of the following happens:

- An adversarial audit changes the recommended tranche.
- A benchmark run changes the priority order.
- A deferred feature becomes active.
- A trust, privacy, or teaching-sync risk is discovered.
- A new reference-card schema or teaching schema is accepted.
- The product no longer uses Slack-native self-serve analytics as its primary interface.

Every update should include:

- The date.
- The decision.
- What changed.
- What remains deferred.
- The evidence source, such as benchmark output, code review, production incident, or analyst review.

## Current Implementation Notes

As of 2026-06-04:

- The `Revenue ReferenceCard v1 Trust Tranche` is implemented.
- The deterministic `ReferenceCard Evidence Acceptance` analyzer is implemented by `scripts/benchmarkAcceptance.ts`, `scripts/benchmark-analyze.ts`, and focused benchmark script tests.
- The `Revenue ReferenceCard Acceptance Run` produced `benchmarks/results/2026-06-04.json`, `benchmarks/results/2026-06-04-summary.md`, and `benchmarks/results/2026-06-04-referencecard-acceptance.md`.
- The selected next tranche is scoped repair of the `NEEDS_REVISION` acceptance evidence.
- Mock acceptance artifacts live under `benchmarks/mock-results/` and exercise both `ACCEPTED` and `NEEDS_REVISION` analyzer branches without external services. They do not count as live revenue acceptance evidence.
- Live-run preflight on 2026-06-04 used the active gcloud project as `GCP_PROJECT_ID` and ran `npx tsx scripts/benchmark.ts`; the run stopped before benchmark execution because `GEMINI_API_KEY` was not present in the local environment. A continuation check on 2026-06-04 confirmed no local `.env` file beyond `.env.example`, no `benchmarks/results/*.json` artifact, no visible GitHub repository secrets for the active repo, and no Gemini/File Search-relevant Secret Manager names in the active gcloud project.
- The acceptance run resumed on 2026-06-04 by explicitly sourcing a gitignored repo-root `.env` with `GCP_PROJECT_ID` and `GEMINI_API_KEY` present. `FILE_SEARCH_STORE_ID` was not present. The live benchmark reached corpus execution and wrote a real result artifact, but all cases exhausted because `gemini-3.0-flash` was not available for `generateContent` in the configured API surface.
- A later setup pass on 2026-06-04 enabled Firestore and Secret Manager APIs in `dm-website-426721`, created a Firestore Native `(default)` database in `us-west1`, deployed the required composite Firestore indexes, generated dm-website/domainmethods dbt artifacts, created a Gemini File Search store ID in the gitignored local `.env`, and reran `npx tsx scripts/benchmark.ts`.
- That rerun produced a real benchmark artifact and acceptance report with metadata for `FILE_SEARCH_STORE_ID`, dbt manifest hash, and dbt catalog hash, but the report still returned `NEEDS_REVISION`. File Search document upload remained blocked by Gemini API `500 INTERNAL` responses during sync probes, leaving the store empty; additionally, the live dm-website/domainmethods dbt schema does not contain the revenue pilot's expected `analytics.fct_orders`, `analytics.fct_revenue`, or `analytics.dim_customers` tables.
- Failed escalation SQL is tracked as `failedSql`, not `finalSql`, when generating teaching candidates.
- Chart rendering uses `@resvg/resvg-js` to preserve distroless runtime compatibility.
- Chartability scans across result rows rather than trusting the first row.
- The quality loop emits validation-layer history for benchmark reporting.
- Teaching validation exists before File Search sync.
- Sync workflow uses Google GitHub Actions OIDC authentication before GCP-backed validation and Firestore sync.
- The Revenue ReferenceCard v1 Trust Tranche is implemented by `references/revenue.yml`, `src/references/`, knowledge sync scripts, and benchmark reference-card retrieval fields.
- Legacy teaching-only sync preserves `reference_card:*` documents by deleting only `teaching:*` documents; full knowledge sync remains responsible for replacing the shared store.
- Knowledge sync validates environment and initializes Firestore before mutating File Search, reducing partial-sync failure states.
- Benchmark table observations are derived from generated SQL rather than model-reported `tables_used`; revenue ReferenceCard cases include table-specific SQL-shape expectations.
- Pull request CI runs `scripts/validate-knowledge.ts` so malformed teaching or reference YAML is caught before merge, while missing dbt artifacts skip only artifact-aware checks.
- Evidence source for this update: `benchmarks/results/2026-06-04.json`, `benchmarks/results/2026-06-04-summary.md`, and `benchmarks/results/2026-06-04-referencecard-acceptance.md`.

## Relationship to Existing Docs

- `.spec-workflow/steering/product.md` remains the product overview.
- `CLAUDE.md` remains the agent-facing implementation guide.
- `docs/superpowers/specs/2026-03-24-phase3-features-design.md` and `docs/superpowers/plans/2026-03-24-phase3-features.md` are historical Phase 3 feature docs. They are not the active next-tranche authority while this governance checkpoint is in force.
