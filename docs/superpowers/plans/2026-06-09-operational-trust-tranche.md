# Operational Trust Tranche Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Governance checkpoint:** This plan implements Active Tranche B of `docs/trajectory-governance.md` (sanctioned maintenance, runs in parallel with the Tranche A acceptance run). All four slices are template-safe.

**Goal:** Close the four operational-trust gaps from the 2026-06-09 audit: honor the escalation card's ✅ promise, make escalation timeouts wall-clock-driven, surface per-node telemetry in production logs, and declare Firestore retention for every collection.

**Architecture:** Four independent slices, landed in "promises before plumbing" order. Slice 1 extends the existing escalation resolution path with a `reaction_added` entry point. Slice 2 clones the `dbtRunIngestion` Bearer-secret endpoint pattern for a scheduler-driven lifecycle sweep. Slice 3 adds a module-level default-sink fallback at the `modelGateway` AsyncLocalStorage seam. Slice 4 adds retention fields plus an `infra/` TTL manifest mirroring how `firestore.indexes.json` works.

**Tech Stack:** TypeScript, Bolt.js (`reaction_added` event), Express router, Firestore TTL policies, pino structured logging, Vitest.

**Spec:** `docs/superpowers/specs/2026-06-09-operational-trust-tranche-design.md`

**Branch:** create a fresh branch off `main` (the prior worktree branch is fully merged).

---

## File Structure

- Modify `src/slack/escalationBlocks.ts`: ✅ copy conditional on `bestGuessSql`.
- Modify `src/handlers/escalationResponse.ts`: `skipTeachingCandidate` option.
- Create `src/handlers/escalationReaction.ts`: reaction_added orchestration.
- Modify `src/handlers/escalationLifecycle.ts`: return sweep counts.
- Create `src/handlers/lifecycleSweep.ts`: `POST /api/lifecycle-sweep`.
- Modify `src/agents/modelGateway.ts`: `setDefaultUsageSink()`.
- Modify `src/state/responseContext.ts`: `expiresAt` on save; bounded `getResponseContextsSince`.
- Modify `src/state/escalationState.ts`: `retainUntil` on save.
- Modify `src/config.ts`: `LIFECYCLE_SWEEP_SECRET`.
- Modify `src/app.ts`: wire reaction handler, sweep endpoint, default sink.
- Create `infra/firestore.ttls.json`: TTL manifest.
- Create `scripts/backfill-retention-fields.ts`: optional one-time backfill.
- Create `tests/handlers/escalationReaction.test.ts`, `tests/handlers/lifecycleSweep.test.ts`, `tests/infra/firestoreTtls.test.ts`.
- Modify `tests/slack/escalationBlocks.test.ts`, `tests/handlers/escalationResponse.test.ts`, `tests/handlers/escalationLifecycle.test.ts`, `tests/agents/modelGateway.test.ts`, `tests/state/responseContext.test.ts`, `tests/state/escalationState.test.ts`.
- Modify `.env.example`, `README.md`, `IMPLEMENTATION.md`, `docs/trajectory-governance.md` (final task).

---

## Slice 1: Escalation ✅ Reaction Handler

### Task 1: Make the ✅ card copy conditional on a best guess

**Files:**
- Modify: `tests/slack/escalationBlocks.test.ts`
- Modify: `src/slack/escalationBlocks.ts:56-62`

- [ ] **Step 1: Write the failing tests**

In `tests/slack/escalationBlocks.test.ts`, add two cases for `buildEscalationBlocks`:

```typescript
it('shows the ✅ quick-path only when a best guess exists', () => {
  const blocks = buildEscalationBlocks({ ...baseParams, bestGuessSql: 'SELECT 1' });
  const text = JSON.stringify(blocks);
  expect(text).toContain('React with ✅');
});

it('asks for a reply when there is no best guess', () => {
  const blocks = buildEscalationBlocks({ ...baseParams, bestGuessSql: undefined });
  const text = JSON.stringify(blocks);
  expect(text).not.toContain('React with ✅');
  expect(text).toContain('Reply in this thread with guidance.');
});
```

- [ ] **Step 2: Implement**

In `buildEscalationBlocks`, move the closing section inside/after the `bestGuessSql` branch:

