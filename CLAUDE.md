# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Anna Lytics is a Slack bot that translates natural-language questions into BigQuery SQL using Gemini models selected per pipeline node (`src/agents/nodeProfiles.ts`), with dbt metadata as the semantic layer. It runs on Cloud Run, uses Firestore for state, and communicates via Bolt.js (HTTP mode with ExpressReceiver).

## Trajectory Governance

Before proposing or implementing Phase 3+ product work, read `docs/trajectory-governance.md`. That document is the governing roadmap checkpoint for current tranche selection, deferred features, and maintenance rules.

Current guidance: prioritize trust infrastructure over feature expansion. The `ReferenceCard v1` acceptance gate **passed**: after two `NEEDS_REVISION` runs (2026-06-11) and a confirming slice, the post-repair re-run recorded **`ACCEPTED`** 2026-06-12 with zero scorecard failures (sessions & traffic attribution pilot — see the governance Evidence Log). The one-additional-domain branch is taken: the next product tranche may add exactly one high-confusion ReferenceCard domain, but selection must come from aggregated production feedback signal (not analyst convenience) and the new domain needs its own benchmark slice before it ships — so it waits on feedback data, not engineering. Tranche B (operational trust maintenance — Firestore TTL/retention, production telemetry sink, time-driven escalation timeouts, the escalation ✅-reaction handler) was completed 2026-06-09. Model refresh via template validation set activates first in T3. Other net-new benchmark/calibration/sizing/sweep machinery still activates last, and fixes to existing instruments may proceed. The WhatsApp Cloud API channel is a gated prototype (default-off, allowlisted; interactive trust controls included since 2026-06-23) — **further WhatsApp tranches are capped until manual acceptance evidence is recorded in the governance doc** (defect fixes in the shipped surface exempt); any change touching a surface named in the governance doc's Deferred Work table must carry its governance update in the same change set. Do not commit client-specific dbt artifacts, project IDs, File Search store IDs, ReferenceCards, or benchmark evidence to this template unless the repository has intentionally become an implementation repo. Do not revive broad charts, BQML expansion, domain agents, or automatic correction harvesting as the active next tranche unless `docs/trajectory-governance.md` is updated first with the new rationale and evidence.

When adversarial audits, benchmark results, production incidents, or analyst review change the development trajectory, update `docs/trajectory-governance.md` in the same change set.

## Commands

```bash
npm run typecheck          # tsc --noEmit
npm test                   # vitest run (all tests)
npx vitest run tests/validation/staticAnalysis.test.ts  # single test file
npx vitest run --reporter=verbose  # verbose output
npm run build              # tsc → dist/
npm run dev                # tsx src/app.ts (requires .env)
npm run model:discover     # list and probe Gemini model changes
npm run tv:setup           # create template validation views and dbt artifacts
npm run tv:label           # quorum-label the initial set or a new set version
npm run sweep:template     # size all nodes against the frozen template set
```

## Architecture

### Pipeline Flow

Every query follows this path through `src/pipeline.ts`:

```
Slack Event → ack() → preflightChecks (lock + clarification + escalation) →
  0. Follow-Up Routing (thread replies: classifyFollowUp → meta_question/refinement/discrepancy skip to handler)
  1. Clarification (classifyQuestion → LOW suspends pipeline with follow-up questions)
  1a. dbt_status Route (route=dbt_status → bypass SQL gen, query dbt_run_history, Flash formats answer)
  1b. INFORMATION_SCHEMA Fallback (non-dbt tables → query I_S COLUMN_FIELD_PATHS → build minimal TableContext with ⚠️ warning)
  2. Thread Context (conversations.replies → last 4 msgs, 4K char limit; the request's own status message is left out via `excludeTs`)
  3. SQL Generation + Supervisor Loop (generateSql → supervisor review → retry)
  3b. Escalation Decision (if exhausted: park_wait or best_effort_verify → save state, post to escalation channel, return)
  4. Validation (L1 static → L2 AST → L3 BigQuery dry run → L4 cost gate, short-circuit on failure; the final SQL is always re-validated right before execution, even when the quality loop already validated it)
  5. Execution (BigQuery with timeout/row/byte limits)
  6. Format + Respond (chooseFormat → Block Kit → chat.update + feedback/reasoning/override buttons)
  7. Persist ResponseContext (including retrievedSchema with all considered tables) → Firestore
  8. Release thread lock (always, in finally)
```

