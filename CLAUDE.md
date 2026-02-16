# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Anna Lytics is a Slack bot that translates natural-language questions into BigQuery SQL using Gemini 3.0 Pro, with dbt metadata as the semantic layer. It runs on Cloud Run, uses Firestore for state, and communicates via Bolt.js (HTTP mode with ExpressReceiver).

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

Human replies in the escalation thread are matched via `checkEscalationResponse()` and forwarded to the original user thread. Reminders and timeouts piggyback on incoming event traffic (`checkOverdueEscalations()`).

### Response Buttons

Every response includes: feedback (thumbs up/down), reasoning toggle, and override buttons (Table, Summary, CSV). Reasoning toggle loads from persisted ResponseContext — no LLM call. Override buttons re-execute the original SQL (BigQuery 24h cache) through the validation pipeline.

### Firestore Collections

| Collection | Key | Purpose |
|---|---|---|
| `processing_threads` | `threadTs` | Thread lock (atomic via `create()`, 300s TTL) |
| `rate_limits` | `userId` | Per-user rate limiting (1-hour sliding window) |
| `response_context` | `threadTs_statusMsgTs` | Pipeline result persistence + thread participation detection |
| `clarification_state` | `clarificationId` | Pending clarification state (suspend/resume) |
| `escalation_state` | `escalationId` | Escalation state for async human-in-the-loop (suspend/resume) |
| `config` | `metadata_state` | dbt metadata freshness |

### Config Conversion

`toPipelineConfig(config: AppConfig): PipelineConfig` in `pipeline.ts` converts the full app config to the pipeline-scoped config. All call sites (commands, mentions, message handler, escalation resume) use this helper — never construct `PipelineConfig` inline.

### Error Handling

`src/errors.ts` maps all errors to user-safe messages. Raw error text, API URLs, and internal identifiers are never exposed to users. Every error response includes a trace ID.

## Key SDK Patterns

### Google GenAI SDK (`@google/genai` v1.41+)

- `response.text` is a **getter property**, not a method — use `response.text` not `response.text()`
- Structured output uses `responseJsonSchema` with **JSON Schema objects**, not Zod schemas
- `responseMimeType: 'application/json'` required alongside `responseJsonSchema`
- Thread context maps `assistant` role to `'model'` for Gemini API

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

Required env vars are documented in `.env.example`. dbt artifacts (`manifest.json`, `catalog.json`) are COPY'd into the container image at build time from the `dbt/` directory.
