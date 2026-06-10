# Anna Lytics Trajectory Governance

**Created:** 2026-06-04
**Last restructured:** 2026-06-09 (full repository audit; dated history moved to the Evidence Log)
**Status:** Governing roadmap checkpoint
**Applies to:** Product design, implementation plans, code review, benchmark work, teaching updates, and future Phase 3+ feature proposals.

This document records the current development trajectory for Anna Lytics. Read **Current State**, **Current Decision**, the **Tranche Horizon**, and the **Active Tranche** before proposing or implementing a new tranche. The **Deferred Work** table states the blocking condition for every deferred item; the **Tranche Horizon** states the order in which eligible items activate. The **Evidence Log** at the end preserves the dated decision history verbatim; do not read it for current direction.

Update this document whenever a major product direction, feature deferral, benchmark result, or adversarial audit changes the trajectory — and when you do, update the head sections (Current State, Current Decision, Deferred Work) rather than only appending a dated entry. Dated entries go in the Evidence Log.

## Current State (as of 2026-06-09)

The codebase is healthy: ~9.0K source lines, 854 tests passing, typecheck clean, module boundaries respected, no dead exports. The dominant risk is no longer code quality — it is that the project keeps building measurement instruments instead of taking the measurement its own gate requires.

| Area | Status |
|---|---|
| Core pipeline (intake → clarification → SQL → supervisor → L1–L4 validation → execution → respond) | Live, template-complete |
| ReferenceCard v1 + acceptance analyzer | Implemented; starter content + mock artifacts only. **No real acceptance run has ever been recorded** (benchmark results are operator-local and gitignored; no acceptance artifact exists anywhere). |
| Benchmark hardening (validation trace, teaching retrieval, provenance) | Satisfied 2026-06-08 (Evidence Log) |
| Teaching validation gates | Implemented; runs in PR CI |
| Feedback loop (2026-06-07 plan) | Items (1) aggregation and (2) feedback-notes reader: done. Item (3) teaching impact measurement: **absent** (deferred — see Deferred Work). Item (4) side bar: only the prerequisite ambiguity classifier exists. |
| Confidence calibration | Benchmark-side reducer + report committed; verdict gate defined; no real data yet |
| Node sizing | 2 of 12 nodes measured (`slackIntake`, `followUpClassifier`); `ambiguityClassifier` provisional; remaining 9 heuristic or unsizable until the corpus grows |
| Routine query fast path | Committed, default-off (`FAST_PATH_ENABLED=false`); inert without File Search store + knowledge summaries, so inert in the template |
| Latency evidence slice | Not yet run (requires implementation corpus) |
| Operational trust (Firestore retention, telemetry sink, escalation timers, ✅-reaction promise) | **Completed 2026-06-09** — all four Tranche B items shipped; acceptance criteria satisfied (Evidence Log) |

## Current Decision

1. **The active product tranche remains the implementation-specific ReferenceCard acceptance run** (Active Tranche A). Nothing since 2026-06-04 has changed this; everything shipped since then has been instrumentation for it.
2. **Evaluation-scaffolding freeze.** No new benchmark, calibration, sizing, sweep, or acceptance machinery may be built until the first real acceptance decision is recorded. The 2026-06-09 audit found that every tranche since 2026-06-04 — benchmark hardening, calibration verdicts, the ambiguity classifier, two-stage sizing sweeps, the latency fast path — improved the instruments while no acceptance evidence was ever produced (the only real instrument output to date is an operator-local node-sweep latency/sizing result, gitignored per the template boundary). Each was individually justified; collectively they deferred the one thing that unblocks everything else. The binding constraint is implementation alignment, not tooling. Improving existing instruments to fix a defect found during the acceptance run is fine; net-new measurement capability is not.
3. **Operational trust maintenance (Tranche B) is complete** (2026-06-09 Evidence Log). It was maintenance under guardrail #1, not feature expansion, and did not gate on the acceptance run. A system that silently accumulates state forever, collects telemetry nobody can read, or freezes on user-facing promises erodes trust as surely as a wrong answer does. With Tranche B closed, **Tranche A — the acceptance run — is the sole active tranche.**
4. **The item-(3) contradiction is resolved.** Teaching impact measurement was listed as a "sanctioned investment" (2026-06-07 entry) and simultaneously as deferred (2026-06-08 entry) with no explanation. Resolution: it is **deferred**, with an explicit blocking condition — it cannot be built meaningfully before a real implementation has promoted teachings and benchmark slices to measure them against, i.e. it is blocked on the acceptance run. The 2026-06-07 "sanctioned" framing is withdrawn.

## Tranche Horizon

The Deferred Work table states *eligibility* (what unblocks when). This section states *order* — which eligible item is next, so that when several unblock at once the trajectory does not drift to whichever is easiest. It is a queue, not a backlog: each entry is gated by the one before it, and detailed task breakdowns belong in plan docs, not here.

**T1 (active now).** Tranche A (acceptance run); Tranche B (operational trust) completed 2026-06-09 (Evidence Log). UX-trust items and Code Debt Register items land opportunistically, with one hard sequencing rule: **feedback-loop closure to the user must ship before the second ReferenceCard domain is selected** (shipped 2026-06-10 — precondition satisfied; Evidence Log), because domain selection from then on is supposed to come from the feedback sensor, and the sensor only keeps receiving data if users see their feedback matter. Note the bootstrap asymmetry this implies: the *first* pilot domain is chosen by analyst judgment (there is no production feedback before a deployment exists); only subsequent domains are chosen from aggregated pain signal.

