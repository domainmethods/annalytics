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
   thumbs handler → persist                      clarification gate → ambiguity
     feedback_signal (domain,                      classifier → org-knowledge?
     verdict, ts)                                   ├─ no  → ask USER (today)
        │                                           └─ yes → SIDE BAR:
   aggregate by domain/window                          suspend, post to admin,
        │                                              user sees "checking with
   readout: domain pain ranking                        the team", match reply,
   (CLI report + feed promote-teachings)               resume, answer, capture
                                                       ruling as teaching candidate
```

## 5. Component A — Feedback Sensor (reactive)

### 5.1 Capture with domain attribution

**Decision: attribute at render time, not lookup time.** When response blocks are built (`slack/blocks.ts`), embed the answer's domain in the thumbs button `value` payload (not just the `traceId` in `action_id`). The thumbs handler (`app.ts:157`) then has the domain in hand with no Firestore read.

Domain is resolved when the response is produced, in priority order:
1. The `domain` of any cited ReferenceCard (e.g. `revenue`).
2. Fallback: a coarse tag derived from the dominant table touched (`retrievedSchema.tables` on `ResponseContext`) — e.g. dataset or model prefix.
3. `unclassified` when neither is available.

### 5.2 Persist the signal

New leaf state module `src/state/feedbackSignal.ts` → Firestore collection `feedback_signal`:

```ts
interface FeedbackSignalEvent {
  traceId: string;          // dedupe key; one verdict per response
  domain: string;           // 'revenue' | ... | 'unclassified'
  verdict: 'positive' | 'negative';
  createdAt: Date;
}
```

- Write is idempotent on `traceId` (a user toggling 👍↔👎 updates the same doc — last verdict wins). Follow the `firestore-rejects-undefined` convention: omit optional fields, never write `undefined`.
- **Privacy:** no question text, no SQL, no userId stored here. Counts and a domain label only.

### 5.3 Aggregate + read out

`getDomainPainRanking(windowDays)` returns, per domain: `{ domain, total, negative, negativeRate }`, sorted by `negativeRate` (with a minimum-sample floor so a 1/1 domain doesn't top a 40/100 one).

Two consumers:
- **CLI readout** (`scripts/feedback-report.ts`): prints the ranking. This is the instrument an admin uses to choose the next ReferenceCard domain.
- **Fold into `promote-teachings.ts`**: show the domain pain ranking alongside pending candidates, so the human reviewing knowledge sees *where* the pain concentrates.

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

Both arms need "what domain is this?" Implement once (`src/agents/domain.ts` or a helper on the response path) and reuse: the sensor tags feedback events; the side-bar classifier tags rulings.

### 7.3 Relationship to items 2 and 3

- **Item 2** (`feedback_notes` reader, flagged task `task_27603db5`): the informed human gate. The sensor's domain ranking and the notes reader both surface in `promote-teachings.ts`.
- **Item 3** (impact measurement): once the sensor exists, measuring whether a promoted teaching lowers a domain's `negativeRate` over time is a natural follow-on. Out of scope for this doc; enabled by it.

## 8. Module boundaries (must hold)

Per `CLAUDE.md`:
- `agents/` (ambiguity classifier, domain helper) never imports from `slack/` or `state/`.
- `state/feedbackSignal.ts` is a leaf (no domain-module imports).
- `handlers/` delegates to the pipeline; the thumbs/sensor wiring lives in handlers/pipeline, not business logic in `app.ts`.
- Side-bar suspend/resume goes through `pipeline.ts` + `escalationState`, mirroring existing escalation flow.

## 9. Error handling / fail-safe summary

| Failure | Behavior |
|---|---|
| Domain unresolved | tag `unclassified`; never block the response |
| `feedback_signal` write fails | best-effort; never block the thumbs ack |
| Ambiguity classifier errors | default `user_intent` (ask the user, not the admin) |
| No admin target configured | side bar disabled → existing clarification (ask user) |
| Admin doesn't answer in time | escalation timeout → ask user / best-effort with caveat |

The through-line: **every side-bar failure degrades to existing behavior**, and **every sensor failure degrades to "no signal recorded."** Neither can break a query.

## 10. Testing strategy

- **Sensor (pure where possible):** `getDomainPainRanking` is a pure reducer over events — test the min-sample floor and sort without mocks. `feedbackSignal.ts` write/idempotency with the Firestore mock. Domain attribution priority (card → table → unclassified) as a pure function.
- **Ambiguity classifier:** mock Gemini; assert `org_knowledge` vs `user_intent` routing on fixtures, and the fail-safe default on error.
- **Side bar wiring:** integration test in `tests/integration/` with external services mocked — assert that org-knowledge LOW confidence suspends to the admin target (not the user thread), the user sees the neutral status, an admin reply resumes and answers, and a teaching candidate is created.
- **Fail-safes:** explicit tests for each row of §9.

## 11. Open questions (for review)

1. **Domain taxonomy.** Is `domain` driven purely by ReferenceCards (so unattributed until cards exist for a domain), or do we want a small standalone domain list up front? Recommendation: cards-first, `unclassified` fallback — keeps the template honest (no invented client domains).
2. **Side bar scope in v1.** Confirm v1 = clarification-gate routing only, deferring post-SQL semantic verification. Recommendation: yes (minimal surface).
3. **`escalation_state` reuse vs `sidebar_state`.** Reuse with a new `trigger` (DRY) vs a dedicated collection (clearer separation, more code). Recommendation: reuse.
4. **Readout surface.** CLI-only for v1, or also a scheduled digest to the admin channel? Recommendation: CLI-only first (no new outbound posting behavior to sanction).
5. **Calibration gate strictness.** Hard-block side-bar shipping on a calibration threshold, or ship behind a config flag and measure in production? Recommendation: config flag (`escalation.sideBar` off by default) + measure, so calibration data accrues before broad enablement.

## 12. Suggested sequence (not the plan — that's a writing-plans pass)

1. Domain attribution helper + `feedback_signal` capture + ranking + CLI readout. *(Sensor; immediately useful; also the calibration instrument.)*
2. `feedback_notes` reader (item 2) folded into `promote-teachings`. *(Already flagged.)*
3. Ambiguity classifier + calibration validation slice. *(Gates the side bar.)*
4. Side-bar suspend/consult/resume on `escalation_state`, behind `escalation.sideBar` flag, ruling→candidate capture.
5. Impact measurement (item 3) once a domain has been taught.

---

**Template-safety note:** this design and its eventual implementation stay template-agnostic. `revenue` appears only as the committed sample domain. No project IDs, File Search store IDs, client domains, benchmark evidence, or Cloud Run URLs are introduced.
