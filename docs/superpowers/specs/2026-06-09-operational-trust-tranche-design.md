# Operational Trust Tranche Design

**Date:** 2026-06-09
**Status:** Approved direction; implementation plan at `docs/superpowers/plans/2026-06-09-operational-trust-tranche.md`
**Governing checkpoint:** `docs/trajectory-governance.md`, Active Tranche B

## Problem

The 2026-06-09 repository audit found four production-rot risks that the epistemic-trust
focus had been blind to. None affects answer correctness; all of them erode operational
trust — the system silently accumulates state forever, collects telemetry nobody can
read, lets escalations hang indefinitely in quiet workspaces, and shows analysts a
"React with ✅" affordance that does nothing.

This tranche is sanctioned maintenance under guardrail #1, runs in parallel with the
Tranche A acceptance run, and is fully template-safe (no client inputs required).

## Goals

1. Honor or remove every user-facing promise the escalation card makes (the ✅ quick-path).
2. Make escalation reminders and timeouts fire on wall-clock time, not user traffic.
3. Make per-node token/latency telemetry visible from a deployed instance with zero new
   infrastructure.
4. Declare and document retention for every Firestore collection, including a retention
   window for `response_context`.

## Non-Goals

- No dashboards, metrics exporters, or BigQuery telemetry sinks — structured logs only
  (Cloud Run → Cloud Logging needs nothing new). A queryable sink is a later decision.
- No changes to escalation decision logic (`decideEscalation`, park_wait vs
  best_effort_verify semantics).
- No retention enforcement for human-drained review queues (`teaching_candidates`,
  `feedback_notes`) — deleting unreviewed items would destroy signal; they are drained
  by `scripts/promote-teachings.ts` and analyst review.
- No fast-path graduation evidence collection — the telemetry sink is a *precondition*
  for that gate (governance, Tranche Horizon), not the gate itself.

## Sequencing — promises before plumbing

Slices land in this order. Slice 1 fixes a promise users can already see; slices 2–4 fix
invisible plumbing. Each slice is independently shippable and independently testable.