### Module Dependency Rules

These boundaries are enforced by convention and must not be violated:

- **`agents/`** never imports from `slack/` or `state/`
- **`validation/`** never imports from `agents/`
- **`handlers/`** delegates all logic to `pipeline.ts` — no business logic
- **`state/`** is a leaf dependency (no imports from other domain modules)

### Dual `ts` Values Pattern

The pipeline receives two Slack timestamps that serve different purposes:
- **`threadTs`**: Thread identity. Used for state (locks, ResponseContext), thread context retrieval, reply threading. Slack timestamps are only unique within a conversation, so thread state is always keyed by `channel` + `threadTs` (`conversationThreadKey()` / `findOwnedDoc()` in `src/state/threadScope.ts`); never key or look up thread state by `threadTs` alone.
- **`statusMsgTs`**: The bot's status message. Used exclusively for `chat.update()` calls. Never conflated with thread identity. A clarification answer gets a new status message (`startClarificationResume()` in `handlers/messageHandler.ts`); the clarifying questions stay in the thread, redrawn without their Cancel button. It reuses the clarifying message only when the new one can't be posted or the saved state has no questions.

### Status Messages

Status text is written to the status message in place, and the answer later overwrites the same message. Pipeline and discrepancy status goes through `createStatusReporter()` (`src/slack/statusReporter.ts`):

- `set(text)` writes are sequential and never reject; a failed write is logged, not fatal.
- `withHeartbeat(work)` wraps a long step (the fast path, the quality loop, query execution). It rewrites the current status with the time since the request started (`Researching the best approach... (20s)`), every 10s in the first minute and every 30s after that (`(1m)`, `(1m 30s)`), and it does not return until every write it started has settled. A clarification resume is a new request, so its time counts from the user's answer, not from their first question.
- Set a step's status **inside** its region, so it starts with the time already elapsed instead of dropping the suffix until the next tick.
- Write the answer or a failure message **after** the region: text written through the reporter inside a region gets the elapsed suffix, and outside one `set()` writes it as given. The answer and the pipeline's catch-all error use a direct `chat.update`; a text-only failure message may use `set()`.
- A rate-limited status write is not a failed one. The Slack client is on its defaults, so it waits for `Retry-After` and retries, and a region waits for that write before it returns (Code Debt Register, `docs/trajectory-governance.md`).
- When the thread is read after the status message is posted, pass `excludeTs` to `buildThreadContext()`, or the status message is taken for the message being answered.

### Singleton Initialization

BigQuery, Firestore, and the BigQuery execution client use an `initX()` / `getX()` pattern. All three must be initialized before use:

```typescript
initFirestore(projectId);    // src/state/firestore.ts
initBigQuery(projectId);     // src/validation/dryRun.ts (for dry runs)
initBigQueryClient(projectId); // src/execution/runner.ts (for query execution)
```

These are called at startup in `src/app.ts` and must also be called in integration tests.

### 4-Layer Validation Pipeline

`src/validation/pipeline.ts` orchestrates L1→L4 with short-circuit:

| Layer | File | Type | Behavior on failure |
|-------|------|------|-------------------|
| L1 Static | `staticAnalysis.ts` | Regex DML/DDL blocking | Block (word-boundary matching, strips string literals first) |
| L2 AST | `astValidation.ts` | node-sql-parser SELECT check | **Advisory only** — parse failures pass through to L3 |
| L3 Dry Run | `dryRun.ts` | BigQuery `dryRun: true` | Block (authoritative validator; also blocks unless `statistics.query.statementType` is `SELECT`) |
| L4 Cost Gate | `costGate.ts` | Pure bytes threshold check | Block |

