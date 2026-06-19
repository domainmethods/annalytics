# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Anna Lytics is a Slack bot that translates natural-language questions into BigQuery SQL using configurable Gemini model aliases, with dbt metadata as the semantic layer. It runs on Cloud Run, uses Firestore for state, and communicates via Bolt.js (HTTP mode with ExpressReceiver).

## Trajectory Governance

Before proposing or implementing Phase 3+ product work, read `docs/trajectory-governance.md`. That document is the governing roadmap checkpoint for current tranche selection, deferred features, and maintenance rules.

Current guidance: prioritize trust infrastructure over feature expansion. The `ReferenceCard v1` acceptance gate **passed**: after two `NEEDS_REVISION` runs (2026-06-11) and a confirming slice, the post-repair re-run recorded **`ACCEPTED`** 2026-06-12 with zero scorecard failures (sessions & traffic attribution pilot — see the governance Evidence Log). The one-additional-domain branch is taken: the next product tranche may add exactly one high-confusion ReferenceCard domain, but selection must come from aggregated production feedback signal (not analyst convenience) and the new domain needs its own benchmark slice before it ships — so it waits on feedback data, not engineering. Tranche B (operational trust maintenance — Firestore TTL/retention, production telemetry sink, time-driven escalation timeouts, the escalation ✅-reaction handler) was completed 2026-06-09. The evaluation-scaffolding freeze is lifted, but net-new benchmark/calibration/sizing/sweep machinery still activates last in the Tranche Horizon (behind the side bar calibration check, teaching impact measurement, and node sizing); fixing defects in existing instruments remains fine. Do not commit client-specific dbt artifacts, project IDs, File Search store IDs, ReferenceCards, or benchmark evidence to this template unless the repository has intentionally become an implementation repo. Do not revive broad charts, BQML expansion, domain agents, or automatic correction harvesting as the active next tranche unless `docs/trajectory-governance.md` is updated first with the new rationale and evidence.

When adversarial audits, benchmark results, production incidents, or analyst review change the development trajectory, update `docs/trajectory-governance.md` in the same change set.

## Commands

