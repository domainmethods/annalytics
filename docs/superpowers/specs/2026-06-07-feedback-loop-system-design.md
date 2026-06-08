# Feedback Loop System Design — Sensor + Side Bar

**Date:** 2026-06-07
**Status:** Design (pre-implementation). Requires approval before a writing-plans pass.
**Governance:** Sanctioned by the 2026-06-07 entry in `docs/trajectory-governance.md` (feedback loop adopted as trust infrastructure serving the implementation acceptance tranche). This doc designs the *reactive sensor* (item 1) and the *proactive side bar* (item 4) as one system. Items 2 (informed human gate) and 3 (impact measurement) are referenced where they connect but are not fully specified here.

---

## 1. Context

Anna Lytics has three agent→admin channels, two of which exist and one of which is new:

| Channel | Trigger | Timing | Status |
|---|---|---|---|
| 👎 correction | user dislikes an answer | after a bad answer ships | exists (`feedbackEscalation.ts`) |
| Failure escalation | supervisor loop exhausted | after retries fail | exists (`escalationDecision.ts`) |
| **Side bar** | low confidence on **org-knowledge** meaning | **before** answering | **new** |

Two observations from the current code motivate this design:

1. **The confidence signal is already produced and reconciled but under-consumed.** `src/agents/confidence.ts` (`reconcileConfidence`) merges the `high|medium|low` confidence emitted by the clarification agent, the SQL generator, and the supervisor. Today that reconciled signal drives human contact in exactly one place — `decideEscalation()`, and only *after* the supervisor loop is exhausted.
2. **Binary feedback is captured but discarded.** 👍/👎 buttons carry the `traceId` in their `action_id` (`thumbs_up_${traceId}`). The negative path branches to reasons/escalation; neither thumb is persisted as an aggregatable signal. The richest free-text signal (`feedback_notes`) is write-only (tracked separately as the item-2 maintenance fix).

## 2. The unifying model

> **Know where you're confused, then resolve it.**

- The **sensor** (reactive arm) aggregates feedback into a per-domain *pain signal* — it tells humans *where* the semantic layer is thin.
- The **side bar** (proactive arm) fires when the agent is itself uncertain about business meaning, and resolves that uncertainty against the right human *before* answering — harvesting the ruling as reusable knowledge.

They share two things, which is why they are one system:
- the **reconciled-confidence signal** (sensor measures aggregate low-confidence/negative outcomes; side bar reacts to per-query low confidence), and
- the **teaching-candidate capture path** (both ultimately feed human-reviewed knowledge into retrieval).

## 3. Goals / Non-Goals