### Preflight Guards

All entry points (commands, and the flow that mentions and messages share, `handleSlackRequest()`) call `preflightChecks(channel, threadTs, client)` before launching the pipeline. This shared guard checks in order:

1. **Thread lock** — prevents concurrent pipeline runs in the same thread
2. **Pending clarification** — thread is waiting for user's clarifying answer
3. **Pending escalation** — thread is waiting for data team response

A reply that answers a pending clarification is consumed before preflight, whether or not it @mentions the bot. The order is lock, then claim. A thread reply that finds a pending clarification (`hasPendingClarification()`, a read) takes the thread lock first, then takes the clarification with a transactional claim (`claimClarificationState()`), so only one reply resumes and the resumed run has the thread. When another run holds the lock, the answer is not taken: it stays pending and the reply is asked, at that point, to send the answer again (`CLARIFICATION_ANSWER_NOT_TAKEN_TEXT`), with no rate-limit count and no second try at the lock. It does not get preflight's "still working on your previous question" notice: no run that is going will use that answer, so the user would wait for a reply that never comes. When the claim finds nothing (another reply took it), the lock is released and the reply is handled as an ordinary thread message. Only when the lock can't be tried at all (logged as `clarification.resume.lock_failed`) does the resume run without one.

### Follow-Up Intent Routing

Thread replies are classified by `followUpClassifier.ts` before entering the pipeline, except a reply from a user with a pending `refinement_targets` doc (left by a refine prompt, `handlers/refinePrompt.ts`): that reply skips intake and classification and goes straight to `refinement` against the answer they clicked. Mentioned and unmentioned thread replies consume targets through the same code (`handleSlackRequest()`). If the target can't be saved, the prompt isn't posted and the user is asked to retry; if it can't be read, the user is told and nothing runs, and the target stays for their retry. The `followUpRouter.ts` handler dispatches:

- **`meta_question`** → Flash LLM call with persisted ResponseContext (no SQL, no supervisor)
- **`refinement`** → Full pipeline re-run with composite question + previous SQL as hint
- **`discrepancy`** → Diagnostic SQL via Pro + validation + lightweight supervisor review + execution, with a status update per stage
- **`new_query`** → Standard pipeline

If a `meta_question`/`refinement`/`discrepancy` handler fails, the user gets an error with a trace ID; it never falls back to a fresh SQL run. Only a failed *classification* falls back to the standard pipeline.

A reply is classified once, in `handleSlackRequest()` before the pipeline; the pipeline does not classify again. The result is logged as `followup.classified` (intent, reasoning, channel, thread), and a failed classification as `followup.classify_failed`. An @mention reply is classified only when the bot had already replied in that thread; a first mention in a thread the bot was not in goes straight to the pipeline. A clarification or escalation resume is not classified and writes neither line.

### Escalation (Human-in-the-Loop)

When the supervisor loop returns `exhausted`, `decideEscalation()` chooses a behavior:

- **`park_wait`** (confidence=low): Tell user "asked the data team", save state to Firestore, post to escalation channel. Pipeline suspends.
- **`best_effort_verify`** (confidence=medium/high): Execute query, show result with caveat, escalate async for human verification.

Escalation supports `channel` mode (shared channel) and `dm` mode (direct message to analyst). State is persisted to `escalation_state` collection for cross-request resume. `resolveEscalationTarget()` in pipeline.ts resolves the target based on mode.

Human replies in the escalation thread are matched via `checkEscalationResponse()` and forwarded to the original user thread. Replies and ✅ reactions both take an atomic resolution claim first (`claimEscalation()` moves `awaiting_human` → `resolving` in a transaction), so only one resolves; delivery is at most once and a claimed resolution is never replayed. A ✅ reaction on an escalation card that shows proposed SQL confirms it (`handleEscalationReaction()` in `handlers/escalationReaction.ts`; skips teaching-candidate harvesting since the reaction carries no new guidance). Reminders and timeouts run via `checkOverdueEscalations()`, driven both by incoming event traffic and by the `POST /api/lifecycle-sweep` endpoint (Cloud Scheduler); each sweep scans every pending escalation, acts on at most 100 due ones (most overdue first, the rest reported as `deferred`), and claims each reminder transactionally before posting. Teaching promotions enqueue pending_notifications docs that the sweep delivers to the originating thread (closing the feedback loop to the user).