**T2 (on the acceptance outcome).** The existing branch: `ACCEPTED` → exactly one additional high-confusion domain; `NEEDS_REVISION` → scoped repair of the failing evidence category, then re-run. Standing cadence rule, now explicit: **every new ReferenceCard domain and every runtime-behavior promotion requires its own benchmark slice** before it ships (guardrail #5 applied as a recurring gate, not a one-time hurdle).

**T3 (post-acceptance priority order).** Completing the acceptance run unblocks most of the Deferred Work table simultaneously. When that happens, the order is:

1. **Side bar calibration check.** Run the calibration verdict against the real benchmark/judge data the acceptance run produced. If it passes, the side bar pilot (admin suspend/consult/resume behind a config flag) becomes the next product tranche; if it fails, the side bar stays deferred and the failure is recorded here.
2. **Teaching impact measurement**, once at least one implementation teaching has been promoted — it needs a before/after to measure.
3. **Node sizing completion**, as the implementation corpus grows enough to bound ε for the reasoning nodes.
4. **Scaffolding unfreeze, last.** The freeze (Current Decision #2) lifts only after evidence is flowing routinely — at minimum the acceptance decision plus one post-acceptance benchmark slice — not at the first recorded artifact.

**Fast-path graduation gate.** The routine fast path ships in pilot mode (`FAST_PATH_REQUIRE_SUPERVISOR=true`: eligible queries still run supervisor). Flipping to real supervisor-skips is a runtime-behavior promotion and carries its own evidence gate: a recorded pilot window in which supervisor review of fast-path-eligible queries produced **zero blocking corrections**, observed via the production telemetry sink that Tranche B delivered, with the window length and query counts recorded in this document. Tranche B's sink shipped 2026-06-09 (every `generateForNode` call emits a structured `model.usage` log line by default), so the gate's telemetry precondition now exists; the gate itself remains unevaluated until a pilot window is recorded.

Anna Lytics already has the core self-serve analytics shape: Slack-native intake, dbt metadata, validated SQL generation, supervisor review, escalation, teachings, and response transparency. The highest-leverage gap is not another answer format. It is making the system more governable, measurable, and semantically grounded.

Borrow from Anthropic's self-service analytics approach at the operating-model level:

- Curated, retrievable semantic references that encode how the business defines metrics and tables.
- Human-reviewed knowledge updates instead of broad automatic correction harvesting.
- Evaluation loops that prove whether references and teachings improve answer quality.
- Provenance that helps users and analysts understand why an answer can be trusted.
- Maintenance workflows that keep analytics knowledge fresh and safe to sync.

To that list the 2026-06-09 audit adds an operating principle: **instruments are not measurements.** An evidence-gated roadmap whose gate requires external work (a real client domain, real dbt artifacts) will drift toward endlessly improving the gate itself, because that work is template-safe and always passes review. This document now caps instrument-building, not just feature-building.

## Active Tranche A — Implementation ReferenceCard Acceptance Run

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

After the first implementation-specific pilot decision is recorded, the trajectory branches:

- If the pilot is `ACCEPTED`, the next product tranche may add exactly one additional high-confusion ReferenceCard domain.
- If the pilot is `NEEDS_REVISION`, the next tranche should be scoped repair of the failing evidence category: card content, prompt behavior, retrieval, table selection, SQL shape, or validation metadata.

Template decision on 2026-06-05 (still in force):

- Keep implementation-specific dbt artifacts, project IDs, File Search store IDs, ReferenceCards, corpus retargets, and benchmark evidence out of the template repository.
- Rationale: Anna Lytics is intended to be reused across analytics teams and warehouse schemas. The template should document the path for an implementation to provide its own knowledge and artifacts without embedding one client's business model or infrastructure identifiers.
- Starter content: `references/revenue.yml` and `benchmarks/corpus.json` remain sample content that implementations must replace or consciously keep.
- Mock evidence: `benchmarks/mock-results/` exercises the deterministic acceptance analyzer without external services or client identifiers. Mock artifacts never count as live acceptance evidence.
- Next branch: an implementation repo or branch should align its own cards, corpus, dbt artifacts, File Search store, and deploy target before running a real acceptance benchmark.

File Search sync remains part of the trust gate. A sync is successful only when replacement sync removes existing managed documents for incoming display names, upload operations complete, newly uploaded documents verify as `STATE_ACTIVE`, replaced managed documents are cleaned up, and final readback converges to exactly one active document per expected display name with no failed or duplicate managed documents remaining. Cleanup is scoped to managed `teaching:` and `reference_card:` display names; replacement is not atomic because old managed documents are removed before new uploads are verified.

## Tranche B — Operational Trust (completed 2026-06-09)

Source: 2026-06-09 repository audit (Evidence Log). These were production-rot risks the epistemic-trust focus had been blind to. Each was template-safe. **All four items shipped 2026-06-09** (commits `8cc4a14` through `b989e84` inclusive; see the Evidence Log entry of that date for scope).

1. **Firestore retention is enforced for only one collection.** The README documents a TTL policy solely for `slack_event_dedupe`; the other collections that set `expiresAt` (`clarification_state`, `escalation_state`, `information_schema_cache`, `dbt_run_history`) are check-on-read only, so expired documents accumulate forever. Worse, `response_context` — the largest documents, one per query — has **no** expiry at all, and `getResponseContextsSince()` (`src/state/responseContext.ts`) performs an unbounded full-window scan. Required: declare TTL policies for every expiring collection (a manifest in `infra/` mirroring how `firestore.indexes.json` works for indexes), set a retention window for `response_context`, and extend the README's existing `gcloud firestore fields ttls update` step to cover them. **Closed:** `infra/firestore.ttls.json` manifest (7 collections, parity-tested), `response_context.expiresAt` honoring `RESPONSE_CONTEXT_RETENTION_DAYS` (default 90d), `escalation_state.retainUntil` (90d), bounded window scan, README "Firestore TTL Policy" apply path, backfill script.
2. **Per-node telemetry has no production sink.** `src/agents/modelGateway.ts` records per-node token and latency usage, but only `scripts/node-sweep.ts` ever sets a sink — a live deployment discards it. An operator is blind to token spend, supervisor-exhaustion rates, and latency trends, which undermines both the latency tranche and guardrail #5. Required: a default production sink that emits usage records as structured logs (Cloud Run → Cloud Logging needs no new infrastructure). **Closed:** `setDefaultUsageSink()` fallback in the gateway; app.ts wires it to the root logger so every `generateForNode` call emits a structured `model.usage` log line by default.
3. **Escalation reminders and timeouts only fire on incoming event traffic.** `checkOverdueEscalations()` piggybacks on message events with a 60s throttle; in a quiet workspace a `park_wait` user waits on "I've asked the data team" indefinitely past the 4h timeout. Required: a time-driven trigger (Cloud Scheduler hitting an authenticated endpoint, or equivalent) so lifecycle checks do not depend on user activity. **Closed:** `POST /api/lifecycle-sweep` (Bearer `LIFECYCLE_SWEEP_SECRET`) drives the sweep on wall-clock time; README documents the 10-minute Cloud Scheduler job.
4. **The escalation card promises a feature that does not exist.** `src/slack/escalationBlocks.ts:60` tells analysts "React with ✅ if my guess is correct" but no `reaction_added` handler is registered anywhere. Required: either ship the reaction handler (it is the analyst quick-path the card was designed around) or remove the copy. Shipping a promise and not the feature is a trust defect by this document's own standard. **Closed:** honored — `src/handlers/escalationReaction.ts` resolves ✅ reactions (park_wait re-runs the pipeline with the confirmation as guidance; best_effort_verify posts the confirmation and resolves); cards without a best guess no longer show the ✅ copy.

Acceptance criteria: TTL manifest exists and the apply path is documented; usage records visible in logs from a deployed instance; an escalation in a zero-traffic workspace times out and notifies the user; the ✅ promise is either honored or gone. **All four satisfied 2026-06-09** — the in-repo halves are verified by tests; the operator halves (the Cloud Scheduler job, the live TTL policies) are documented README steps.

## Sanctioned UX-Trust Items (shipped 2026-06-10)

These are prerequisites for the 2026-06-07 feedback-sensor strategy, not feature expansion. That strategy bets on users continuing to supply feedback; users stop feeding a sensor that never responds. **All three items shipped 2026-06-10** (commits `aa173d1` through `2e27734`; see the Evidence Log entry of that date for scope).

1. **Close the feedback loop to the user.** Today 👎 → reason → teaching candidate → human approval → sync happens entirely silently from the reporting user's perspective. When a teaching candidate that originated from a user's feedback is promoted, notify that user in the originating thread. This is the cheapest retention mechanism the feedback sensor has. **Closed:** approval in `scripts/promote-teachings.ts` enqueues a `pending_notifications` doc (best-effort, never blocks promotion); the lifecycle sweep delivers it to the originating thread, mentioning the reporting user when known.
2. **A help/onboarding surface.** There is no `/anna help`, no App Home content, no first-contact greeting that explains what the bot can answer, example questions, or what clarification/escalation waits mean. Users currently learn by trial and error. **Closed:** `/anna help` and bare `/anna` respond ephemerally (membership-free via `respond()`); the App Home tab publishes the same template-generic content. The first-contact greeting was explicitly excluded from v1 — it needs per-user "already greeted" state; revisit only on evidence users find neither surface.
3. **A bailout for stuck threads.** A pending clarification blocks its thread with no user-visible reminder, expiry notice, or way to abandon. Surface the pending state and let the user cancel or restart. **Closed:** a cancel button on both surfaces where the pending state is visible (the clarifying question and the preflight block message, which now also shows the original question), backed by an idempotent delete-and-update handler.

These landed alongside the active tranche without touching measurement machinery — the scaffolding-freeze exemption was honored. Item 1 satisfies the Tranche Horizon's hard precondition on second-ReferenceCard-domain selection; the selection gate itself still requires the recorded acceptance decision.

## Code Debt Register

Verified 2026-06-09. Maintenance items — address opportunistically when touching the affected area, or as a small dedicated slice. None block the active tranche.

| Item | Location | Note |
|---|---|---|
| Duplicated L1→L4 validation orchestration | `src/routineFastPath.ts` vs `src/qualityLoop.ts` | ~100 lines of parallel layer-sequencing/record-keeping; the two paths can silently diverge on a validation change. Extract a shared helper. Highest-priority debt item. |
| `pipeline.ts` responsibility sprawl | `src/pipeline.ts` (720 lines, ~13 concerns) | Every feature lands here, so it compounds. Decompose opportunistically (escalation orchestration, formatting, persistence). |
| BQML plumbing for a deferred feature | `src/agents/sqlGenerator.ts` (bqml_hint branches), `src/routineFastPath.ts` | BQML expansion is deferred, but forecast/anomaly/generate prompt branches and fast-path triggers ship today. Decide keep-or-remove at the next tranche boundary (see Deferred Work). |
| Untyped Slack payloads | `src/app.ts` (32 `as any` casts) | Define typed Slack action/interactivity payload interfaces to centralize the assertions. |
| Silent `/anna <question>` failure outside membership | `src/handlers/commands.ts` (question path) | `chat.postMessage` throws `channel_not_found` in conversations the bot is not a member of, and the user sees nothing (the slash payload itself always arrives). Surface the error via `respond()` the way `/anna help` does. Found 2026-06-10 during the help-surface review. |

## Completed Foundations

Detailed scope and acceptance criteria for these live in the Evidence Log entries cited; they are foundations now, not active work.

- **ReferenceCard v1 Foundation** — typed card layer (`references/`, `src/references/`), schema validation in CI, retrieval/citation fields in benchmark records, runtime knowledge summaries via `src/teachings/summaryMap.ts`. (2026-06-04 entry.)
- **Benchmark Hardening** — per-attempt validation traces, teaching-retrieval measurement, defensible run provenance. All three acceptance criteria satisfied. (2026-06-08 entry.)
- **Teaching Validation Gates** — duplicate-ID/pattern/date/dbt-reference/dry-run checks before File Search sync; PR CI runs `scripts/validate-knowledge.ts`; missing dbt artifacts skip only artifact-aware checks. (2026-06-04/05 entries.)
- **Feedback reactive arm, items (1) and (2)** — privacy-safe per-domain aggregation (`src/feedback/`) and the `feedback_notes` read path surfaced in `scripts/promote-teachings.ts`. (2026-06-07 entry. Note the `feedback_notes` composite index must be created manually — see that entry.)
- **Calibration + ambiguity-classifier prerequisites for the side bar** — benchmark-side calibration verdict and the `ambiguityClassifier` node (PROVISIONAL profile, label-only, observability-only). (2026-06-08 entry.)
- **Operational Trust (Tranche B)** — escalation ✅-reaction handler, scheduler-driven lifecycle sweep endpoint, default `model.usage` telemetry sink, Firestore TTL manifest + `response_context`/`escalation_state` retention. All four acceptance criteria satisfied. (2026-06-09 operational trust entry.)

## Deferred Work

Every deferred item now carries its blocking condition. Reviving any item requires updating this document first (guardrail #6).

| Deferred item | Why deferred | Unblocks when |
|---|---|---|
| Admin side bar (suspend/consult/resume, ruling→teaching capture) | Trigger quality depends on calibrated confidence; analyst-fatigue risk | Calibration verdict passes on real implementation data (which itself requires the acceptance run) |
| Teaching impact measurement | Nothing real to measure: no promoted implementation teachings, no real benchmark slices. Previously listed as both sanctioned and deferred; resolved 2026-06-09 as deferred | First real acceptance run + at least one promoted implementation teaching |
| Scheduled admin digests | Depends on feedback aggregation having real data; low value before then | Feedback sensor running against a real deployment |
| New evaluation/benchmark/sizing scaffolding | Scaffolding freeze (Current Decision #2) | First real acceptance decision recorded |
| Node sizing completion (9 remaining nodes) | Corpus too small; ε too large for reasoning nodes | `benchmarks/corpus.json` (or implementation corpus) grows enough to bound ε |
| Broad chart-generation expansion | Trust before surface area | Post-acceptance evidence that the foundation works |
| BQML prediction expansion | Same; note the plumbing already in code (Code Debt Register) — decide keep-or-remove when this row is next reviewed | Explicit governance update with rationale |
| Domain agents / general documentation routers | Trust before surface area | Explicit governance update with rationale |
| Automatic correction harvesting from binary feedback | Guardrail #3; ROI rationale in the 2026-06-07 entry — items (1)–(3) make the human gate cheap, reducing the value of removing it | Explicit governance update with rationale |
| Verbose provenance footers on every Slack answer | Compact provenance by default (guardrail #4) | Evidence that compact provenance is insufficient |
| Wide production-corpus ingestion | No privacy-safe feedback events yet | Privacy-safe event design accepted |

## Product Guardrails

Use these guardrails when reviewing future plans:

1. Trust before surface area. Prefer changes that improve correctness, maintainability, provenance, or evaluation over new output modes. Operational trust (retention, observability, honored UI promises) counts as trust.
2. One domain before many. Prove the content primitive in a narrow domain before generalizing.
3. Human-reviewed knowledge before automatic learning. Do not promote corrections into production retrieval without structured, privacy-safe review.
4. Compact provenance by default. Surface trust context when it changes interpretation; keep detailed reasoning behind the existing reasoning path.
5. Benchmarks decide sequencing. Do not promote a new content primitive or feature without benchmark evidence or a clear manual acceptance criterion.
6. Update governance before reviving deferred work. If a deferred item becomes active again, explain why in this document first.
7. Instruments are not measurements. Do not approve another tranche of evaluation machinery while the measurement it serves remains untaken. When in doubt between improving an instrument and running it, run it.

## Maintenance Protocol

Update this document when any of the following happens:

- An adversarial audit changes the recommended tranche.
- A benchmark run changes the priority order.
- A deferred feature becomes active.
- A trust, privacy, or teaching-sync risk is discovered.
- A new reference-card schema or teaching schema is accepted.
- The product no longer uses Slack-native self-serve analytics as its primary interface.

Every update must:

- Revise the head sections (Current State, Current Decision, Deferred Work) so they remain a self-contained statement of present direction.
- Append a dated entry to the Evidence Log with the date, the decision, what changed, what remains deferred, and the evidence source (benchmark output, code review, production incident, or analyst review).

Do not let direction live only in dated entries — that is how this document decayed into a changelog between 2026-06-04 and 2026-06-09.

## Relationship to Existing Docs

- `.spec-workflow/steering/product.md` remains the product overview.
- `CLAUDE.md` remains the agent-facing implementation guide.
- `docs/superpowers/specs/2026-06-07-feedback-loop-system-design.md` designs the full side bar; treat it as **pre-implementation** — only the prerequisite classifier exists in code.
- `docs/superpowers/plans/2026-06-09-latency-evidence-and-routine-fast-path.md` references an operator-local corpus outside this repository; it is an implementation guide, not a template task.
- `docs/superpowers/specs/2026-03-24-phase3-features-design.md` and `docs/superpowers/plans/2026-03-24-phase3-features.md` are historical Phase 3 feature docs. They are not the active next-tranche authority while this governance checkpoint is in force.
- `IMPLEMENTATION.md` (repo root) is the template→implementation conversion checklist: boundary declaration, GCP infrastructure, Slack app, dbt artifacts, knowledge layer, `NODE_PROFILE_OVERRIDES`, deploy/verify, and the acceptance run. It sequences and points; the README remains the authority for commands.

---

## Evidence Log

Dated decision history, preserved verbatim. Read the head sections above for current direction.

### As of 2026-06-04

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
- ReferenceCard v1 suggested card fields: `id`, `title`, `domain`, `grain`, `canonical_table`, `canonical_metric`, `required_filters`, `exclusions`, `avoid_tables`, `aliases`, `routing_triggers`, `owner`, `freshness_sla`, `related_teachings`, `updated`. First pass: one high-confusion domain, 5–10 cards maximum, concise and retrieval-friendly, cited/measured/maintained as product primitives.
- Evidence source for this update: `benchmarks/mock-results/`, `scripts/benchmarkAcceptance.ts`, and `scripts/benchmark-analyze.ts`.

### As of 2026-06-05

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

### As of 2026-06-06

- Negative-feedback escalation (👎 → reason prompt → analyst) shipped as trust infrastructure: it satisfies guardrail #1 (trust before surface area) and guardrail #3 (human-reviewed knowledge before automatic learning).
- Boundary it respects: it routes a human's correction to a human analyst and reuses the existing teaching-CANDIDATE flow only. It does NOT auto-promote feedback into production retrieval, and it does NOT lower the pipeline's escalation threshold.
- Both of those remain deferred under the "Automatic correction harvesting from binary feedback" line; reviving either still requires updating this document first.
- Evidence source for this update: `docs/superpowers/specs/2026-06-06-negative-feedback-escalation-design.md`.

### As of 2026-06-07

- Decision: the feedback loop between users, admins, and the agent is adopted as trust infrastructure that *serves* the implementation acceptance tranche, not as a competing feature tranche. An 80/20 analysis of the loop identifies three sanctioned investments:
  - (1) Privacy-safe aggregation of 👍/👎 binary feedback into per-domain pain signal.
  - (2) An informed, low-friction human review gate: close the write-only `feedback_notes` capture so the richest signal (free-text "why this was wrong") is readable, and attach impact/context to the `promote-teachings` review surface.
  - (3) Measurement of whether a promoted teaching reduces future escalations or lifts its benchmark slice. *(2026-06-09 note: the "sanctioned" status of this item was withdrawn and it is now explicitly deferred — see Current Decision #4 and Deferred Work.)*
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

### As of 2026-06-08 (benchmark hardening)

- The "Benchmark Hardening" subsection's three acceptance criteria are now satisfied. A benchmark record carries decision-support signal, not just a pass/fail, on all three axes:
  - (1) *Which validation layer failed, when, and why.* `BenchmarkResult.validationHistory` now preserves the full per-attempt `ValidationLayerRecord[]` that `qualityLoop` already produced (previously collapsed to four final-attempt booleans and discarded). The acceptance report appends a compact per-attempt trace to a failing case's detail (e.g. `a0 L1✗ (DML blocked); a1 L3✗ (Table not found)`) via the pure `formatValidationTrace`. Advisory L2 failures render in the trace marked `advisory` — visible, never escalated to a blocking failure — satisfying "Advisory L2 failures remain visible without changing runtime behavior." No runtime/pipeline change: only the benchmark record and report widened.
  - (2) *Teaching retrieval is measured.* The `teaching:<id>` citation prefix that `grounding.ts` already stamped was being thrown away (`teachingCompliance` was hardcoded `'no_relevant_teaching'`, `observedTeachingIds` did not exist). Teaching capture now mirrors the live reference-ID path exactly: `extractTeachingIdsFromCitations` + `teachingRetrievalPassed` (null when nothing expected, else every-expected-observed) + a derived `teachingCompliance` (`followed`/`missed`/`no_relevant_teaching`), surfaced as a `Teaching` scorecard column and a `teaching_miss` failure class. This supplies the ReferenceCard-pilot evidence — whether retrieved knowledge improves answers — that guardrail #5 ("benchmarks decide sequencing") requires.
  - (3) *Provenance is defensibly comparable.* The acceptance report's Run Provenance table now renders Judge Model and GCP Project (both already captured in `BenchmarkMetadata` but previously unrendered), alongside the existing Git SHA / corpus hash / dbt hashes / Gemini model / File Search store ID. Two runs differing in judge or project are no longer silently conflated.
- Template boundary held: every change surfaces signal the pipeline already produces (no new live measurement); new `BenchmarkResult` fields are read defensively so older committed fixtures still render; only `benchmarks/mock-results/*` is committed (never `benchmarks/results/*`); no client teachings, ReferenceCards, dbt artifacts, project IDs, or store IDs were added — the teaching slice is proven structurally with mocked citations and an invented-id fixture.
- Evidence source for this update: `docs/superpowers/plans/2026-06-08-benchmark-hardening-design.md` (design) and `docs/superpowers/plans/2026-06-08-benchmark-hardening-implementation.md` (the executed plan). Per the Maintenance Protocol, this governance note lands in the same change set as the work.

### As of 2026-06-08 (calibration + ambiguity observability)

- Step 3 of the sanctioned feedback-loop sequence landed as template-safe trust infrastructure: a benchmark-side calibration reducer/report and a label-only ambiguity classifier at the existing LOW clarification halt.
- Calibration verdict approach: benchmark calibration now joins `BenchmarkResult.confidence` to judge outcomes by `corpusId`, counts a case wrong when `flaggedForReview === true` or `scores.correctness < 3`, and emits low→medium→high buckets with `{ total, wrong, wrongRate }`. The v1 side-bar gate is deliberately conservative: all three confidence buckets must meet `minSample = 5`, wrong rates must be monotonic in the trustworthy direction (`low >= medium >= high`), and low must exceed high by at least `0.05`. Missing judge results or below-sample buckets fail the calibration verdict rather than over-claiming from a tiny slice.
- The ReferenceCard acceptance report now renders a Calibration section/table and verdict alongside run provenance. This does not change the ReferenceCard `ACCEPTED`/`NEEDS_REVISION` decision; it is a separate side-bar prerequisite.
- The ambiguity classifier is registered as `ambiguityClassifier` in the node registry and generates through `generateForNode`. Its default profile is PROVISIONAL and un-sized (`flash-lite/3.1`, `minimal`) because it is a closed-set classification task but has not yet gone through a node-sizing sweep. The classifier distinguishes `user_intent` from `org_knowledge`, fails safe to `user_intent`, and stores the label/domain/question on pending `clarification_state` for observability while keeping the current user-clarification routing unchanged.
- What stays deferred: the side bar itself (admin suspend/consult/resume on `escalation_state`, behind a config flag), ruling-to-teaching candidate capture from admin consultation, scheduled admin digests, impact measurement of promoted teachings, and automatic correction harvesting from binary feedback. Reviving any of those still requires a governance update and the side-bar trigger remains gated on calibration evidence.
- Template boundary held: no client-specific dbt artifacts, project IDs, File Search store IDs, ReferenceCards, corpus retargets, or real benchmark outputs were added. The calibration slice is proved with pure fixtures and existing mock/template-safe benchmark data only.
- Evidence source for this update: `scripts/benchmark-calibration.ts`, `scripts/benchmarkAcceptance.ts`, `src/agents/ambiguityClassifier.ts`, `src/pipeline.ts`, and focused tests in `tests/scripts/benchmarkCalibration.test.ts`, `tests/scripts/benchmarkAcceptance.test.ts`, `tests/agents/ambiguityClassifier.test.ts`, `tests/agents/nodeProfiles.test.ts`, and `tests/pipeline.test.ts`.

### As of 2026-06-09 (full repository audit and governance restructure)

- Decision: this document was restructured from a chronological changelog into a decision tool (self-contained head sections; dated history preserved here). Two new decisions recorded: an **evaluation-scaffolding freeze** (Current Decision #2, guardrail #7) and a sanctioned **Operational Trust maintenance tranche** (Active Tranche B). The item-(3) teaching-impact-measurement contradiction was resolved as deferred with an explicit blocking condition (Current Decision #4).
- What motivated it: a four-dimension repository audit (code complexity/debt, documentation coherence, test/ops/eval infrastructure, UX surface), with load-bearing findings re-verified against primary sources before being recorded here.
- Key verified findings:
  - *Instruments without measurement:* no real ReferenceCard acceptance artifact has ever been recorded, while ~3.7K lines of benchmark/sweep/calibration scripts accumulated across the 2026-06-04→06-09 tranches (the only real instrument output is an operator-local, gitignored node-sweep result referenced from `.env.example`). The acceptance run the gate requires remains untaken.
  - *Operational rot risks:* a Firestore TTL policy is documented for only `slack_event_dedupe`; the other `expiresAt` collections are check-on-read only; `response_context` has no expiry and an unbounded window scan (`src/state/responseContext.ts`); per-node usage telemetry (`src/agents/modelGateway.ts`) has no production sink (only `scripts/node-sweep.ts` consumes it); escalation reminders/timeouts fire only on incoming event traffic (`src/handlers/escalationLifecycle.ts`), so quiet workspaces never time out; the escalation card promises a ✅-reaction quick-path (`src/slack/escalationBlocks.ts:60`) with no `reaction_added` handler registered.
  - *UX-trust gaps:* no help/onboarding surface (no `/anna help`, no App Home, no first-contact greeting); the feedback loop never closes back to the reporting user; pending clarifications block threads with no bailout.
  - *Code debt:* duplicated L1→L4 orchestration between `src/routineFastPath.ts` and `src/qualityLoop.ts`; `src/pipeline.ts` at 720 lines/~13 concerns; BQML prompt plumbing shipped while BQML is deferred; 32 `as any` Slack payload casts in `src/app.ts`.
  - *Docs system:* 13.4K markdown lines vs 8.8K source lines; this document had accreted 76 lines of dated entries against ~25 lines of decision, with deferred items lacking blocking conditions.
  - *Findings checked and rejected during verification:* `src/references/` **is** runtime-wired (via `src/teachings/summaryMap.ts`, imported by `app.ts` and `pipeline.ts`); `FAST_PATH_ENABLED` **is** documented in `.env.example`. Neither was recorded as debt.
- Healthy-state confirmation: 813 tests pass, typecheck is clean, no dead exports were found, module boundary rules hold, and prior governance boundaries (template vs implementation, human-gated teaching promotion) were respected in code.
- What remains deferred: everything in the Deferred Work table, now with explicit blocking conditions per item.
- Template boundary held: this update adds no client artifacts, identifiers, or evidence; it records audit findings and governance structure only.
- Evidence source for this update: 2026-06-09 four-dimension repository audit in this change set's session (agent-assisted exploration with primary-source re-verification of every claim recorded above).

### As of 2026-06-09 (tranche horizon)

- Decision: added the **Tranche Horizon** section — an ordered queue over the Deferred Work table's eligibility conditions. Motivation: a review of the restructured document found it sufficient as a *gate* (it can veto misaligned work) but under-specified as a *queue*: completing the acceptance run unblocks most deferred items simultaneously, and the document gave no ordering rule for that moment — the same ambiguity that previously produced the instruments-over-measurement drift.
- New commitments recorded:
  - Feedback-loop closure to the user must ship before the second ReferenceCard domain is selected (the feedback sensor only keeps receiving data if users see their feedback matter).
  - Bootstrap asymmetry made explicit: the first pilot domain is chosen by analyst judgment; only subsequent domains are chosen from aggregated feedback signal.
  - Standing cadence rule: every new ReferenceCard domain and every runtime-behavior promotion requires its own benchmark slice (guardrail #5 as a recurring gate).
  - Post-acceptance priority order: side bar calibration check → teaching impact measurement → node sizing completion → scaffolding unfreeze last.
  - Fast-path graduation gate defined: supervisor-skip mode requires a recorded pilot window with zero blocking supervisor corrections on fast-path-eligible queries, observed via the Tranche B telemetry sink — which sequences fast-path graduation after Tranche B.
- What remains deferred: unchanged; this entry adds ordering, not new active work.
- Template boundary held: no client artifacts, identifiers, or evidence added.
- Evidence source for this update: review discussion of the restructured governance document in this change set's session.

### As of 2026-06-09 (operational trust tranche completed)

- Decision: Tranche B (Operational Trust) is closed. All four items shipped across commits `8cc4a14` through `b989e84` inclusive and all four acceptance criteria are satisfied. Tranche A — the implementation ReferenceCard acceptance run — is now the sole active tranche.
- What shipped, per item:
  - (1) *Firestore retention.* `infra/firestore.ttls.json` is the manifest of per-collection TTL fields (7 collections, parity-tested by `tests/infra/firestoreTtls.test.ts`); `response_context` documents now carry `expiresAt` honoring `RESPONSE_CONTEXT_RETENTION_DAYS` (default 90d) and `escalation_state` carries a 90d `retainUntil` (its `expiresAt` remains the escalation timeout, not retention); `getResponseContextsSince()` is bounded (limit 5000 with truncation warning); the README "Firestore TTL Policy" section documents the `gcloud firestore fields ttls update` apply one-liner; `scripts/backfill-retention-fields.ts` backfills pre-existing deployments.
  - (2) *Telemetry sink.* `setDefaultUsageSink()` in `src/agents/modelGateway.ts` provides a default-sink fallback (the ALS sink still takes precedence; sink calls are try/caught); app.ts wires it to the root logger, so every `generateForNode` call in a default deployment emits one structured `model.usage` log line with node id, prompt/candidates/thoughts token counts, and latency.
  - (3) *Time-driven escalation lifecycle.* `POST /api/lifecycle-sweep` (`src/handlers/lifecycleSweep.ts`, Bearer `LIFECYCLE_SWEEP_SECRET`, timing-safe auth) drives `checkOverdueEscalations()` — which now returns `{throttled, pending, reminded, timedOut}` counts — on wall-clock time; the README documents the 10-minute Cloud Scheduler job, so a `park_wait` escalation in a zero-traffic workspace is marked `timed_out` and the original thread notified within one sweep interval.
  - (4) *✅ promise honored.* `src/handlers/escalationReaction.ts` registers a `reaction_added` handler: a ✅ on a `best_effort_verify` card posts the confirmation to the original thread and resolves the escalation; on a `park_wait` card with proposed SQL it re-runs the pipeline with the confirmation as guidance and the confirmed SQL as a refinement hint, so the generator starts from what the analyst approved (skipping teaching-candidate harvesting, since the reaction carries no new human-authored guidance); cards without a best guess get a "reply instead" nudge and no longer show the ✅ copy (`src/slack/escalationBlocks.ts`). README documents the `reactions:read` scope and `reaction_added` event subscription.
- Found and fixed along the way: a pre-existing crash bug in `src/handlers/dbtRunIngestion.ts` auth — a multibyte `Authorization` header could match the expected *string* length while differing in *byte* length, making `timingSafeEqual` throw and crash the process. Both webhook endpoints now compare byte lengths.
- Post-closeout amendment (same date): the final whole-branch review found the park_wait ✅ path re-ran the pipeline without showing the generator the confirmed SQL; commit `b989e84` passes it through the existing `refinementHint` mechanism, restoring the design's "the confirmed SQL actually executes" semantic.
- Post-closeout amendment (2026-06-10): the operator halves of the acceptance criteria were executed and verified live in the first production install — Cloud Scheduler job firing every 10 minutes with the sweep endpoint returning 200 sweep-count JSON, all 7 manifest TTL policies ACTIVE, and the retention backfill applied to pre-existing documents. Two operational findings from that rollout are recorded in the README scheduler section: `gcloud scheduler jobs create` echoes the Authorization header (rotate if the output was captured; rotation requires rolling a revision because `latest`-pinned secret env vars resolve at instance startup), and `--update-secrets` rolls a config-only revision that reuses the previously deployed image (a stale image 404s every sweep — verify a 200 after job creation).
- Consequence for the Tranche Horizon: the fast-path graduation gate's telemetry precondition now exists — supervisor review of fast-path-eligible queries is observable via the production `model.usage` sink. The gate itself remains unevaluated until a pilot window is recorded.
- What remains deferred: unchanged. The operator halves of the acceptance criteria (creating the Cloud Scheduler job, applying the live TTL policies) are documented README steps, not template code.
- Template boundary held: no client artifacts, project IDs, store IDs, or evidence added; everything shipped is template-safe infrastructure.
- Evidence source for this update: commits `8cc4a14` through `b989e84` inclusive on the operational-trust branch (854 tests passing, typecheck clean) and the four acceptance criteria walked against that diff in this change set's session.

### As of 2026-06-10 (sanctioned UX-trust items shipped)

- Decision: all three Sanctioned UX-Trust Items are closed. They were prerequisites for the feedback-sensor strategy, not feature expansion; none touched the evaluation scaffolding, the pipeline's SQL path, or any frozen surface. Tranche A — the acceptance run — remains the sole active tranche.
- What shipped, per item:
  - (1) *Feedback-loop closure.* New `pending_notifications` Firestore collection (`src/state/pendingNotifications.ts`; idempotent `notif_<candidateId>` ids cap re-approval duplicates at one live doc; 30d `expiresAt` TTL; status-only query, so no composite index). `scripts/promote-teachings.ts` enqueues on approval via the new `getEscalationById()` provenance lookup — best-effort by design: a missing escalation doc (past its 90d retention) logs and skips without blocking promotion, and the CLI gains no Slack dependency. `deliverPendingNotifications()` (`src/handlers/notificationDelivery.ts`) posts to the originating thread, mentions the reporting user when `feedbackUserId` was captured, and marks `delivered` only after the Slack post succeeds (at-least-once delivery); `registerLifecycleSweep` runs it alongside `checkOverdueEscalations()` and merges `notificationsDelivered` into the sweep response JSON. Notification fires at *approval*, not CI sync — the accepted imprecision ("part of my knowledge" is durably true at YAML commit, live after the next sync) is recorded in the design doc.
  - (2) *Help/onboarding surface.* Pure `buildHelpBlocks()` builder (`src/slack/helpBlocks.ts`, typed `KnownBlock[]`, only header/section/context/divider blocks — valid on both message and home surfaces). `/anna help` and bare `/anna` short-circuit before the rate limiter and the Flash intake call (help costs nothing) and respond ephemerally via Bolt's `respond()` — response_url-based, so it works in conversations the bot is not a member of. The App Home tab (`src/handlers/appHome.ts`, `app_home_opened`) republishes the same content statelessly on every open, best-effort (a disabled Home Tab toggle logs a warning, nothing breaks). Help copy is template-generic; a deny-regex test pins the boundary. The first-contact DM greeting is explicitly out of v1 (needs per-user state).
  - (3) *Clarification bailout.* A cancel button on both surfaces where a pending clarification is visible — the clarifying question itself and preflight guard 2's block message, which now also quotes the original question for context. `src/handlers/clarificationCancel.ts` deletes the state and updates the message; idempotent when the state already expired or was cancelled from the other surface, and the failure path keeps a retry affordance instead of stripping the only button that can retry.
- Found and fixed by the per-task two-stage review (spec compliance, then code quality): the help copy initially omitted the *Show SQL* button and overpromised ("in any channel", "every answer has" format buttons); the help intercept's original `chat.postEphemeral` would have thrown `channel_not_found` exactly where a new user first tries `/anna help` (replaced with `respond()`); the cancel handler's failure path stripped all blocks while telling the user to "try again". Each fix amended the plan/design docs in the same change set. One pre-existing defect was registered in the Code Debt Register rather than fixed here: `/anna <question>` in a channel the bot is not a member of still fails silently (the question path posts via `chat.postMessage`).
- Operator steps (post-merge): apply the new TTL policy (`gcloud firestore fields ttls update expiresAt --collection-group=pending_notifications --enable-ttl`); Slack app config — add `app_home_opened` to Event Subscriptions and enable App Home → Home Tab, then reinstall the app; deploy via the local-docker procedure; verify one end-to-end notification (approve a test candidate, confirm the next sweep returns `notificationsDelivered: 1` and the message lands in the originating thread).
- Consequence for the Tranche Horizon: item 1 satisfies the hard sequencing precondition on second-ReferenceCard-domain selection. The selection gate itself still requires the recorded acceptance decision — nothing in this tranche advances Tranche A.
- Scaffolding freeze respected: no new benchmark, calibration, sizing, sweep, or acceptance machinery was built.
- Template boundary held: no client artifacts, identifiers, or evidence; all shipped copy is template-generic.
- Evidence source for this update: design doc `docs/superpowers/plans/2026-06-10-ux-trust-items-design.md` and implementation plan `docs/superpowers/plans/2026-06-10-ux-trust-items-implementation.md` (both amended in-flight where review found plan-level defects); commits `aa173d1` through `2e27734` (894 tests passing across 116 files, typecheck clean).
