# Anna Lytics Trajectory Governance

**Created:** 2026-06-04
**Status:** Governing roadmap checkpoint
**Applies to:** Product design, implementation plans, code review, benchmark work, teaching updates, and future Phase 3+ feature proposals.

This document records the current development trajectory for Anna Lytics after review of Anthropic's self-service analytics operating model and the follow-up adversarial audit. Read this before proposing or implementing a new tranche. Update it whenever a major product direction, feature deferral, benchmark result, or adversarial audit changes the trajectory.

## Current Decision

The next development cycle should continue to prioritize trust infrastructure over feature expansion.

The **ReferenceCard v1 Trust Tranche** and the deterministic **ReferenceCard Evidence Acceptance** analyzer are implemented for template use. The repository includes starter revenue examples and mock acceptance artifacts, but a real deployment must choose and align one implementation-specific domain before recording acceptance.

The active next tranche is scoped implementation alignment: replace starter ReferenceCards and benchmark corpus with one real business domain, provide matching dbt artifacts, sync File Search, deploy, and run the acceptance analyzer with real evidence.

File Search sync is part of the trust gate. A sync is successful only when replacement sync removes existing managed documents for incoming display names, upload operations complete, newly uploaded documents verify as `STATE_ACTIVE`, replaced managed documents are cleaned up, and final readback converges to exactly one active document per expected display name with no failed or duplicate managed documents remaining. Cleanup is scoped to managed `teaching:` and `reference_card:` display names; replacement is not atomic because old managed documents are removed before new uploads are verified.

Do not add another reference-card domain, revive Phase 3 feature expansion, or promote a new runtime behavior until the first implementation-specific pilot run records an `ACCEPTED` decision or this document is updated with new evidence and rationale.

After the first implementation-specific pilot decision is recorded, the trajectory branches:

- If the pilot is `ACCEPTED`, the next product tranche may add exactly one additional high-confusion ReferenceCard domain.
- If the pilot is `NEEDS_REVISION`, the next tranche should be scoped repair of the failing evidence category: card content, prompt behavior, retrieval, table selection, SQL shape, or validation metadata.

## Strategic Rationale

Anna Lytics already has the core self-serve analytics shape: Slack-native intake, dbt metadata, validated SQL generation, supervisor review, escalation, teachings, and response transparency. The highest-leverage gap is not another answer format. It is making the system more governable, measurable, and semantically grounded.

Borrow from Anthropic's self-service analytics approach at the operating-model level:

- Curated, retrievable semantic references that encode how the business defines metrics and tables.
- Human-reviewed knowledge updates instead of broad automatic correction harvesting.
- Evaluation loops that prove whether references and teachings improve answer quality.
- Provenance that helps users and analysts understand why an answer can be trusted.
- Maintenance workflows that keep analytics knowledge fresh and safe to sync.

## Current Tranche

### Implementation ReferenceCard Acceptance Run

Convert one implementation-specific ReferenceCard domain and the deterministic analyzer into recorded evidence before expanding scope.

Scope:

- Replace starter ReferenceCards and benchmark corpus with one real implementation domain.
- Provide dbt artifacts that contain the tables referenced by those cards and corpus.
- Execute the real benchmark that emits ReferenceCard retrieval, table-selection, SQL-shape, validation-layer, and provenance fields.
- Run `scripts/benchmark-analyze.ts` against the saved benchmark JSON.
- Review the generated `*-referencecard-acceptance.md` report.
- Update this document with the dated acceptance decision, benchmark artifact path, evidence source, and next branch.

Acceptance criteria:

- A real benchmark JSON exists under `benchmarks/results/`.
- The analyzer writes both `*-summary.md` and `*-referencecard-acceptance.md`.
- The acceptance report returns either `ACCEPTED` or `NEEDS_REVISION`.
- This governance document records the decision and whether the next tranche is one-domain expansion or scoped repair.

Template decision on 2026-06-05:

- Decision: keep implementation-specific dbt artifacts, project IDs, File Search store IDs, ReferenceCards, corpus retargets, and benchmark evidence out of the template repository.
- Rationale: Anna Lytics is intended to be reused across analytics teams and warehouse schemas. The template should document the path for an implementation to provide its own knowledge and artifacts without embedding one client's business model or infrastructure identifiers.
- Starter content: `references/revenue.yml` and `benchmarks/corpus.json` remain sample content that implementations must replace or consciously keep.
- Mock evidence: `benchmarks/mock-results/` exercises the deterministic acceptance analyzer without external services or client identifiers.
- Next branch: an implementation repo or branch should align its own cards, corpus, dbt artifacts, File Search store, and deploy target before running a real acceptance benchmark.

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

