# Negative-Feedback Escalation Design

> **For Claude:** When implementing, use superpowers:executing-plans (or subagent-driven-development) task-by-task.

**Goal:** Turn the 👎 button from a write-only Firestore record into an actionable, reason-routed path that reaches a human analyst for genuine data-correctness doubts — without flooding analysts with low-signal clicks.

**Status:** Design approved 2026-06-06. Not yet implemented.

**Governing checkpoint:** `docs/trajectory-governance.md`. This is trust infrastructure (guardrail #1) and human-reviewed escalation (guardrail #3) — the *allowed* side of the "automatic correction harvesting from binary feedback" line that remains deferred. Implementation must update the governance doc in the same change set (maintenance protocol).

---

## Problem

Today `thumbs_(up|down)` ([src/app.ts](../../../src/app.ts) `thumbs_(up|down)_.*` handler) only calls `recordFeedback(...)`, which sets `negativeFeedback: true` on the `response_context` doc. Nobody is notified; the signal dies in Firestore. Meanwhile a full human-in-the-loop escalation system already exists for the *pre-delivery* `exhausted` case but is never reached by *post-delivery* human dissatisfaction.

## Principle: route the reason to the cheapest effective remedy

👎 is low-precision. A required one-tap reason step routes each dissatisfaction type:

| Reason | Remedy | Rationale |
|---|---|---|
| **Wrong number** | Escalate to analyst | True correctness doubt |
| **Wrong data / tables** | Escalate to analyst | Semantic/grounding error |
| **Not what I asked** | Refine (existing refinement path) | Intent mismatch — pipeline re-runs, no human |
| **Other / formatting** | Record only + acknowledge | Low signal; page no one |

Only the first two reach a human. This keeps analyst volume proportional to actionable, data-correctness dissatisfaction.

## Approved UX decisions (2026-06-06)

- **Ephemeral intake.** The reason prompt is posted with `chat.postEphemeral` (clicker-only). The public thread stays clean; the *resolution* still posts publicly in-thread.
- **Reason required.** Always show the 4-reason prompt; no one-tap bypass. Best signal-to-noise + gives the analyst context.
- **On by default when a target is configured.** Enabled wherever `config.escalation` resolves a channel/DM target; overridable via `escalation.onNegativeFeedback === false`. If no target is configured, 👎 falls back to today's record-only behavior.

## Flow

1. **👎 clicked** → keep `recordFeedback(...)`; then `promptFeedbackReason(...)` posts an ephemeral message with reason buttons. Each button's `value` carries the compound key `${threadTs}_${statusMsgTs}`; `action_id` encodes the reason (e.g. `fb_reason_wrong_number`).
2. **Reason clicked** → `/fb_reason_.*/` handler delegates to `handleFeedbackReason(...)`:
   - Escalating reasons: load `getResponseContext(compoundKey)`; if missing → degrade ("can't pull this answer's details anymore — re-ask"). Else de-dup via `hasPendingEscalation(threadTs)`; if clear, `saveEscalationState({...})` with `trigger: 'user_negative_feedback'`, `behavior: 'best_effort_verify'`, `context.feedbackReason`, `context.previousSql = ctx.generatedSql`, and post `buildEscalationBlocks(...)` to the resolved target. Replace the ephemeral with "✅ Flagged for the data team."
   - "Not what I asked": post the existing refine prompt (reuse `refine_assumptions` behavior).
   - "Other": acknowledge ephemerally; record only.
3. **Analyst replies** in the escalation thread → **existing** `checkEscalationResponse` + `resumeFromEscalation` forward the review to the user's thread and spawn a human-reviewed teaching candidate. No new code.

## Reuse map

**Unchanged:** `saveEscalationState`, `getEscalationByEscalationThread`, `resolveEscalation`, `hasPendingEscalation`, `buildEscalationBlocks`, `checkEscalationResponse`, `resumeFromEscalation`, `checkOverdueEscalations` (reminders + timeouts sweep all pending escalations, so 👎 escalations get them for free), the teaching-candidate flow.

**New / changed:**
- `src/types.ts` — add `'user_negative_feedback'` to `EscalationState['trigger']`; add optional `context.feedbackReason?: string` and `context.feedbackUserId?: string`.
- `src/slack/feedbackBlocks.ts` *(new)* — `buildFeedbackReasonBlocks(compoundKey)` and `buildFeedbackAckBlocks(message)` (takes the final ack/flagged message text).
- `src/handlers/feedbackEscalation.ts` *(new; mirrors `escalationResponse.ts`)* — `promptFeedbackReason(...)`, `handleFeedbackReason(...)`. Business logic lives here, not in the coverage-excluded `app.ts`.
- `src/app.ts` — `thumbs_(up|down)` handler calls `promptFeedbackReason` on negative; register one `/fb_reason_.*/` action handler delegating to `handleFeedbackReason`.
- `src/pipeline.ts` — export `resolveEscalationTarget` (currently private) for handler reuse, or lift to a shared util.
- Config — add `escalation.onNegativeFeedback?: boolean` to the escalation config type + `toPipelineConfig` passthrough + `.env.example` documentation.
- `docs/trajectory-governance.md` — one rationale line stating the boundary: human-reviewed escalation only; teaching outputs stay candidates, never auto-promoted.

## Data model

- `escalation_state` doc id for feedback escalations: `esc_fb_${traceId}` (distinct from the pipeline's `esc_${traceId}` to avoid `.set()` overwrite).
- `behavior: 'best_effort_verify'` — the answer already shipped; relay the human's review, do not block/re-run (`park_wait`).
- `stageToResume`: `'supervisor_review'` (unused on the best_effort path).

## Guards & edge cases

- **De-dup:** `hasPendingEscalation(threadTs)` before create; if in flight, acknowledge "already flagged."
- **Missing context:** expired/old message → record-only degrade with a re-ask nudge.
- **No target configured:** skip escalation entirely; record-only.
- **👎 then 👍:** last-write feedback; an already-fired escalation stands. Acceptable for v1.
- **Format complaints:** never page an analyst.

## Testing

- Unit: `buildFeedbackReasonBlocks` (4 buttons, correct `action_id`/`value`), `buildFeedbackAckBlocks`.
- Integration (Slack + Firestore mocked): 👎 → ephemeral posted; escalating reason → `saveEscalationState` called with `trigger: 'user_negative_feedback'` + `feedbackReason`; de-dup path when `hasPendingEscalation` is true; missing-context degrade; "Not what I asked" → refine prompt, no escalation; disabled (no target) → record-only.
- Resolution path: covered by existing `escalationResponse` tests (unchanged).

## Sequencing

- **Phase 1 (this plan):** reason prompt + routing + escalation create/de-dup for the two data-correctness reasons. Ships the core value.
- **Phase 2 (folded into Phase 1):** "Not what I asked" → refinement path. Because this route is near-free (post the existing refine prompt; no human, no state), the implementation plan delivers it together with Phase 1 rather than splitting it into a separate change. "Other" → record-only is likewise included.
- **Phase 3 (separate, measure-first):** low-supervisor-confidence async spot-check (`best_effort_verify`, not `park_wait`), gated on measuring the passed-but-low-confidence error rate against the benchmark (guardrail #5). Its own decision, not bundled here.

## Out of scope / explicitly deferred

- Auto-promoting feedback resolutions into retrieval (stays human-reviewed candidates only).
- Lowering the *pipeline* escalation threshold from `exhausted` to passed-but-low-confidence (Phase 3, measure first).