**Goals**
- Persist 👍/👎 as a privacy-safe, per-domain aggregate signal usable to prioritize knowledge work and to *select the high-confusion domain* for the ReferenceCard acceptance pilot (governance guardrail #5).
- Add a proactive side bar: when reconciled confidence is low *and* the ambiguity is org-knowledge-shaped, privately consult an admin before answering; route the ruling into the existing teaching-candidate flow.
- Reuse existing substrate (confidence reconciliation, escalation suspend/resume + reply-matching, teaching candidates) rather than building parallel machinery.

**Non-Goals**
- No automatic promotion of feedback or rulings into production retrieval. Admin rulings become teaching *candidates* requiring human approval via `promote-teachings.ts`. (Governance: "automatic correction harvesting" stays deferred.)
- No raw-query corpus. Aggregation stores counts/rates by domain only.
- No change to SQL generation, validation, execution, or response formatting.
- No client-specific domains, project IDs, store IDs, or Cloud Run URLs in this template. `revenue` is used below only as the committed sample domain.

## 4. Architecture overview

```
                 ┌─────────────────────── SHARED ───────────────────────┐
                 │ reconciled confidence (agents/confidence.ts)          │
                 │ domain attribution (ReferenceCard.domain / tables)    │
                 │ escalation suspend/resume + reply match (escalationState) │
                 │ teaching candidates (state/teachingCandidates.ts)     │
                 └───────────────────────────────────────────────────────┘
   REACTIVE ARM (sensor)                         PROACTIVE ARM (side bar)
   ─────────────────────                         ────────────────────────
   thumbs handler → recordFeedback               clarification gate → ambiguity
     writes negativeFeedback onto                  classifier → org-knowledge?
     response_context (EXISTING)                    ├─ no  → ask USER (today)
        │                                           └─ yes → SIDE BAR:
   sensor READS response_context                       suspend, post to admin,
   window → aggregate by domain                        user sees "checking with
        │                                              the team", match reply,
   readout: domain pain ranking                        resume, answer, capture
   (CLI report + feed promote-teachings)               ruling as teaching candidate
```

## 5. Component A — Feedback Sensor (reactive)

### 5.1 No new capture — the signal already exists

**Decision (revised after grounding): the sensor is a pure read/aggregation layer over the existing `response_context` collection. No new collection, no button-value change.**

`recordFeedback()` (`src/state/responseContext.ts`) already writes `negativeFeedback: true|false` onto each per-response doc, which *already* persists everything the sensor needs:
- the verdict (`negativeFeedback`),
- `tablesUsed` (for domain attribution),
- `createdAt` (for windowing),
- all three confidence sub-signals (`clarificationConfidence`, `primaryAgentConfidence`, `supervisorConfidence`) plus reconciled `confidence` (for calibration).

This means the sensor works on historical data with zero migration, and the proposed `feedback_signal` collection / render-time button payload are unnecessary.

**Privacy boundary holds at the output, not the storage.** `response_context` already stores rich fields (SQL, question) as the pipeline's own persistence — the sensor neither adds to that nor exposes it. The sensor's *outputs* (rankings, calibration) are counts/rates by domain and confidence bucket only.

### 5.2 Domain attribution (derived at read time)

Pure helper `resolveDomain(tablesUsed: string[], domainMap: DomainMapEntry[]): string`, where `DomainMapEntry = { table, domain }`. The map is precomputed once from loaded ReferenceCards in the CLI (`card.canonical_table → card.domain`) and passed in — this keeps `src/feedback/` free of any `ReferenceCard` type dependency and makes the helper trivially unit-testable. Priority order:
1. **Cards-first:** if any `tablesUsed` entry matches a map entry, return that domain (e.g. `analytics.fct_orders` → `revenue`). Both sides are normalized (lowercased, backticks stripped) because `tablesUsed` is LLM output and BigQuery is case-insensitive.
2. **Table fallback:** a coarse tag from the dominant table (dataset/model prefix). This is the bootstrap taxonomy that keeps the ranking meaningful before cards exist.
3. `unclassified` when `tablesUsed` is empty.

Derived from already-stored `tablesUsed`, so it applies to historical docs with no backfill.

### 5.3 Aggregate + read out

A single windowed query, `getResponseContextsSince(windowDays)` (added to `state/responseContext.ts`), fetches the docs; `toFeedbackRecords` maps them to `FeedbackRecord[]` (dropping docs with no thumb or no confidence); then **pure reducers** run over that array — no Firestore in the reducer, so they test without mocks:
- `getDomainPainRanking(records, minSample)` → per domain `{ domain, total, negative, negativeRate, belowSample }`, sorted by `negativeRate` with a minimum-sample floor so a 1/1 domain doesn't top a 40/100 one.
- `getConfidenceCalibration(records)` → per reconciled-confidence bucket `{ confidence, total, negative, negativeRate }`. This is the calibration instrument the side bar (§7.1) gates on — nearly free, since confidence is already stored next to the verdict.

Two consumers:
- **CLI readout** (`scripts/feedback-report.ts`): prints the domain pain ranking and the calibration table. The instrument an admin uses to choose the next ReferenceCard domain *and* to judge whether `low` confidence is trustworthy enough to enable the side bar.
- **Fold into `promote-teachings.ts`** (light): show the domain pain ranking alongside pending candidates so the reviewer sees *where* pain concentrates. May land with the item-2 reader work.

## 6. Component B — The Side Bar (proactive)

### 6.1 Placement: augment the clarification gate

**Decision: the side bar is a router on the existing clarification suspend point, not a new pipeline stage.** Today, when `clarificationAgent` returns LOW confidence, the pipeline suspends and asks the *user* follow-up questions. The side bar inserts one classification step there:

```
clarification LOW confidence
   → classify ambiguity type
       ├─ user-intent  → existing behavior (ask the user)   [e.g. "last month or trailing 30d?"]
       └─ org-knowledge → SIDE BAR (ask an admin)            [e.g. "which table is source of truth for revenue?"]
```

This is the minimal insertion: it changes *who* gets asked, reusing the existing suspend semantics. A later extension (post-SQL semantic verification when SQL exists but confidence is low) is explicitly out of scope for v1 and overlaps with the existing `best_effort_verify`.

### 6.2 The ambiguity-type classifier

New agent `src/agents/ambiguityClassifier.ts` (Gemini Flash, structured output):

```ts
type AmbiguityType = 'user_intent' | 'org_knowledge';
interface AmbiguityResult {
  type: AmbiguityType;
  question: string;     // the single question to put to the human
  domain: string;       // best-effort domain tag, for routing + capture
  reasoning: string;
}
```

- `org_knowledge` ⇔ the resolver is institutional and reusable (source-of-truth table, metric definition, canonical filter). `user_intent` ⇔ the resolver is specific to this asker (timeframe, which of *their* segments).
- **Fail-safe:** on classification error/uncertainty, default to `user_intent` (ask the user) — never spam an admin on a coin-flip. This is the conservative default that protects against analyst fatigue.

### 6.3 The private conference (suspend → consult → resume)

**Decision: reuse `escalation_state`, do not build a parallel suspend/resume.** Add a new `trigger: 'sidebar_consult'` and a `behavior` that means "block on admin, do not answer yet." The escalation substrate already provides everything the side bar needs:

- `saveEscalationState` to suspend.
- Post the question to the configured admin target (`resolveEscalationTarget`, channel or DM) — *not* to the user's thread.
- The user thread shows a neutral status: "Checking with the data team…" (the messy uncertainty stays backstage — this is what makes it a *side bar*).
- Admin reply matched via the existing `getEscalationByEscalationThread` / `checkEscalationResponse` path.
- `checkOverdueEscalations` reminders/timeouts apply unchanged.

On resume with the admin's ruling:
1. Inject the ruling as a hint and re-run SQL generation (the ruling is now a known fact, raising confidence).
2. Answer the user in their thread.
3. Create a **teaching candidate** from the ruling via `candidateGenerator` (reuse the escalation→candidate path), tagged with the domain. It enters `promote-teachings.ts` like any other candidate — human-approved, never auto-synced.

**Timeout fail-safe:** if the admin does not answer within the escalation timeout, fall back to the *existing* behavior — ask the user, or best-effort with caveat — so a silent admin never strands the user.

## 7. Shared concerns

### 7.1 Confidence calibration (prerequisite, per governance)

The side bar's value depends on the reconciled-confidence signal being trustworthy. Before shipping the trigger, validate calibration: across a benchmark slice, do `low`-confidence responses actually correlate with wrong/negative outcomes more than `high`? If confidence is noisy, the side bar fires at the wrong moments. This is a **gating task** in the eventual plan, not an afterthought. The sensor (Component A) is itself a calibration instrument: negativeRate within a confidence bucket measures calibration directly.

### 7.2 Domain attribution is shared

Both arms need "what domain is this?" Implement once as a pure helper (`src/feedback/domainAttribution.ts`, built by the sensor) and reuse: the sensor tags feedback records; the side-bar classifier can import the same `resolveDomain` to tag rulings.

### 7.3 Relationship to items 2 and 3

- **Item 2** (`feedback_notes` reader, flagged task `task_27603db5`): the informed human gate. The sensor's domain ranking and the notes reader both surface in `promote-teachings.ts`.
- **Item 3** (impact measurement): once the sensor exists, measuring whether a promoted teaching lowers a domain's `negativeRate` over time is a natural follow-on. Out of scope for this doc; enabled by it.

## 8. Module boundaries (must hold)

Per `CLAUDE.md`:
- `agents/` (ambiguity classifier) never imports from `slack/` or `state/`.
- `src/feedback/` (domain attribution, aggregation reducers, report formatter) is pure — imports only `types.ts`; no `slack/`, no `state/`, no `agents/`.
- The sensor adds **no new collection**. Its one stateful touch is a read-only windowed query (`getResponseContextsSince`) added to the existing `state/responseContext.ts` leaf.
- `handlers/` delegates to the pipeline; the thumbs wiring already lives there (existing `recordFeedback`), not business logic in `app.ts`.
- Side-bar suspend/resume goes through `pipeline.ts` + `escalationState`, mirroring existing escalation flow.

## 9. Error handling / fail-safe summary

| Failure | Behavior |
|---|---|
| Domain unresolved | tag `unclassified`; never block the response |
| Sensor read/aggregation fails | the CLI reports the error and exits; read-only and offline, so it can never affect a live query or the thumbs ack |
| Legacy doc missing `confidence` | dropped by `toFeedbackRecords` so it can't poison the calibration table |
| Ambiguity classifier errors | default `user_intent` (ask the user, not the admin) |
| No admin target configured | side bar disabled → existing clarification (ask user) |
| Admin doesn't answer in time | escalation timeout → ask user / best-effort with caveat |

The through-line: **every side-bar failure degrades to existing behavior**, and **every sensor failure degrades to "no signal recorded."** Neither can break a query.

## 10. Testing strategy

- **Sensor (pure where possible):** `getDomainPainRanking` / `getConfidenceCalibration` are pure reducers over `FeedbackRecord[]` — test the min-sample floor and sort without mocks. Domain attribution priority (card → table → unclassified), including backtick/casing normalization, as a pure function. The one Firestore-touching piece, `getResponseContextsSince`, is tested with the Firestore mock folded into the existing `tests/state/responseContext.test.ts`.
- **Ambiguity classifier:** mock Gemini; assert `org_knowledge` vs `user_intent` routing on fixtures, and the fail-safe default on error.
- **Side bar wiring:** integration test in `tests/integration/` with external services mocked — assert that org-knowledge LOW confidence suspends to the admin target (not the user thread), the user sees the neutral status, an admin reply resumes and answers, and a teaching candidate is created.
- **Fail-safes:** explicit tests for each row of §9.

## 11. Resolved decisions (2026-06-07)

1. **Domain taxonomy — cards-first + table fallback.** `domain` is resolved as: cited ReferenceCard `domain` → tag derived from the dominant table touched → `unclassified`. The table-derived fallback is load-bearing, not a nicety: it is the bootstrap taxonomy that keeps the sensor's pain ranking meaningful before any cards exist (avoids a cold-start "unclassified: 95%"). No standalone domain enum — inventing domains is template-unsafe and rots.
2. **Side bar v1 scope — clarification-gate routing only.** v1 swaps *who* gets asked at the existing clarification halt (org-knowledge ambiguity → admin instead of user), proving the consult/resume primitive at minimal surface (governance: prove the primitive narrowly first). **Deferred to v2:** post-SQL validation — letting the pipeline generate SQL and asking the admin to validate the concrete table/SQL choice on low reconciled confidence. v2 catches confident-but-wrong answers and yields cheaper analyst rulings (validate-an-artifact beats answer-an-open-question), but requires clarification to not halt on org-knowledge ambiguity plus a new pre-response decision point that must not collide with `best_effort_verify`. Build v1 first, then v2 as a fast-follow.
3. **Suspend/resume — reuse `escalation_state`.** New `trigger: 'sidebar_consult'`; rides the existing suspend, admin-target routing, reply-matching, reminders, and timeouts. No parallel `sidebar_state` collection.
4. **Readout — CLI-only for v1.** `scripts/feedback-report.ts` + fold into `promote-teachings.ts`. A scheduled digest to the admin channel is deferred: it is new proactive outbound behavior and warrants its own governance step.
5. **Calibration gate — config flag, off by default.** Ship behind `escalation.sideBar = off`. The default-off flag is the soft gate (the side bar fires nothing until explicitly enabled), and meanwhile the sensor accrues calibration data (negative-rate per confidence bucket). This breaks the measure-vs-ship chicken-and-egg that a hard threshold would create.

## 12. Suggested sequence (not the plan — that's a writing-plans pass)

1. Domain attribution helper + windowed read over `response_context` + pure ranking/calibration reducers + CLI readout. *(Sensor; immediately useful; also the calibration instrument. Detailed in `docs/plans/2026-06-07-feedback-sensor.md`.)*
2. `feedback_notes` reader (item 2) folded into `promote-teachings`. *(Already flagged.)*
3. Ambiguity classifier + calibration validation slice. *(Gates the side bar.)*
4. Side-bar suspend/consult/resume on `escalation_state`, behind `escalation.sideBar` flag, ruling→candidate capture.
5. Impact measurement (item 3) once a domain has been taught.

---

**Template-safety note:** this design and its eventual implementation stay template-agnostic. `revenue` appears only as the committed sample domain. No project IDs, File Search store IDs, client domains, benchmark evidence, or Cloud Run URLs are introduced.