1. ✅ reaction handler (the escalation card's unfulfilled promise)
2. Time-driven escalation lifecycle endpoint
3. Production telemetry sink
4. Firestore TTL manifest + `response_context` retention

---

## Slice 1: Escalation ✅ Reaction Handler

`src/slack/escalationBlocks.ts:60` tells analysts "React with ✅ if my guess is correct,
or reply with guidance" — but no `reaction_added` handler exists anywhere. Ship the
handler; the copy was the design intent, not an accident.

### Event flow

New module `src/handlers/escalationReaction.ts`, registered from `app.ts` as
`registerEscalationReaction(app, getConfig, getTables)` — mirroring
`registerMessageHandler`'s shape so orchestration stays testable outside the
coverage-excluded entry point.

```
reaction_added event
  → filter: reaction === 'white_check_mark', item.type === 'message'
  → cheap pre-filter (mode=channel only): item.channel === escalation.channelId
    (dm mode skips this — reaction volume is low; the ts lookup is precise)
  → getEscalationByEscalationThread(item.ts)   // card message ts == escalationTs
  → no pending escalation → ignore (natural idempotency, see below)
  → sanity check: state.escalationChannel === item.channel, else ignore
  → state.context.previousSql absent → threaded reply: "There's no proposed SQL on
    this one — please reply with guidance instead." and stop
  → build EscalationResumeContext with synthetic guidance
  → resumeFromEscalation(ctx, client, tables, config, { skipTeachingCandidate: true })
```

Key reuse: `getEscalationByEscalationThread()` (`src/state/escalationState.ts:66`)
already matches an escalation by its card's message `ts` and filters on
`pipelineState == 'awaiting_human'`. The reaction event's `item.ts` is exactly that ts
(reactions to the card itself, not to thread replies — replies have their own ts and
will simply not match, which is correct).

### Resolution semantics

Reuse `resumeFromEscalation()` (`src/handlers/escalationResponse.ts`) with synthetic
`humanGuidance`:

- **best_effort_verify**: guidance `"Confirmed correct via ✅ reaction."` → the existing
  branch posts "The data team reviewed my answer: …" to the original thread and resolves.
  This is the primary case — the card only shows a best guess when one exists.
- **park_wait** (with `previousSql` present): guidance
  `"The data team confirmed the proposed SQL is correct."` → the existing branch re-runs
  the pipeline with that guidance appended, so the confirmed SQL actually executes and
  the user gets their answer. No new resolution path is invented.

One extension to `resumeFromEscalation`: an options parameter
`{ skipTeachingCandidate?: boolean }`. A bare ✅ carries no teaching content —
`generateTeachingCandidate` fed "confirmed" would fabricate a lesson from nothing.
Reply-based resolutions keep generating candidates as today.

### Idempotency

Slack redelivers events and analysts can react twice (remove + re-add). No dedupe
machinery is needed: after the first resolution sets `pipelineState: 'resolved'`,
`getEscalationByEscalationThread()` returns null and subsequent events are no-ops.

### Card copy fix

`buildEscalationBlocks` appends the ✅ line unconditionally, but the affordance is only
meaningful when `bestGuessSql` is present. Make the closing line conditional:

- with best guess: current copy (unchanged);
- without: `"Reply in this thread with guidance."`

### Slack app requirements (README "OAuth Scopes" + "Event Subscriptions" updates)

- New bot scope: `reactions:read`.
- New event subscription: `reaction_added`.
- App reinstall required after both — fold into the existing reinstall note.

Existing installs without the scope simply never receive the event; the handler's
absence-tolerance means no error path. The README smoke tests gain one step: react ✅ on
a test escalation card and confirm the original thread gets the resolution message.

---

## Slice 2: Time-Driven Escalation Lifecycle

`checkOverdueEscalations()` (`src/handlers/escalationLifecycle.ts`) fires only from the
message handler (`messageHandler.ts:74`), throttled to once per 60s. In a quiet
workspace a park_wait user waits on "I've asked the data team" indefinitely past the
configured timeout. Add a wall-clock trigger; keep the event-traffic piggyback (it gives
sub-minute responsiveness in active workspaces for free).

### Endpoint

`POST /api/lifecycle-sweep`, registered in a new `src/handlers/lifecycleSweep.ts`
following `registerDbtRunIngestion`'s pattern: registration is conditional on a new
optional env var `LIFECYCLE_SWEEP_SECRET`, and auth is the same timing-safe Bearer
comparison (`timingSafeEqual` on the full `Bearer <secret>` string,
`dbtRunIngestion.ts:14-21` is the pattern to copy verbatim). One placement difference:
unlike the dbt webhook (registered before the Bolt `App` exists), this registration must
come *after* `const app = new App(...)` in app.ts because the handler needs `app.client`
— inject it as a getter.

The route name is deliberately generic (`lifecycle-sweep`, not `escalation-sweep`):
future time-driven housekeeping (e.g. teaching-candidate reminders) joins this sweep
rather than multiplying endpoints and scheduler jobs.

The handler calls `checkOverdueEscalations(client, config.escalation)` and returns its
result as JSON. The Bolt `app.client` is available in `app.ts` scope, same as the
doctor endpoint's probes.

### `checkOverdueEscalations` return value

Currently `Promise<void>`. Change to return counts so the endpoint (and logs) have
observability — `{ throttled: boolean, pending: number, reminded: number, timedOut: number }`.
The existing fire-and-forget call site ignores the value; backward compatible.

The 60s throttle stays shared between both triggers — it exists to bound Firestore
reads, and a scheduler tick landing within 60s of an event-driven check is exactly the
redundant work it should suppress. The endpoint reports `throttled: true` in that case;
the next scheduler tick covers it.

### Scheduler

Cloud Scheduler HTTP job, every 10 minutes, with the secret in the Authorization header.
Documented in the README Infrastructure Setup as step 7 (one `gcloud scheduler jobs
create http` command). Worst-case timeout-notification latency becomes ~10 minutes,
against a default timeout measured in hours — acceptable. Operators who skip this step
keep exactly today's behavior (event-traffic piggyback), which the README states
explicitly.

No new Firestore index: `getAllPendingEscalations()` uses a single-field equality
filter, which Firestore serves without a composite index.

---

## Slice 3: Production Telemetry Sink

`src/agents/modelGateway.ts` records per-node token and latency usage into an
`AsyncLocalStorage`-scoped sink — and `recordUsage()` returns silently when no sink is
set (`sinkStore.getStore(); if (!sink) return;`). Only `scripts/node-sweep.ts` ever sets
one. A live deployment discards every record: an operator is blind to token spend and
latency trends, and the fast-path graduation gate (governance, Tranche Horizon) cannot
be evaluated without this visibility.

### Default-sink fallback at the gateway seam

Add a module-level default to `modelGateway.ts`:

```typescript
let defaultSink: UsageSink | undefined;
export function setDefaultUsageSink(sink: UsageSink | undefined): void { ... }

// in recordUsage:
const sink = sinkStore.getStore() ?? defaultSink;
```

Precedence matters: the ALS-scoped sink wins when present, so `node-sweep.ts` and any
future per-request wrapping keep working unchanged and *replace* (not duplicate) the
default for their scope.

### Wiring — module boundaries preserved

`agents/` must not grow a dependency on the logger. The gateway only exposes the
setter; `app.ts` does the wiring at startup:

```typescript
setDefaultUsageSink((r) => rootLogger.info(r, 'model.usage'));
```

One structured log line per model call (≤ ~12 per query) carrying `nodeId`,
`promptTokens`, `candidatesTokens`, `thoughtsTokens`, `latencyMs`. Pino's existing
Cloud-Logging-compatible formatting (`src/logging.ts`) means these are immediately
queryable in Cloud Logging (`jsonPayload.nodeId`, log name filter `model.usage`) with
zero new infrastructure. Log volume is trivial.

### Known limitation (documented, not solved here)

The default sink has no `traceId` — `recordUsage` fires inside agent code that doesn't
know the request. Correlating usage to a specific query would require the pipeline to
wrap its run in `withUsageSink()` with an enriched sink; that is a clean future
extension at the same seam, deferred until the fast-path graduation analysis actually
needs per-query correlation (per-node aggregates may suffice). Recorded as a note, not
built speculatively.

---

## Slice 4: Firestore TTL Manifest + response_context Retention

Firestore TTL is enforced for exactly one collection (`slack_event_dedupe`, README
"Firestore TTL Policy"). Every other collection that writes `expiresAt` only checks it
on read, so expired documents accumulate forever — and `response_context`, the largest
documents at one per query, has no expiry at all.

### The semantic trap this slice must not fall into

`expiresAt` means two different things in this codebase:

- **Cache/junk lifetime** — the document is worthless after expiry
  (`slack_event_dedupe`, `processing_threads` locks, `information_schema_cache`,
  `dbt_run_history`, `clarification_state`): TTL on `expiresAt` is correct.
- **Logical state-machine timeout** — `escalation_state.expiresAt` is *when the
  escalation times out*, not when the record stops mattering. A TTL on it would delete
  resolved escalations ~72h after their original timeout instant, destroying the audit
  trail (and, absent slice 2, could even delete an `awaiting_human` doc before anyone
  notified the user). `escalation_state` gets a separate retention field instead.

### Per-collection retention decisions

| Collection | TTL field | Written by | Decision |
|---|---|---|---|
| `slack_event_dedupe` | `expiresAt` | existing | Already enforced; folds into manifest |
| `processing_threads` | `expiresAt` | existing (300s lock) | TTL on `expiresAt` — stale-lock cleanup |
| `clarification_state` | `expiresAt` | existing (1h) | TTL on `expiresAt` — expired clarifications are worthless |
| `information_schema_cache` | `expiresAt` | existing (24h) | TTL on `expiresAt` |
| `dbt_run_history` | `expiresAt` | existing (90d) | TTL on `expiresAt` — 90d was always the intent |
| `escalation_state` | `retainUntil` (**new**) | `saveEscalationState`: `createdAt` + 90d | Preserves resolved/timed-out audit trail; `expiresAt` keeps its timeout semantics untouched |
| `response_context` | `expiresAt` (**new**) | `saveResponseContext`: now + `RESPONSE_CONTEXT_RETENTION_DAYS` | New env var, default **90** (aligned with `dbt_run_history` and ≥ any feedback aggregation window) |
| `rate_limits` | — | — | Out of scope: one self-overwriting doc per user, bounded by user count |
| `teaching_candidates`, `feedback_notes` | — | — | Out of scope: human-drained review queues (Non-Goals) |
| `config` | — | — | Singleton, permanent |

`response_context` deletion degrades gracefully by construction: follow-up routing on a
thread whose context is gone already falls back to `new_query`, and the reasoning toggle
already handles a missing context (`if (!ctx) return`). The check-on-read expiry logic
elsewhere stays — Firestore TTL deletion is best-effort within ~72h of expiry, so reads
must keep their own guard (defense in depth, and exactly what exists today).

### Manifest

New `infra/firestore.ttls.json`, mirroring how `firestore.indexes.json` works for
indexes — the manifest is the reviewable source of truth; application is manual:

```json
{
  "ttls": [
    { "collectionGroup": "slack_event_dedupe", "field": "expiresAt" },
    { "collectionGroup": "processing_threads", "field": "expiresAt" },
    ...
  ]
}
```

README "Firestore TTL Policy" section is rewritten to iterate the manifest (a one-liner
generating `gcloud firestore fields ttls update <field> --collection-group=<group>
--enable-ttl` commands, same style as the indexes one-liner), replacing the current
single hardcoded command.

### Backfill (documented operator option, not automatic)

TTL only deletes documents *that have the field*. Existing `response_context` and
`escalation_state` docs predating this slice never get expired by the policy. Provide
`scripts/backfill-retention-fields.ts` (batched update stamping `expiresAt` /
`retainUntil` from each doc's `createdAt`) and document it as an optional one-time step;
a fresh install never needs it.

### Adjacent fix folded in

`getResponseContextsSince(windowDays)` (`src/state/responseContext.ts`) performs an
unbounded full-window scan. Retention bounds the collection size, which mostly defuses
it, but per the no-silent-caps principle: add an explicit `limit` (default 5000) and a
logged warning when the limit is hit, so the feedback aggregation CLI states its own
truncation instead of silently scanning or silently capping.

---

## New Configuration

| Variable | Required | Default | Slice |
|---|---|---|---|
| `LIFECYCLE_SWEEP_SECRET` | optional — endpoint registered only when set | — | 2 |
| `RESPONSE_CONTEXT_RETENTION_DAYS` | optional | `90` | 4 |

Both go in `.env.example` with comments; `LIFECYCLE_SWEEP_SECRET` follows the
`DBT_WEBHOOK_SECRET` precedent exactly (optional feature flag by presence).

## Acceptance Criteria (mapped to governance, Active Tranche B)

1. **"The ✅ promise is either honored or gone"** → honored: reacting ✅ on a
   best_effort_verify card posts the confirmation to the original thread and resolves
   the escalation; on a park_wait card with proposed SQL it re-runs the pipeline with
   the confirmation as guidance; cards without a best guess no longer show the ✅ copy.
2. **"An escalation in a zero-traffic workspace times out and notifies the user"** →
   with the scheduler configured, a park_wait escalation past `expiresAt` is marked
   `timed_out` and the original thread is notified within one sweep interval, with no
   Slack events arriving.
3. **"Usage records visible in logs from a deployed instance"** → every
   `generateForNode` call in a default deployment emits one `model.usage` structured
   log line with node id, token counts, and latency.
4. **"TTL manifest exists and the apply path is documented"** → `infra/firestore.ttls.json`
   covers every retained collection per the table above; README documents the apply
   one-liner; `response_context` documents carry an expiry honoring
   `RESPONSE_CONTEXT_RETENTION_DAYS`.

When all four land, update `docs/trajectory-governance.md` (Tranche B section + Evidence
Log entry) in the same change set, and delete IMPLEMENTATION.md §8's corresponding
"known template gaps" bullets.

## Testing

- **Slice 1**: unit tests on the new handler module (reaction filtering, missing-SQL
  reply, synthetic-guidance construction, `skipTeachingCandidate` propagation,
  resolved-state no-op idempotency); existing `escalationResponse` tests extended for
  the options parameter. Firestore/Slack mocked per repo conventions (class-syntax
  mocks, error code 6 for contention).
- **Slice 2**: endpoint tests mirroring `dbtRunIngestion`'s (401 on bad/missing Bearer,
  timing-safe path, JSON counts response, throttled response); `escalationLifecycle`
  tests updated for the new return type using the existing `_resetThrottle()` hook.
- **Slice 3**: gateway tests for precedence (ALS sink wins over default; default fires
  when ALS empty; neither set → no-op) and that `node-sweep`'s `withUsageSink` behavior
  is unchanged.
- **Slice 4**: state-module tests asserting the new fields are written with correct
  offsets (and never written as `undefined` — Firestore rejects it); manifest validated
  by a parity test asserting `firestore.ttls.json` matches the exact expected
  collection/field set from the decision table above, so adding a collection without a
  retention decision fails loudly (same spirit as the model/thinking-level parity test).
- Mocked tests cannot catch missing TTL policies or scheduler misconfiguration in the
  live project — the README steps are the enforcement, as with composite indexes today.

## Template-Boundary Note

Everything in this tranche is generic infrastructure: no dbt artifacts, project IDs,
store IDs, ReferenceCards, or benchmark evidence are involved. All four slices land in
the template repo directly.