```bash
npm run typecheck          # tsc --noEmit
npm test                   # vitest run (all tests)
npx vitest run tests/validation/staticAnalysis.test.ts  # single test file
npx vitest run --reporter=verbose  # verbose output
npm run build              # tsc → dist/
npm run dev                # tsx src/app.ts (requires .env)
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
  2. Thread Context (conversations.replies → last 4 msgs, 4K char limit)
  3. SQL Generation + Supervisor Loop (generateSql → supervisor review → retry)
  3b. Escalation Decision (if exhausted: park_wait or best_effort_verify → save state, post to escalation channel, return)
  4. Validation (L1 static → L2 AST → L3 BigQuery dry run → L4 cost gate, short-circuit on failure)
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
- **`threadTs`**: Thread identity. Used for state (locks, ResponseContext), thread context retrieval, reply threading.
- **`statusMsgTs`**: The bot's status message. Used exclusively for `chat.update()` calls. Never conflated with thread identity.

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
| L3 Dry Run | `dryRun.ts` | BigQuery `dryRun: true` | Block (authoritative validator) |
| L4 Cost Gate | `costGate.ts` | Pure bytes threshold check | Block |

### Preflight Guards

All entry points (commands, mentions, message handler) call `preflightChecks(channel, threadTs, client)` before launching the pipeline. This shared guard checks in order:

1. **Thread lock** — prevents concurrent pipeline runs in the same thread
2. **Pending clarification** — thread is waiting for user's clarifying answer
3. **Pending escalation** — thread is waiting for data team response

### Follow-Up Intent Routing

Thread replies are classified by `followUpClassifier.ts` before entering the pipeline. The `followUpRouter.ts` handler dispatches:

- **`meta_question`** → Flash LLM call with persisted ResponseContext (no SQL, no supervisor)
- **`refinement`** → Full pipeline re-run with composite question + previous SQL as hint
- **`discrepancy`** → Diagnostic SQL via Pro + validation + lightweight supervisor review + execution
- **`new_query`** → Standard pipeline

### Escalation (Human-in-the-Loop)

When the supervisor loop returns `exhausted`, `decideEscalation()` chooses a behavior:

- **`park_wait`** (confidence=low): Tell user "asked the data team", save state to Firestore, post to escalation channel. Pipeline suspends.
- **`best_effort_verify`** (confidence=medium/high): Execute query, show result with caveat, escalate async for human verification.

Escalation supports `channel` mode (shared channel) and `dm` mode (direct message to analyst). State is persisted to `escalation_state` collection for cross-request resume. `resolveEscalationTarget()` in pipeline.ts resolves the target based on mode.

Human replies in the escalation thread are matched via `checkEscalationResponse()` and forwarded to the original user thread. A ✅ reaction on an escalation card that shows proposed SQL confirms it (`handleEscalationReaction()` in `handlers/escalationReaction.ts`; skips teaching-candidate harvesting since the reaction carries no new guidance). Reminders and timeouts run via `checkOverdueEscalations()`, driven both by incoming event traffic and by the `POST /api/lifecycle-sweep` endpoint (Cloud Scheduler). Teaching promotions enqueue pending_notifications docs that the sweep delivers to the originating thread (closing the feedback loop to the user).

### Response Buttons

Every response includes: feedback (thumbs up/down), reasoning toggle, and override buttons (Table, Summary, CSV). Reasoning toggle loads from persisted ResponseContext — no LLM call. Override buttons re-execute the original SQL (BigQuery 24h cache) through the validation pipeline.

### Firestore Collections

| Collection | Key | Purpose |
|---|---|---|
| `processing_threads` | `threadTs` | Thread lock (atomic via `create()`, 300s TTL) |
| `rate_limits` | `userId` | Per-user rate limiting (1-hour sliding window) |
| `response_context` | `threadTs_statusMsgTs` | Pipeline result persistence + thread participation detection (`expiresAt` TTL, `RESPONSE_CONTEXT_RETENTION_DAYS`, default 90d) |
| `clarification_state` | `clarificationId` | Pending clarification state (suspend/resume) |
| `escalation_state` | `escalationId` | Escalation state for async human-in-the-loop (suspend/resume); `retainUntil` TTL (90d) — its `expiresAt` is the escalation timeout, not retention |
| `config` | `metadata_state` | `/health/doctor` Firestore connectivity probe target (cheap read; the doc need not exist). The dbt-metadata-freshness writer was never wired; its dead module was removed 2026-06-19. |
| `information_schema_cache` | `dataset.table` | INFORMATION_SCHEMA results cache (24h TTL) |
| `dbt_run_history` | `runId_model` | dbt build results from run_results.json (90d TTL) |
| `teaching_candidates` | `candidateId` | Teaching candidates from escalation resolutions |
| `feedback_notes` | `traceId` or `threadTs_userId` | 👎 → "Other" free-text corrections; `status: pending\|reviewed`, drained by `scripts/promote-teachings.ts` |
| `pending_notifications` | `notif_<candidateId>` | User-facing notifications enqueued by `scripts/promote-teachings.ts`, delivered by the lifecycle sweep; `expiresAt` TTL (30d) |

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

## Key SDK Patterns

### Google GenAI SDK (`@google/genai` v1.41+)

- `response.text` is a **getter property**, not a method — use `response.text` not `response.text()`
- Structured output uses `responseJsonSchema` with **JSON Schema objects**, not Zod schemas
- `responseMimeType: 'application/json'` required alongside `responseJsonSchema`
- Thread context maps `assistant` role to `'model'` for Gemini API
- Thinking is **discrete** in Gemini 3.x: `config.thinkingConfig.thinkingLevel` is `'minimal' | 'low' | 'medium' | 'high'` (not a numeric `thinkingBudget`). Omit `thinkingConfig` entirely for model-default thinking.
- Agents never hardcode a model. Each generation call goes through `generateForNode('<nodeId>', ai, { contents, config })` (`src/agents/modelGateway.ts`), which resolves the model + thinking level from the `nodeProfiles` registry (`src/agents/nodeProfiles.ts`, defaults pinned to Gemini 3.x) and records per-node token/latency telemetry. Runtime overrides come from `NODE_PROFILE_OVERRIDES` / `MODEL_ID_OVERRIDES` (see `.env.example`).

### Bolt.js

- `app_mention` events go to a separate Bolt listener (`registerMentions`), not the `message` handler
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
- Firestore `create()` throws error code 6 (ALREADY_EXISTS) for lock contention — test with `{ code: 6 }`

## Testing

Tests mirror source at `tests/` with `.test.ts` suffix. Fixtures at `tests/fixtures/`.

- Validation layers and formatting are pure functions — test without mocks
- External services (BigQuery, Gemini, Firestore, Slack API) are always mocked
- Integration tests in `tests/integration/` use real module wiring with only external services mocked
- `src/app.ts` is excluded from coverage (entry point)

## Environment

Required env vars are documented in `.env.example`. dbt artifacts (`manifest.json`, `catalog.json`) are COPY'd into the container image at build time from the `dbt/` directory. `DBT_WEBHOOK_SECRET` is optional — when set, it enables the `POST /api/dbt-run-results` endpoint for ingesting dbt build results.