- with `bestGuessSql`: keep `'React with ✅ if my guess is correct, or reply with guidance.'`
- without: `'Reply in this thread with guidance.'`

- [ ] **Step 3: Verify** — `npx vitest run tests/slack/escalationBlocks.test.ts`

### Task 2: Add `skipTeachingCandidate` to `resumeFromEscalation`

**Files:**
- Modify: `tests/handlers/escalationResponse.test.ts`
- Modify: `src/handlers/escalationResponse.ts:54-99`

- [ ] **Step 1: Write the failing test**

Add a case asserting that `resumeFromEscalation(ctx, client, tables, config, { skipTeachingCandidate: true })` resolves the escalation but never calls `generateTeachingCandidate` (already mocked in this file). Add a companion assertion to an existing case that the default (no options) still generates a candidate.

- [ ] **Step 2: Implement**

```typescript
export async function resumeFromEscalation(
  ctx: EscalationResumeContext,
  client: WebClient,
  tables: TableContext[],
  config: PipelineConfig,
  options?: { skipTeachingCandidate?: boolean },
): Promise<void> {
```

Wrap the fire-and-forget teaching block in `if (!options?.skipTeachingCandidate) { ... }`. No call-site changes needed (new trailing optional param).

- [ ] **Step 3: Verify** — `npx vitest run tests/handlers/escalationResponse.test.ts`

### Task 3: Create the reaction handler module

**Files:**
- Create: `tests/handlers/escalationReaction.test.ts`
- Create: `src/handlers/escalationReaction.ts`

- [ ] **Step 1: Write the failing tests**

Mock `../../src/state/escalationState.js` (`getEscalationByEscalationThread`) and `../../src/handlers/escalationResponse.js` (`resumeFromEscalation`). Slack client is a plain object of `vi.fn()`s. Cases:

1. Non-✅ reaction (`reaction: 'thumbsup'`) → no Firestore lookup.
2. `item.type !== 'message'` → ignored.
3. Channel mode with `item.channel !== escalation.channelId` → no lookup (cheap pre-filter).
4. No pending escalation for `item.ts` → no-op (idempotency: second ✅ after resolution lands here).
5. Pending escalation whose `context.previousSql` is absent → posts the "no proposed SQL on this one" threaded reply to the escalation thread; does NOT resolve.
6. Pending `best_effort_verify` escalation with SQL → calls `resumeFromEscalation` with `humanGuidance: 'Confirmed correct via ✅ reaction.'` and `{ skipTeachingCandidate: true }`.
7. Pending `park_wait` escalation with SQL → guidance `'The data team confirmed the proposed SQL is correct.'`, same options.

- [ ] **Step 2: Implement**

```typescript
const CONFIRM_REACTION = 'white_check_mark'; // ✅ U+2705

export function registerEscalationReaction(
  app: App,
  getConfig: () => AppConfig,
  getTables: () => TableContext[],
) {
  app.event('reaction_added', async ({ event, client }) => {
    await handleEscalationReaction({ event, client, config: getConfig(), getTables });
  });
}

export async function handleEscalationReaction({ event, client, config, getTables }: ...) {
  if (event.reaction !== CONFIRM_REACTION) return;
  if (event.item.type !== 'message') return;
  // Cheap pre-filter in channel mode; dm mode relies on the precise ts lookup
  // (reaction volume is low) plus the post-lookup channel sanity check.
  if (config.escalation.mode === 'channel'
      && config.escalation.channelId
      && event.item.channel !== config.escalation.channelId) return;

  const state = await getEscalationByEscalationThread(event.item.ts);
  if (!state) return; // not an escalation card, or already resolved/timed out
  if (state.escalationChannel !== event.item.channel) return;

  if (!state.context.previousSql) {
    await client.chat.postMessage({
      channel: state.escalationChannel,
      thread_ts: state.escalationTs,
      text: "There's no proposed SQL on this one — please reply with guidance instead.",
    });
    return;
  }

  const humanGuidance = state.behavior === 'park_wait'
    ? 'The data team confirmed the proposed SQL is correct.'
    : 'Confirmed correct via ✅ reaction.';

  await resumeFromEscalation(
    { escalationId: state.escalationId, originalChannel: state.originalChannel,
      originalThreadTs: state.originalThreadTs, statusMsgTs: state.statusMsgTs,
      humanGuidance, behavior: state.behavior, context: state.context, traceId: state.traceId },
    client, getTables(), toPipelineConfig(config),
    { skipTeachingCandidate: true },
  );
}
```

