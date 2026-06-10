# Small Follow-Ups: Operational Trust Tranche — Design

Three small fixes spun out of the Operational Trust tranche reviews
(2026-06-09). Each is independently shippable; none changes external behavior
except where noted. Ordered easiest-first.

---

## 1. `getResponseContextsSince` truncation keeps the oldest docs

**Registered in:** `docs/trajectory-governance.md` Code Debt Register
("Truncated window scans keep the oldest docs").

### Problem

`getResponseContextsSince` (`src/state/responseContext.ts`) runs
`.where('createdAt', '>=', since).limit(limit)` with no `orderBy`. Firestore
implicitly orders by the inequality field **ascending**, so when the window
holds more than `limit` (5000) docs, the scan keeps the *oldest* docs and
drops the freshest — exactly backwards for a trailing-window feedback sensor,
whose most recent responses are the most diagnostic.

### Design

Add an explicit descending order:

```typescript
.where('createdAt', '>=', since)
.orderBy('createdAt', 'desc')
.limit(limit)
```

- **No composite index needed.** The `orderBy` field is the same field as the
  `where` inequality, so Firestore's automatic single-field index covers it.
  (The manual-index rule in CLAUDE.md applies to `orderBy` on a *different*
  field.)
- **No consumer depends on ordering.** `scripts/feedback-report.ts` is the
  only caller and aggregates over the array; the docblock already says
  "Unordered". Update the docblock: results are now newest-first, and
  truncation drops the *oldest* docs.
- Keep the existing `console.warn` truncation warning unchanged.

### Tests

Extend the existing `responseContext` test for the limit path: assert
`orderBy` was called with `('createdAt', 'desc')` in the chain. Pure mock
assertion; no behavior fixture changes.

**Effort:** ~3 lines + 1 test assertion. Closes the Code Debt Register row
(remove it in the same commit).

---

## 2. `slackIntakeAgent` logging-boundary violation

### Problem

`src/agents/slackIntakeAgent.ts:5` imports `rootLogger` from `../logging.js`.
The module convention (established when `modelGateway` got
`setDefaultUsageSink`) is that `agents/` stays free of logging imports —
wiring to a concrete logger happens in `app.ts`. `slackIntakeAgent` is the
lone remaining violator.

### Design

Mirror the proven `setDefaultUsageSink` injection seam, local to the intake
agent (only one agent logs today; generalize only when a second one needs it):

```typescript
// slackIntakeAgent.ts
export interface IntakeFallbackEvent {
  reason: IntakeFallbackReason;
  channel?: string;
  threadTs?: string;
  elapsedMs?: number;
  textLength?: number;
}
type IntakeFallbackSink = (e: IntakeFallbackEvent) => void;

let fallbackSink: IntakeFallbackSink = (e) =>
  console.warn(`intake.fallback ${JSON.stringify(e)}`);

/** Process-wide sink for fail-open fallback telemetry. Wiring to a concrete
 *  logger happens in app.ts — agents/ stays free of logging imports. */
export function setIntakeFallbackSink(sink: IntakeFallbackSink | undefined): void {
  fallbackSink = sink ?? ((e) => console.warn(`intake.fallback ${JSON.stringify(e)}`));
}
```

`logIntakeFallback` calls `fallbackSink(...)` wrapped in try/catch (same
never-throw rationale as `recordUsage` in `modelGateway.ts` — telemetry must
never break the fail-open contract).

In `src/app.ts`, next to the existing usage-sink wiring (line ~45):

```typescript
setIntakeFallbackSink((e) => rootLogger.warn(e, 'intake.fallback'));
```

**Default is `console.warn`, not no-op** — matches the `state/` leaf-module
precedent and means unwired contexts (tests, scripts, future CLIs) still
surface fallbacks instead of silently losing them. The structured-reason-code
semantics (timeout vs model_error vs sanitize_*) are unchanged.

### Tests

- Existing intake tests that assert on logging swap their `rootLogger` mock
  for an injected sink (`setIntakeFallbackSink(mockFn)` in `beforeEach`,
  reset in `afterEach`).
- New test: a throwing sink does not break the fail-open return.
- Optional cheap guard: a boundary test that greps `src/agents/*.ts` for
  `from '../logging` (parity-test style, like `tests/infra/firestoreTtls.test.ts`).