- The `ReferenceCard v1 Trust Tranche` is implemented with starter sample content.
- The deterministic `ReferenceCard Evidence Acceptance` analyzer is implemented by `scripts/benchmarkAcceptance.ts`, `scripts/benchmark-analyze.ts`, and focused benchmark script tests.
- Mock acceptance artifacts live under `benchmarks/mock-results/` and exercise both `ACCEPTED` and `NEEDS_REVISION` analyzer branches without external services. They do not count as live implementation acceptance evidence.
- Real acceptance artifacts should be generated and committed only in an implementation repository or branch that intentionally carries implementation-specific schema, project, and File Search context.
- Failed escalation SQL is tracked as `failedSql`, not `finalSql`, when generating teaching candidates.
- Chart rendering uses `@resvg/resvg-js` to preserve distroless runtime compatibility.
- Chartability scans across result rows rather than trusting the first row.
- The quality loop emits validation-layer history for benchmark reporting.
- Teaching validation exists before File Search sync.
- Sync workflow uses Google GitHub Actions OIDC authentication before GCP-backed validation and Firestore sync.
- ReferenceCard support is implemented by `references/`, `src/references/`, knowledge sync scripts, and benchmark reference-card retrieval fields.
- Legacy teaching-only sync preserves `reference_card:*` documents by deleting only `teaching:*` documents; full knowledge sync remains responsible for replacing the shared store.
- Knowledge sync validates environment and initializes Firestore before mutating File Search, reducing partial-sync failure states.
- Benchmark table observations are derived from generated SQL rather than model-reported `tables_used`; ReferenceCard cases can include table-specific SQL-shape expectations.
- Pull request CI runs `scripts/validate-knowledge.ts` so malformed teaching or reference YAML is caught before merge, while missing dbt artifacts skip only artifact-aware checks.
- Evidence source for this update: `benchmarks/mock-results/`, `scripts/benchmarkAcceptance.ts`, and `scripts/benchmark-analyze.ts`.

As of 2026-06-05:

- Setup and deployment guidance was simplified as trust-infrastructure maintenance, not Phase 3 product expansion.
- Direct `gcloud` is the supported path for both runtime deploy (`gcloud run deploy`) and persistent setup (APIs, Firestore, Firestore indexes, Artifact Registry, service account/IAM, Secret Manager containers). See README "Infrastructure Setup" for the per-resource commands.
- The Terraform config in `infra/` is **not assumed to be applied**: it has no committed/remote state and CI never runs `terraform apply`. It is retained only as an optional declarative reference, and `infra/firestore.indexes.json` doubles as the canonical manifest of required Firestore composite indexes (apply via `gcloud firestore indexes composite create`).
- Runtime secret values are added outside any IaC. Cloud Run binds `slack-bot-token`, `slack-signing-secret`, and `gemini-api-key` at deploy time.
- `references/` and `scripts/sync-knowledge.ts` are the primary knowledge authoring/sync path. Legacy teaching-only sync remains for compatibility but is not the main onboarding path.
- `scripts/setup-check.ts` records offline setup guardrails for stale model IDs, required files, env var presence without secret values, dbt artifact presence, ReferenceCard/dbt alignment, workflow consistency, and Terraform boundary drift.
- File Search investigation showed successful sync requires more than a store ID: upload operations must complete and uploaded documents must read back as `STATE_ACTIVE`.
- File Search sync is hardened to retry transient upload failures, remove existing managed documents for incoming `teaching:` and `reference_card:` display names before replacement upload, poll upload operations, re-upload documents that reach failed indexing state, verify newly uploaded documents by exact document name when available, and require duplicate-free final readback convergence before reporting success.
- Template boundary: do not commit implementation-specific dbt artifacts, project IDs, File Search store IDs, ReferenceCards, corpus retargets, or benchmark evidence to this repository unless it has intentionally become an implementation repo.
- A real implementation-specific acceptance decision is still required before adding another ReferenceCard domain.

As of 2026-06-06:

- Negative-feedback escalation (👎 → reason prompt → analyst) shipped as trust infrastructure: it satisfies guardrail #1 (trust before surface area) and guardrail #3 (human-reviewed knowledge before automatic learning).
- Boundary it respects: it routes a human's correction to a human analyst and reuses the existing teaching-CANDIDATE flow only. It does NOT auto-promote feedback into production retrieval, and it does NOT lower the pipeline's escalation threshold.
- Both of those remain deferred under the "Automatic correction harvesting from binary feedback" line; reviving either still requires updating this document first.
- Evidence source for this update: `docs/superpowers/specs/2026-06-06-negative-feedback-escalation-design.md`.

As of 2026-06-07:

- Decision: the feedback loop between users, admins, and the agent is adopted as trust infrastructure that *serves* the implementation acceptance tranche, not as a competing feature tranche. An 80/20 analysis of the loop identifies three sanctioned investments:
  - (1) Privacy-safe aggregation of 👍/👎 binary feedback into per-domain pain signal.
  - (2) An informed, low-friction human review gate: close the write-only `feedback_notes` capture so the richest signal (free-text "why this was wrong") is readable, and attach impact/context to the `promote-teachings` review surface.
  - (3) Measurement of whether a promoted teaching reduces future escalations or lifts its benchmark slice.
  - (4) A proactive "side bar": when reconciled confidence is low on *semantic / org-knowledge* ambiguity — distinct from user-intent ambiguity and from mechanical supervisor exhaustion — the agent privately consults an admin *before* answering, and the admin's ruling is routed into the existing teaching-CANDIDATE flow (never auto-synced).