Shape mirrors `registerMessageHandler` (`src/handlers/messageHandler.ts:35-43`): registration wrapper + exported testable handler. Imports: `toPipelineConfig` from `../pipeline.js`, types from `../config.js` / `../dbt/types.js`.

- [ ] **Step 3: Verify** — `npx vitest run tests/handlers/escalationReaction.test.ts && npm run typecheck`

### Task 4: Wire into app.ts and document the Slack requirements

**Files:**
- Modify: `src/app.ts` (after `registerMessageHandler`, ~line 154)
- Modify: `README.md` (OAuth Scopes, Event Subscriptions, Slack Smoke Tests)

- [ ] **Step 1:** Add `registerEscalationReaction(app, getConfig, getTables);` beside the other handler registrations.
- [ ] **Step 2:** README updates: add `reactions:read` to the scopes block (with a sentence: required for the escalation card's ✅ quick-path; harmless to omit — the bot simply never receives the event); add `reaction_added` to the event subscriptions list; append a smoke-test step: react ✅ on a test escalation card and confirm the original thread receives the resolution.
- [ ] **Step 3: Verify** — `npm run typecheck && npm test` (app.ts is coverage-excluded; full suite guards regressions).

---

## Slice 2: Time-Driven Escalation Lifecycle

### Task 5: Return sweep counts from `checkOverdueEscalations`

**Files:**
- Modify: `tests/handlers/escalationLifecycle.test.ts`
- Modify: `src/handlers/escalationLifecycle.ts:33-82`

- [ ] **Step 1: Write the failing tests**

Using the existing `_resetThrottle()` hook, assert the new return shape:

```typescript
export interface LifecycleSweepResult {
  throttled: boolean;
  pending: number;   // awaiting_human escalations examined
  reminded: number;
  timedOut: number;
}
```

Cases: throttled call → `{ throttled: true, pending: 0, reminded: 0, timedOut: 0 }`; one expired + one reminder-due → `{ throttled: false, pending: 2, reminded: 1, timedOut: 1 }`. Existing behavioral assertions stay.

- [ ] **Step 2: Implement** — accumulate counters in the existing loop; early-returns produce the zeroed shapes. The fire-and-forget call site (`messageHandler.ts:74`) ignores the value; no change there.

- [ ] **Step 3: Verify** — `npx vitest run tests/handlers/escalationLifecycle.test.ts && npm run typecheck`

### Task 6: Create the sweep endpoint

**Files:**
- Create: `tests/handlers/lifecycleSweep.test.ts`
- Create: `src/handlers/lifecycleSweep.ts`

- [ ] **Step 1: Write the failing tests**

Mirror `tests/handlers/dbtRunIngestion.test.ts`'s harness (raw Express router with a captured route handler, or supertest — match whatever that file does). Mock `./escalationLifecycle.js`. Cases:

1. Missing `Authorization` → 401, sweep not called.
2. Wrong secret (same length and different length — exercises the length pre-check) → 401.
3. Correct `Bearer <secret>` → 200 with the JSON `LifecycleSweepResult`; sweep called with the injected client + escalation config.
4. Sweep throws → 500 `{ error: 'Sweep failed' }`, no internals leaked.

- [ ] **Step 2: Implement**

```typescript
export function registerLifecycleSweep(
  router: Router,
  sweepSecret: string,
  deps: { getClient: () => WebClient; getEscalationConfig: () => EscalationConfig },
): void {
  router.post('/api/lifecycle-sweep', async (req, res) => {
    // timing-safe Bearer check — copy dbtRunIngestion.ts:14-21 verbatim
    ...
    try {
      const result = await checkOverdueEscalations(deps.getClient(), deps.getEscalationConfig());
      res.status(200).json(result);
    } catch (err) {
      console.error('Lifecycle sweep failed:', (err as Error).message);
      res.status(500).json({ error: 'Sweep failed' });
    }
  });
}
```

Deps are getter-injected because `app.client` doesn't exist until the Bolt `App` is constructed — registration in app.ts must come after `const app = new App(...)` (unlike the dbt webhook, which registers earlier).

- [ ] **Step 3: Verify** — `npx vitest run tests/handlers/lifecycleSweep.test.ts`

### Task 7: Config, wiring, and scheduler docs

**Files:**
- Modify: `src/config.ts` (AppConfig + loadConfig)
- Modify: `src/app.ts` (after App construction, ~line 91)
- Modify: `.env.example`, `README.md`

- [ ] **Step 1:** Add `lifecycleSweepSecret?: string` to `AppConfig` (top level, beside `port`) parsed as `process.env.LIFECYCLE_SWEEP_SECRET || undefined`. Extend `tests/config.test.ts` (exists) with coverage matching how `DBT_WEBHOOK_SECRET` is tested.
- [ ] **Step 2:** In app.ts, after `const app = new App(...)`:

```typescript
if (config.lifecycleSweepSecret) {
  registerLifecycleSweep(receiver.router, config.lifecycleSweepSecret, {
    getClient: () => app.client,
    getEscalationConfig: () => config.escalation,
  });
}
```

- [ ] **Step 3:** `.env.example`: `LIFECYCLE_SWEEP_SECRET` beside `DBT_WEBHOOK_SECRET`, commented, noting it enables `POST /api/lifecycle-sweep`. README: add a row to the Configuration env-var table (the `DBT_WEBHOOK_SECRET` row at ~line 428 is the pattern — README has no REST endpoints table; that table lives in `CLAUDE.md` and is updated in Task 16), and add Infrastructure Setup step 7 — a `gcloud scheduler jobs create http` command hitting the endpoint every 10 minutes with `--headers="Authorization=Bearer ${LIFECYCLE_SWEEP_SECRET}"`, plus the explicit statement that skipping this step keeps today's event-traffic-only behavior, and that worst-case timeout-notification latency equals the sweep interval.
- [ ] **Step 4: Verify** — `npm run typecheck && npm test`

---

## Slice 3: Production Telemetry Sink

### Task 8: Default-sink fallback in modelGateway

**Files:**
- Modify: `tests/agents/modelGateway.test.ts`
- Modify: `src/agents/modelGateway.ts:14-35`

- [ ] **Step 1: Write the failing tests**

1. With `setDefaultUsageSink(spy)` and no ALS sink, `generateForNode` records to the spy.
2. Inside `withUsageSink(alsSpy, ...)` with a default also set: only `alsSpy` fires (precedence — node-sweep must replace, not duplicate).
3. `setDefaultUsageSink(undefined)` clears it; neither set → no throw, no record.

Use `afterEach(() => setDefaultUsageSink(undefined))` to keep tests isolated.

- [ ] **Step 2: Implement**

```typescript
let defaultSink: UsageSink | undefined;

/** Process-wide fallback sink, used when no AsyncLocalStorage-scoped sink is
 *  active. ALS sinks (withUsageSink) take precedence and fully replace it for
 *  their scope. Wiring to a concrete logger happens in app.ts — agents/ stays
 *  free of logging imports. */
export function setDefaultUsageSink(sink: UsageSink | undefined): void {
  defaultSink = sink;
}
```

In `recordUsage`: `const sink = sinkStore.getStore() ?? defaultSink;`

- [ ] **Step 3: Verify** — `npx vitest run tests/agents/modelGateway.test.ts`

### Task 9: Wire the sink at startup

**Files:**
- Modify: `src/app.ts` (beside the other init calls, ~line 37)

- [ ] **Step 1:** `setDefaultUsageSink((r) => rootLogger.info(r, 'model.usage'));` — one structured line per model call (`nodeId`, `promptTokens`, `candidatesTokens`, `thoughtsTokens`, `latencyMs`), queryable in Cloud Logging via `jsonPayload.nodeId` / message `model.usage`.
- [ ] **Step 2: Verify** — `npm run typecheck && npm test`. Manual deploy verification (logs visible) belongs to the operator checklist, not CI.

---

## Slice 4: Firestore TTL Manifest + Retention

### Task 10: `response_context` expiry

**Files:**
- Modify: `tests/state/responseContext.test.ts`
- Modify: `src/state/responseContext.ts:4-9`

- [ ] **Step 1: Write the failing tests**

`saveResponseContext` writes `expiresAt ≈ createdAt + 90d` by default; with `RESPONSE_CONTEXT_RETENTION_DAYS=30` stubbed (`vi.stubEnv` + module re-import or an exported `_retentionDays()` helper — match how the file's tests are structured), the offset honors it. Assert the field is a `Date`, never `undefined` (Firestore rejects undefined).

- [ ] **Step 2: Implement**

Module-level parse (state/ is a leaf module — config is not threaded into save calls; this matches `dbtRunHistory.ts`'s `TTL_DAYS` precedent, with an env override per the design):

```typescript
const RETENTION_DAYS = (() => {
  const v = Number(process.env.RESPONSE_CONTEXT_RETENTION_DAYS);
  return Number.isFinite(v) && v > 0 ? v : 90;
})();
```

In `saveResponseContext`: `.set({ ...ctx, createdAt: now, expiresAt: new Date(now.getTime() + RETENTION_DAYS * 86_400_000) })`.

- [ ] **Step 3: Verify** — `npx vitest run tests/state/responseContext.test.ts`

### Task 11: `escalation_state` retainUntil

**Files:**
- Modify: `tests/state/escalationState.test.ts`
- Modify: `src/state/escalationState.ts:6-18`

- [ ] **Step 1: Write the failing test** — `saveEscalationState` writes `retainUntil = createdAt + 90d` alongside the existing fields; `expiresAt` (the logical timeout) is unchanged.
- [ ] **Step 2: Implement** — `const RETAIN_DAYS = 90;` constant (no env var per design), `retainUntil: new Date(now.getTime() + RETAIN_DAYS * 86_400_000)` in the `.set()`. Comment why: *`expiresAt` here is the escalation timeout, not a retention deadline — the TTL policy targets `retainUntil` so resolved/timed-out audit history survives.* No `EscalationState` type change: the field is write-only (only the TTL policy reads it), and `toEscalationState()`'s spread passes it through harmlessly — adding it to the type would force touching the `Omit<...>` in `saveEscalationState`'s signature for no consumer.
- [ ] **Step 3: Verify** — `npx vitest run tests/state/escalationState.test.ts`

### Task 12: Bound `getResponseContextsSince`

**Files:**
- Modify: `tests/state/responseContext.test.ts` (or `responseContext.feedback.test.ts` — whichever covers this function)
- Modify: `src/state/responseContext.ts:68`

- [ ] **Step 1: Write the failing test** — query receives `.limit(5000)` by default / a passed override; when the result length equals the limit, a truncation warning is logged (spy on `rootLogger.warn` or `console.warn` — match the module's existing error-output convention; it currently has none, so use `console.warn` to avoid adding a logging import to a leaf module).
- [ ] **Step 2: Implement** — `getResponseContextsSince(windowDays: number, limit = 5000)`; warn `response_context window scan hit limit ${limit}; results truncated` when `snapshot.size === limit`. No-silent-caps principle: the CLI consumer states its own truncation.
- [ ] **Step 3: Verify** — `npx vitest run tests/state/responseContext.test.ts tests/state/responseContext.feedback.test.ts`

### Task 13: TTL manifest + parity test

**Files:**
- Create: `infra/firestore.ttls.json`
- Create: `tests/infra/firestoreTtls.test.ts`

- [ ] **Step 1: Write the failing test** — reads the manifest and asserts the exact expected set:

```typescript
const expected = [
  { collectionGroup: 'slack_event_dedupe', field: 'expiresAt' },
  { collectionGroup: 'processing_threads', field: 'expiresAt' },
  { collectionGroup: 'clarification_state', field: 'expiresAt' },
  { collectionGroup: 'information_schema_cache', field: 'expiresAt' },
  { collectionGroup: 'dbt_run_history', field: 'expiresAt' },
  { collectionGroup: 'escalation_state', field: 'retainUntil' },
  { collectionGroup: 'response_context', field: 'expiresAt' },
];
```

(Same spirit as the model/thinking-level parity test: the manifest drifts loudly, not silently. `rate_limits`, `teaching_candidates`, `feedback_notes`, `config` are intentionally absent — human-drained or bounded; the test file comment says so.)

- [ ] **Step 2: Create the manifest** — `{ "ttls": [ ...expected ] }`.
- [ ] **Step 3: Verify** — `npx vitest run tests/infra/firestoreTtls.test.ts`

### Task 14: Backfill script

**Files:**
- Create: `scripts/backfill-retention-fields.ts`

- [ ] **Step 1: Implement** (no unit test — operator tooling, same as other `scripts/`; guarded by dry-run default):

Paginated scan (`orderBy('__name__')` + `startAfter`, 300/page — Firestore cannot query for field *absence*, so filter locally), batch-update docs missing the field: `response_context` → `expiresAt` from `createdAt + RESPONSE_CONTEXT_RETENTION_DAYS`, `escalation_state` → `retainUntil` from `createdAt + 90d`. Flags: `--project <id>` (required), `--apply` (default is dry-run printing counts only). Reuses `initFirestore`/`getDb`.

- [ ] **Step 2: Verify** — `npm run typecheck`; dry-run smoke against a real project is operator-side.

### Task 15: Docs — README TTL section, .env.example, IMPLEMENTATION.md

**Files:**
- Modify: `README.md` ("Firestore TTL Policy", ~line 340)
- Modify: `.env.example`
- Modify: `IMPLEMENTATION.md` (§1 and §8)

- [ ] **Step 1:** Rewrite the README TTL section: the manifest is the source of truth; replace the single hardcoded command with a jq one-liner over `infra/firestore.ttls.json` generating `gcloud firestore fields ttls update <field> --collection-group=<group> --enable-ttl` commands (same style as the indexes one-liner). Note: TTL deletion is best-effort within ~72h, which is why check-on-read guards remain; note the optional backfill script for pre-existing documents.
- [ ] **Step 2:** `.env.example`: add `RESPONSE_CONTEXT_RETENTION_DAYS` (commented, default 90, with the one-line caveat that feedback aggregation windows must not exceed it).
- [ ] **Step 3:** IMPLEMENTATION.md: §1's TTL bullet drops the "known gap" caveat and points at the manifest. §8's four bullets are exactly the four Tranche B gaps, so the section empties — replace its body with a single line ("None currently — the template's Operational Trust tranche closed the previously listed gaps; check `docs/trajectory-governance.md` for any newer ones."), keeping the heading so fork checklists don't break.
- [ ] **Step 4: Verify** — `npm run typecheck && npm test`

---

## Task 16: Full verification + governance closeout

**Files:**
- Modify: `docs/trajectory-governance.md` (Active Tranche B section + Evidence Log)
- Modify: `CLAUDE.md` (REST Endpoints table + Firestore Collections note if stale)

- [ ] **Step 1:** `npm run typecheck && npm test` — full suite green (the husky pre-push hook runs it again; expect ~813+ tests).
- [ ] **Step 2:** Walk the four acceptance criteria in the design doc §Acceptance Criteria against the diff; each must be satisfiable by code now in-tree (criteria 2's scheduler and the live TTL policies are operator steps — verify the README documents them, which is the criterion's in-repo half).
- [ ] **Step 3:** Update `docs/trajectory-governance.md` in the same change set (per the maintenance protocol): mark Tranche B items closed, add a dated Evidence Log entry (2026-06-XX) recording what shipped and that the fast-path graduation gate's telemetry precondition now exists. Update `CLAUDE.md`'s REST Endpoints table with `POST /api/lifecycle-sweep`.
- [ ] **Step 4:** Commit per-slice or as reviewed; do not push without explicit approval.

## Verification Summary

| Slice | Automated | Operator-side (documented, not CI-checkable) |
|---|---|---|
| 1 ✅ handler | unit tests; full suite | add scope+event, reinstall, smoke-test a real reaction |
| 2 sweep | endpoint + lifecycle tests | create the Cloud Scheduler job |
| 3 sink | gateway precedence tests | confirm `model.usage` lines in Cloud Logging |
| 4 TTL | state-field + manifest parity tests | apply TTL policies; optional backfill |

Mocked tests cannot catch missing live TTL policies or scheduler misconfiguration — the README steps are the enforcement, exactly as with composite indexes today.