**Effort:** ~30 lines + test updates. No behavior change in production (app.ts
wires the same `rootLogger.warn` call that exists today).

---

## 3. Lazy escalation timeout silently swallows late analyst replies

### Problem

`queryPendingEscalation` (`src/state/escalationState.ts:41`) lazily expires:
when a lookup finds `expiresAt < now`, it flips `pipelineState` to
`'timed_out'` and returns `null`. Two consequences:

1. **The analyst's late reply vanishes.** `checkEscalationResponse` returns
   null, `messageHandler` falls through, and nobody tells the analyst their
   guidance arrived too late or was dropped. The original user thread hears
   nothing either.
2. **The sweep's timeout notification is also skipped.** `checkOverdueEscalations`
   only sees `pipelineState == 'awaiting_human'` docs. A lazily-flipped doc is
   invisible to the sweep, so the "the data team didn't respond in time"
   notice the sweep would have posted to the user thread never fires. The lazy
   path doesn't just miss a courtesy message — it *suppresses* the designed
   timeout notification.

### Considered: drop the lazy flip entirely

Now that Cloud Scheduler drives `/api/lifecycle-sweep` every 10 minutes, the
sweep could own timeouts exclusively; a reply landing in the ≤10-minute lag
window would simply resume normally (a grace window, arguably good).
**Rejected:** if the scheduler job is ever paused/misconfigured, escalations
would accept replies indefinitely with no timeout backstop, and check-on-read
is this codebase's stated correctness layer ("TTL is cleanup, not
correctness" applies equally here). Keep the lazy check; fix its silence.

### Design

**State layer signals; handler layer notifies** (`state/` is a leaf — no
Slack calls there).

1. Change the lookup return type to a discriminated result and update all
   call sites outright (template repo, no compat shims):

```typescript
export type EscalationLookup =
  | { status: 'pending'; state: EscalationState }
  | { status: 'expired_now'; state: EscalationState }  // this call performed the flip
  | null;                                              // none, or already resolved/timed out
```

`queryPendingEscalation` still performs the atomic flip to `'timed_out'` but
returns `{ status: 'expired_now', state }` instead of null — only on the call
that actually performed the flip (the update is the once-only signal; a
second lookup finds no `awaiting_human` doc and returns null, preserving
idempotency).

2. Extract the sweep's timeout-notification routine (the "data team didn't
   respond in time" post to the original thread) from
   `checkOverdueEscalations` into a shared helper, e.g.
   `notifyEscalationTimeout(state, client)` in `src/slack/` or
   `src/handlers/lifecycle.ts` — single source for timeout copy.

3. Call-site behavior on `expired_now`:

| Call site | Behavior |
|---|---|
| `messageHandler` escalation-reply path | Post to the **escalation thread**: "This escalation timed out before your reply, so it wasn't applied. The requester was notified." Then run `notifyEscalationTimeout` for the original thread. Mark event visible. |
| `escalationReaction` (✅ handler) | Same: reply in the escalation thread that the confirmation arrived after timeout; notify original thread. |
| `preflightChecks` | Treat as no pending escalation (user may proceed with a new question) and run `notifyEscalationTimeout` first so the user learns the old escalation died. |
| `hasPendingEscalation` (feedbackEscalation) | Map `expired_now` → `false`, no notification (the message-handler path owns user-facing notice; this is just a dedupe guard). |

4. `getAllPendingEscalations` (sweep path) is untouched — the sweep already
   owns notification for docs it times out itself.

### Tests

- State: lookup past `expiresAt` returns `expired_now` + flips doc; second
  lookup returns null.
- Handler: late analyst reply posts both messages (escalation thread + original
  thread) and does not run the pipeline; ✅ reaction after expiry does the
  same and skips SQL confirmation.
- Preflight: `expired_now` lets the new question proceed and fires the notice.

**Effort:** the largest of the three — state-layer return-type change (4 call
sites), one extracted helper, ~6 new tests. Still well under a tranche; fits
a single PR.

---

## Sequencing

1 → 2 → 3 (independent, but 3 touches the most files; land the trivial ones
first). None of these are evaluation scaffolding; all three are maintenance
of the just-shipped Operational Trust surface, consistent with the
freeze rules in `docs/trajectory-governance.md`.
