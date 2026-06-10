# Sanctioned UX-Trust Items — Design

The three UX-trust items from `docs/trajectory-governance.md` ("Sanctioned
UX-Trust Items"). They are prerequisites for the feedback-sensor strategy, not
feature expansion, and are exempt from the evaluation-scaffolding freeze. Item
1 carries the hard sequencing rule: **it must ship before the second
ReferenceCard domain is selected.**

Ordered by trajectory priority (1 is the gate), not by effort.

---

## 1. Close the feedback loop to the user

### Problem

The correction loop is human-gated end to end — 👎 → reason → escalation →
analyst reply → teaching candidate → `scripts/promote-teachings.ts` approval →
`teachings/*.yml` → CI sync — but from the reporting user's perspective it is
write-only past the second step. The user who flagged a wrong answer hears the
analyst's correction (escalation resume posts to their thread), but never
learns their feedback became a *permanent teaching*. The governance doc calls
notification "the cheapest retention mechanism the feedback sensor has": users
stop feeding a sensor that never visibly responds, and from the second
ReferenceCard domain onward, domain selection comes *from* that sensor.

### Provenance chain (already in place, nothing to add at capture time)

A feedback-triggered escalation gets `escalationId = esc_fb_<traceId>` with
`context.feedbackUserId` (`src/handlers/feedbackEscalation.ts`); the candidate
generated from its resolution is `candidateId = teach_<escalationId>`
(`src/teachings/candidateGenerator.ts`); `escalation_state` docs are keyed by
`escalationId` and retained 90 days (`retainUntil`). So at promotion time the
chain `candidate.escalationId → escalation_state doc → originalChannel /
originalThreadTs / context.feedbackUserId` recovers the originating thread and
user for any candidate promoted within the retention window.

### Design

**The CLI originates; the bot delivers.** `promote-teachings.ts` runs on an
operator machine with Firestore credentials only — it has no Slack dependency
today and should not grow one (a missing local `SLACK_BOT_TOKEN` must never
make promotion fail or silently skip notification). Instead, approval enqueues
a notification document; the deployed bot — which owns all Slack I/O — delivers
it on the existing scheduler-driven lifecycle sweep (≤10 min lag, irrelevant
for a days-later promotion event).

1. **New leaf state module** `src/state/pendingNotifications.ts`, collection
   `pending_notifications`:

```typescript
export interface PendingNotification {
  id: string;                       // notif_<candidateId> — idempotent re-approval
  kind: 'teaching_promoted';        // discriminator for future notification kinds
  channel: string;                  // originalChannel
  threadTs: string;                 // originalThreadTs
  userId?: string;                  // context.feedbackUserId — mention when present
  teachingId: string;               // the promoted candidateId
  status: 'pending' | 'delivered';
  createdAt: Date;
  expiresAt: Date;                  // 30d TTL — undelivered docs must not pile up
}
```

   `getPendingNotifications()` queries `where('status','==','pending')` only —
   **no orderBy, so no composite index** (delivery order is irrelevant).
   Omit `userId` when absent, never `undefined` (Firestore write contract).

2. **CLI hook** in `runPromotion` (`scripts/promote-teachings.ts`): on
   approve, after `updateCandidateStatus`, look up
   `getEscalationById(candidate.escalationId)` (new one-line getter — docs are
   keyed by escalationId) and, when the doc still exists, enqueue the
   notification. Best-effort: a failed lookup/enqueue logs and continues —
   notification must never block promotion. Notify for **every** promoted
   candidate with a recoverable origin thread, not only `esc_fb_*` ones — an
   escalation-originated teaching closes the same loop with the asker; the
   feedback case (the sanctioned core) is distinguished only by mentioning
   `feedbackUserId`.

3. **Delivery on the sweep**: new `deliverPendingNotifications(client)` in
   `src/handlers/` alongside `checkOverdueEscalations`; `registerLifecycleSweep`
   calls both and merges counts into the response JSON
   (`{... , notificationsDelivered}`). Copy, posted to the originating thread:

   > ✅ <@user> your feedback on this answer was reviewed by the data team and
   > is now part of my knowledge. Future answers to questions like this will
   > use it.

   (Without `userId`: "An update from the data team: the guidance from this
   thread is now part of my knowledge…") Mark `delivered` only after the Slack
   post succeeds; a failed post leaves the doc `pending` for the next sweep
   (at-least-once; the idempotent doc id caps re-approval duplicates at one
   live doc).

4. **Manifests + docs**: add the `pending_notifications` / `expiresAt` row to
   `infra/firestore.ttls.json` (parity test will force this), the collection
   row to CLAUDE.md's Firestore table, and the TTL apply line to the README.
   No composite index needed.

### Why notify at approval, not CI sync

The teaching is "live" only after the CI knowledge sync, which runs on push —
minutes to hours after approval. Tying notification to the sync workflow would
couple a user-facing promise to CI plumbing (and GitHub Actions would need
Slack credentials). Approval is the human decision the user was promised;
the copy says "is now part of my knowledge" in the durable sense, which is
true the moment the YAML is committed. Accepted imprecision, recorded here.

### Tests

- State: enqueue omits absent `userId`; pending query returns only `pending`.
- CLI: approval enqueues with the escalation's thread/user; missing escalation
  doc (past retention) logs and skips without failing promotion; rejection
  enqueues nothing.
- Sweep: delivery posts to the right thread, mentions the user when present,
  flips `delivered`; a Slack failure leaves the doc pending; sweep response
  includes the count.
- TTL parity test updated for the new collection.

**Effort:** ~140 lines + tests. When this ships, append a dated Evidence Log
entry to `docs/trajectory-governance.md` (it satisfies the Tranche Horizon's
gate on second-domain selection).

---

## 2. Help / onboarding surface

### Problem

There is no `/anna help`, no App Home content, and no first-contact greeting.
Users learn the bot by trial and error, and the two suspension states
(clarification wait, escalation wait) are mysterious to anyone who hasn't hit
them before. (2026-06-09 audit, "UX-trust gaps".)

### Design

One pure block builder, two entry points. Content is static and
template-generic (no client domains, tables, or examples — the template
boundary applies to help copy too; implementations override).

1. **`src/slack/helpBlocks.ts`** — pure `buildHelpBlocks()` returning Block
   Kit sections: what Anna answers (natural-language questions over the
   warehouse), how to ask (`/anna <question>`, @mention, DM), three generic
   example questions, what a clarifying question means (answer it or cancel),
   what "asked the data team" means (escalation + expected wait), the response
   buttons (feedback / reasoning / format overrides), and the rate limit.

2. **`/anna help` and bare `/anna`** — in `registerCommands`, intercept
   before the rate-limit check and before `maybeHandleSlackIntake`
   (`command.text.trim().toLowerCase() === 'help'` or empty). Help must cost
   nothing: no rate budget, no Flash intake call, no thread, ephemeral
   response (`postEphemeral` — asking for help should not spam the channel).

3. **App Home** — register `app_home_opened` (event already reaches the bot
   with standard bot scopes; the App Home feature must be toggled on in the
   Slack app config — README note) and `views.publish` the same content
   rendered for the `home` surface. Re-publish on every open; no state.

**Explicitly out of v1:** a first-contact DM greeting. It needs per-user
"already greeted" state to avoid repetition; App Home + help cover onboarding
without new state. Revisit only on evidence users don't find either.

### Tests

- Block builder: pure snapshot-ish assertions (sections present, no
  client-specific strings).
- Commands: `help`/empty text short-circuits before rate limiter and intake
  (assert neither mock called), responds ephemerally.
- App Home: `app_home_opened` publishes a `home` view; publish failure logs
  and does not throw.

**Effort:** ~150 lines, mostly copy. No new state, no new collections.

---

## 3. Bailout for threads stuck on pending clarification

### Problem

A pending clarification blocks its thread for up to `CLARIFICATION_TTL_MS`
(1h). Preflight guard 2 (`src/handlers/preflightChecks.ts`) now *tells* the
user they're blocked, but offers no exit — a user who can't or won't answer
the clarifying question can only wait out the hour. The clarifying message
itself (`src/slack/clarificationBlocks.ts`) likewise presents no way to
abandon. (Lazy expiry here is silent-but-benign — `getClarificationState`
deletes expired docs, which *unblocks* the thread rather than suppressing a
notification, so unlike the escalation case there is no missing-notice defect
to fix; the gap is purely the missing user-initiated exit.)

### Design

A cancel action, offered in both places the pending state is visible.

1. **Cancel button on the clarifying question** — add an actions block to
   `buildClarificationBlocks` (button text "Never mind — cancel",
   `action_id: 'clarification_cancel'`, `value: clarificationId`).

2. **Cancel button on the preflight block message** — guard 2 currently calls
   boolean `hasPendingClarification`; switch to `getClarificationState(threadTs)`
   (same read, richer return) and post blocks instead of bare text: the nudge,
   the original question for context ("waiting on my question about:
   _<originalQuestion>_"), and the same cancel button.

3. **Action handler** `src/handlers/clarificationCancel.ts`, registered in
   app.ts next to the other `app.action` registrations and delegating
   immediately (no business logic in app.ts): on click, ack, then
   `deleteClarificationState(clarificationId)`, update the clarifying message
   (`chat.update` via the action's message ts) to "No problem — cancelled.
   Ask me something new whenever.", strip the buttons. **Idempotent:** if the
   state is already gone (expired/cancelled from the other surface), still
   update the message to the cancelled copy — the user's intent is satisfied
   either way. Cancellation deletes outright (matching the expiry path) rather
   than keeping a `cancelled` status doc; there is nothing downstream that
   needs to distinguish the two.

No new collections, no new scopes (`app.action` interactivity is already in
use for feedback buttons).

### Tests

- Blocks: clarifying message and preflight block include the cancel action
  with the clarificationId value.
- Handler: cancel deletes state and updates the message; already-deleted
  state still acks with the cancelled copy (no throw, no error reply).
- Preflight: guard 2 message carries the original question and button;
  behavior when nothing is pending is unchanged.

**Effort:** ~80 lines + tests. Smallest of the three.

---

## Sequencing

1 → 3 → 2. Item 1 first because it is the only one with a governance gate
hanging on it (second-domain selection); 3 before 2 because it is smaller and
touches state behavior (riskier to leave half-designed) while 2 is almost
entirely copy. All three are independently shippable; none touches the
evaluation scaffolding, the pipeline's SQL path, or any frozen surface. Item 1
adds one Firestore collection (TTL manifest + parity test keep it honest);
items 2–3 add none.