### Response Buttons

Every response includes: feedback (thumbs up/down), reasoning toggle, and override buttons (Table, Summary, CSV). The button for the view already on screen is hidden (no Table under a table, no Summary under a summary): result blocks carry `block_id` `anna_view_table` / `anna_view_summary`, and every re-render reads the current view back from the message via `currentViewFromBlocks()` (a legacy table answer is still recognised by its native `table` block; other untagged legacy messages keep all three). Table answers lead with a caption from `src/slack/answerLeadIn.ts`: a rank-only sentence computed from the rows (never an LLM), silent unless provable (no truncation, ties, OFFSET, QUALIFY or a window, a LIMIT that isn't a final measure-DESC top-N, a non-numeric measure type, an ascending sort on the measure, a period-like label such as a date or `Q1 2026`, a grand-total label such as `Total`, a named label Slack would render as formatting such as `*Acme*`, or a named row past the 20 displayed); when it is silent there is no caption (the generator `headline` is never shown above a table, only on single-value answers). Behind `ANSWER_SHARES_ENABLED` (default off), a table answer, the Table override and the Summary fallback table gain a `Share` column, a `Total` row and a leader share in the caption only when `verifyComposition()` (`src/execution/composition.ts`) proves the full result is an additive partition of a whole; anything unproven renders exactly as before, and CSV and the Summary LLM text never get shares. Reasoning toggle loads from persisted ResponseContext — no LLM call. Override buttons re-execute the original SQL (BigQuery 24h cache) through the validation pipeline. If the answer's ResponseContext is missing or logically expired (`isExpiredResponseContext()`: `expiresAt`, or `createdAt` + retention for legacy records), controls reply privately (`chat.postEphemeral`) instead of overwriting the answer. Every request-time reader of `response_context` applies that same expiry rule, because TTL deletion lags by up to ~72h.

### Firestore Collections

| Collection | Key | Purpose |
|---|---|---|
| `processing_threads` | `channel:threadTs` | Thread lease: acquired in a transaction that admits only when absent or expired, stamped with an `ownerToken`; release deletes only if the token still matches (300s `expiresAt`) |
| `rate_limits` | `userId` | Per-user rate limiting (fixed 1-hour window that starts at the first admitted request and resets once it expires; admit-and-count in one transaction) |
| `slack_event_dedupe` | Slack event id | Slack retry dedupe, claimed via `create()`; `expiresAt` TTL (30s while pending, 24h once visible) |
| `sample_rows` | physical table name | Cached sample rows for SQL-generator prompts; 7-day staleness, refreshed in the background at startup. Overwritten in place, so it has no TTL |
| `response_context` | `channel:threadTs_statusMsgTs` (Slack; pre-#30 answers: `threadTs_statusMsgTs`), `conversationId_statusMsgTs` (WhatsApp) | Pipeline result persistence + thread participation detection (`expiresAt` TTL, `RESPONSE_CONTEXT_RETENTION_DAYS`, default 90d). `compositionUniqueKeys` (only when a share proof used dbt unique keys; omitted otherwise) lets the Table override re-verify the same shares; keys the loaded dbt manifest no longer declares are dropped on re-render |
| `clarification_state` | `clarificationId` | Pending clarification state (suspend/resume); a Slack reply takes it with a transactional claim (read and delete in one transaction); stores the clarifying questions so the answered message can be redrawn without its Cancel button |
| `escalation_state` | `escalationId` | Escalation state for async human-in-the-loop (suspend/resume); `pipelineState` `awaiting_human` → `resolving` (atomic claim by a reply or ✅), or `awaiting_human` → `timed_out` (sweep timeout, also transactional); `retainUntil` TTL (90d) — its `expiresAt` is the escalation timeout, not retention |
| `config` | `metadata_state` | `/health/doctor` Firestore connectivity probe target (cheap read; the doc need not exist). The dbt-metadata-freshness writer was never wired; its dead module was removed 2026-06-19. |
| `information_schema_cache` | `dataset.table` | INFORMATION_SCHEMA results cache (24h TTL) |
| `dbt_run_history` | `runId_model` | dbt build results from run_results.json (90d TTL) |
| `teaching_candidates` | `candidateId` | Teaching candidates from escalation resolutions |
| `feedback_notes` | `traceId_userId` or `channel:threadTs_userId` | 👎 → "Other" free-text corrections; `status: pending\|reviewed`, drained by `scripts/promote-teachings.ts` |
| `refinement_targets` | `channel:threadTs_userId` | The answer a user picked to refine ("Change assumptions" / "Not what I asked"); consumed by their next thread reply; `expiresAt` TTL (30m) |
| `pending_notifications` | `notif_<candidateId>` | User-facing notifications enqueued by `scripts/promote-teachings.ts`, delivered by the lifecycle sweep; `expiresAt` TTL (30d) |
| `thread_participation` | `channel:threadTs` | Marks channel threads the bot replied in, written by mention replies and `/anna` status messages even when no answer is saved (greetings/help, errors), so unmentioned follow-ups there still reach the bot; checked before `response_context` (`expiresAt` TTL, same window as `response_context`) |
| `whatsapp_event_dedupe` | event doc id | WhatsApp webhook delivery dedupe (gated prototype); `expiresAt` TTL |
| `whatsapp_action_context` | action context id | Answer context for WhatsApp interactive controls (feedback/reasoning/SQL/format follow-ups); `expiresAt` TTL (24h) |
| `whatsapp_pending_feedback_notes` | `conversationId` | Pending WhatsApp negative-feedback free-text capture; `expiresAt` TTL (30m) |

**Composite indexes are manual.** Any Firestore query combining a `where()` with an `orderBy()` on a different field (or multiple `where()` clauses) needs a composite index. These are created manually via `gcloud firestore indexes composite create` — Terraform in `infra/` is not applied in this environment. When you add such a query, also add the index to the `infra/firestore.indexes.json` manifest and create it in the live project, or the query throws `FAILED_PRECONDITION` at runtime (mocked tests will not catch this). See README "Infrastructure Setup".

**TTL policies are also manual.** `infra/firestore.ttls.json` is the manifest of per-collection TTL fields (parity-tested by `tests/infra/firestoreTtls.test.ts`); apply via `gcloud firestore fields ttls update` — see README "Firestore TTL Policy".

### Config Conversion

`toPipelineConfig(config: AppConfig): PipelineConfig` in `pipeline.ts` converts the full app config to the pipeline-scoped config. All call sites (commands, mentions, message handler, escalation resume) use this helper — never construct `PipelineConfig` inline.

### Error Handling

`src/errors.ts` maps all errors to user-safe messages. Raw error text, API URLs, and internal identifiers are never exposed to users. Every error response includes a trace ID.

### REST Endpoints

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/health` | None | Liveness ping — returns `200 OK`. Dependency-free; Cloud Run's liveness probe. |
| GET | `/health/doctor` | None | Diagnostic readiness check — probes Firestore/BigQuery/Gemini/Slack in parallel + reports configured features. Info-safe JSON (no IDs/secrets/raw errors). `200` ok/degraded, `503` when a critical dep is down. |
| POST | `/api/dbt-run-results` | Bearer `DBT_WEBHOOK_SECRET` | Ingest dbt `run_results.json` from CI |
| POST | `/api/lifecycle-sweep` | Bearer `LIFECYCLE_SWEEP_SECRET` | Trigger escalation reminder/timeout sweep + deliver queued user notifications (Cloud Scheduler) |
| GET | `/whatsapp/webhook` | `hub.verify_token` match | Meta webhook verification handshake (gated WhatsApp prototype; registered only when `WHATSAPP_ENABLED=true`) |
| POST | `/whatsapp/webhook` | `X-Hub-Signature-256` (HMAC, `WHATSAPP_APP_SECRET`) | Inbound WhatsApp messages + interactive replies (gated prototype; allowlisted senders only) |

## Key SDK Patterns

### Google GenAI SDK (`@google/genai` v1.41+)

- `response.text` is a **getter property**, not a method — use `response.text` not `response.text()`
- Structured output uses `responseJsonSchema` with **JSON Schema objects**, not Zod schemas
- `responseMimeType: 'application/json'` required alongside `responseJsonSchema`
- Thread context maps `assistant` role to `'model'` for Gemini API
- Thinking is **discrete** in Gemini 3.x: `config.thinkingConfig.thinkingLevel` is `'minimal' | 'low' | 'medium' | 'high'` (not a numeric `thinkingBudget`). Omit `thinkingConfig` entirely for model-default thinking.
- Agents never hardcode a model. Each generation call goes through `generateForNode('<nodeId>', ai, { contents, config })` (`src/agents/modelGateway.ts`), which resolves the model + thinking level from the `nodeProfiles` registry (`src/agents/nodeProfiles.ts`, defaults pinned to Gemini 3.x) and records per-node token/latency telemetry. Runtime overrides come from `NODE_PROFILE_OVERRIDES` / `MODEL_ID_OVERRIDES` (see `.env.example`).

### Bolt.js

- `app_mention` events go to a separate Bolt listener (`registerMentions`), not the `message` handler. It is a thin adapter: it removes the bot's own mention from the text (`stripBotMention()`; the other people named in it stay, because the text can be a clarification answer or an analyst's guidance) and calls `handleSlackRequest()` (`handlers/messageHandler.ts`), the one flow both listeners run. New request handling goes in that flow, not in a listener.
- A channel message that @mentions the bot arrives as both an `app_mention` event and a `message` event, with different event ids, so event dedupe does not join them. The `app_mention` listener owns it and the `message` listener returns early (`isOwnedByMentionListener()`: `channel_type` is `channel` or `group`, and the text contains `<@botUserId>`, from Bolt's `context.botUserId`). Direct conversations get no `app_mention`, so they stay with the `message` listener, and with no bot user id nothing is handed over.
- `message` events never have `type: 'app_mention'` — don't check for it in `shouldRespond`
- After filtering `bot_id`/`subtype`, narrow message events to `GenericMessageEvent` from `@slack/types`

### Mocking in Tests

- BigQuery and GoogleGenAI mocks **must use class syntax** (not arrow functions) because they're instantiated with `new`:
  ```typescript
  vi.mock('@google-cloud/bigquery', () => ({
    BigQuery: class { createQueryJob = mockFn; },
  }));
  ```
- `vi.clearAllMocks()` resets mock return values — re-setup in `beforeEach`
- BigQuery job metadata is at `job.metadata.statistics` (not `job.statistics`)
- Firestore `create()` throws error code 6 (ALREADY_EXISTS) for contention on event dedupe (`slack_event_dedupe`, `whatsapp_event_dedupe`) — test with `{ code: 6 }`. Thread leases, rate limits, escalation claims and clarification claims use `db.runTransaction()` instead, so mock `runTransaction` with a fake `transaction.get/set/update/delete`.

## Testing

Tests mirror source at `tests/` with `.test.ts` suffix. Fixtures at `tests/fixtures/`.

- Validation layers and formatting are pure functions — test without mocks
- External services (BigQuery, Gemini, Firestore, Slack API) are always mocked
- Integration tests in `tests/integration/` use real module wiring with only external services mocked
- `src/app.ts` is excluded from coverage (entry point)

## Environment

Required env vars are documented in `.env.example`. dbt artifacts (`manifest.json`, `catalog.json`) are COPY'd into the container image at build time from the `dbt/` directory. `DBT_WEBHOOK_SECRET` is optional — when set, it enables the `POST /api/dbt-run-results` endpoint for ingesting dbt build results.