- Why this serves the trajectory: item (1) is the sensor that satisfies guardrail #5 ("benchmarks decide sequencing") for selecting the *one high-confusion domain* the ReferenceCard acceptance pilot requires. Aggregated feedback chooses that domain from data instead of intuition; item (3) supplies the `ACCEPTED`/`NEEDS_REVISION` impact evidence. Feedback-loop work and the implementation acceptance run are therefore one pipeline, not competing tranches.
- Reactive arm vs proactive arm: items (1)–(3) are the *reactive* arm (learn from feedback on answers already given); item (4), the side bar, is the *proactive* arm (resolve uncertainty before the answer ships). They share the same reconciled-confidence signal and the same teaching-candidate capture path, so the aggregation sensor (1) and the side bar (4) are most naturally designed as one "know where you're confused, then resolve it" system.
- Side bar — core new mechanic is routing-by-ambiguity-type: user-resolvable ambiguity continues to route to the *user* via the existing clarification agent; org-knowledge ambiguity routes to an *admin* via the side bar. Only the latter yields reusable institutional rulings worth capturing as teachings (a user clarification dies with the thread; an admin ruling is true for every future user).
- Side bar — builds on existing primitives, so the new code is narrow: reconciled confidence (`src/agents/confidence.ts`, `reconcileConfidence`) is already produced across the clarification, SQL-generation, and supervisor agents but is consumed for human contact only at exhaustion (`decideEscalation`); escalation plumbing (`escalation_state`, `checkEscalationResponse`) is reusable; and `best_effort_verify` (answer-then-verify-async) is the mirror image of the side bar (ask-before-answer). The genuinely new pieces are an ambiguity-type classifier, a calibrated trigger threshold, the private agent↔admin conference UX, and ruling→teaching-candidate capture.
- Side bar — recorded prerequisite: its value depends on well-calibrated reconciled confidence. Validate calibration before shipping the trigger. A noisy confidence signal fires the side bar at the wrong moments and causes analyst fatigue — the dominant failure mode of any synchronous, mid-query human-consultation channel.
- What stays deferred, with a sharpened rationale: "Automatic correction harvesting from binary feedback" remains deferred. Beyond guardrail #3, the new rationale is ROI-based — items (1)–(3) make the human approval gate cheap and measurable, which *reduces* the marginal value of removing the human entirely. Auto-promotion would trade away the system's core trust property (every production teaching was human-vetted) to save approval clicks that items (1)–(3) already make near-free. Reviving auto-promotion still requires updating this document first.
- Loop audit that motivated this entry: `feedback_notes` is currently write-only (`src/state/feedbackNotes.ts` exports only `saveFeedbackNote`; no reader; `candidateGenerator.ts` does not consult it). The escalation → analyst → `teaching_candidates` → `scripts/promote-teachings.ts` (interactive a/r/s) → `teachings/*.yml` → CI sync path is the closed, human-gated correction loop.
- Privacy boundary: aggregation stores counts/rates by domain, never a broad corpus of raw user queries — upholds the deferred "wide production-corpus ingestion without privacy-safe feedback events" line.
- Template boundary: aggregation and measurement scaffolding is template-safe. No client domains, raw queries, project IDs, store IDs, or identifiers are committed here.
- Sequencing: this governance entry is the anchor; a focused design doc for item (1) (the feedback sensor) is the intended next artifact. Item (2)'s `feedback_notes` reader fix is independent maintenance — it landed the same day (recorded below).
- Evidence source for this update: this session's 80/20 analysis of the user↔admin↔agent feedback loop and the loop audit cited above.
- Item (2) landed (maintenance slice): closing the write-only capture gap the loop audit above identified — 👎 → "Other" free-text notes were persisted to `feedback_notes` but had no read path, so the richest correction signal was silently discarded. Added `getPendingFeedbackNotes()` / `markFeedbackNoteReviewed()` and surfaced pending notes in the `scripts/promote-teachings.ts` admin review so a human curating knowledge also sees what users flagged as wrong.
- The `getPendingFeedbackNotes()` query needs a `feedback_notes` composite index (`status ASC + createdAt DESC`), declared in `infra/firestore.indexes.json`. Since Terraform is not applied in this environment (see README "Infrastructure Setup"), this index must be created manually with `gcloud firestore indexes composite create` before the read path works in production — the query is `FAILED_PRECONDITION` without it.
- Boundary it respects: this only informs the existing human review gate (guardrail #3). It does NOT auto-promote notes into teachings or retrieval; turning a note into a teaching stays a deliberate, separate act. The "Automatic correction harvesting from binary feedback" line remains deferred.

## Relationship to Existing Docs

- `.spec-workflow/steering/product.md` remains the product overview.
- `CLAUDE.md` remains the agent-facing implementation guide.
- `docs/superpowers/specs/2026-03-24-phase3-features-design.md` and `docs/superpowers/plans/2026-03-24-phase3-features.md` are historical Phase 3 feature docs. They are not the active next-tranche authority while this governance checkpoint is in force.
