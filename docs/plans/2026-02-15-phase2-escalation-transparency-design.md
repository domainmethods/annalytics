# Phase 2: Escalation + Reasoning Transparency — Design

**Date**: 2026-02-15
**Status**: Approved
**Parent**: [Anna Lytics Design Document](./2026-02-15-anna-lytics-design.md) (Sections 10, 11)

---

## Scope

Two Phase 2 features built sequentially: Escalation first, then Reasoning Transparency.

### In Scope

**Human-in-the-Loop Escalation:**
- Configurable escalation target (channel or DM mode)
- Two triggers: mid-pipeline ambiguity, supervisor exhaustion
- Two behavior paths: best-effort + verify, park + wait
- Firestore `escalation_state` for async suspend/resume
- `preflightChecks()` updated for escalation guard
- Escalation message format (Block Kit with full context)
- Human response handler (match via thread_ts, resume pipeline)
- Reminder mechanism (configurable, default 30min)
- Timeout (configurable, default 4hr)

**Reasoning Transparency:**
- Meta-question handler (Flash LLM, no SQL generation)
- Discrepancy investigation (diagnostic SQL via Pro, lightweight supervisor)
- Refinement flow (composite question, full pipeline re-run with previous SQL as hint)
- Show/Hide reasoning toggle (Block Kit button, chat.update)
- Response override buttons (Table, Summary via Flash, CSV file upload)
- Enhanced ResponseContext with retrievedSchema

### Out of Scope

- Auto-teaching extraction from escalations (deferred to Phase 3)
- Teaching staleness detection (Phase 3)
- Channel-based access control (separate Phase 2 feature)
- dbt run status queries (separate Phase 2 feature)
- INFORMATION_SCHEMA fallback (separate Phase 2 feature)

---

## Escalation

### Escalation Config

```typescript
interface EscalationConfig {
  mode: 'channel' | 'dm';
  channelId?: string;          // channel mode target
  analystUserId?: string;      // DM mode target
  reminderIntervalMinutes: number;  // default: 30
  timeoutHours: number;             // default: 4
}
```

Loaded from environment variables at startup. Channel mode posts to a shared channel (e.g., `#data-team-escalations`). DM mode messages a specific analyst.

### Triggers

| Trigger | Condition | Behavior |
|---------|-----------|----------|
| Supervisor exhausted + plausible answer | `supervisorLoop` returns `exhausted`, primary agent confidence >= medium | Best-effort + verify: show answer with caveat, escalate async for verification |
| Supervisor exhausted + no plausible answer | `supervisorLoop` returns `exhausted`, primary agent confidence = low | Park + wait: tell user bot is checking with data team, suspend pipeline |
| Mid-pipeline ambiguity | Primary agent explicitly flags ambiguity (e.g., two candidate tables) | Park + wait: escalate the specific decision to human |

### State Machine

Firestore collection: `escalation_state`

```typescript
interface EscalationState {
  escalationId: string;
  originalThreadTs: string;
  originalChannel: string;
  pipelineState: 'awaiting_human' | 'resolved' | 'timed_out';
  trigger: 'supervisor_exhausted' | 'mid_pipeline_ambiguity';
  behavior: 'best_effort_verify' | 'park_wait';
  stageToResume: 'sql_generation' | 'supervisor_review';
  context: {
    clarifiedQuestion: string;
    userQuestion: string;
    groundingCitations: GroundingCitation[];
    previousSql?: string;
    supervisorNotes?: string;
    ambiguityDescription?: string;
  };
  escalationChannel: string;
  escalationTs: string;        // ts of message in escalation channel/DM
  statusMsgTs: string;         // original status message in user's thread
  bestEffortSql?: string;      // if best-effort path, the SQL shown to user
  createdAt: Date;
  expiresAt: Date;             // createdAt + timeoutHours
  lastReminderAt?: Date;
  traceId: string;
}
```

Flow:
1. Pipeline hits escalation trigger
2. If best-effort: execute query and show result with caveat to user
3. Persist `EscalationState` to Firestore
4. Post escalation message to target channel/DM
5. Return (Cloud Run request ends)
6. Human responds in escalation thread → Bolt.js message event
7. Match response to escalation via `escalationTs` thread
8. Load state, incorporate human guidance
9. If park+wait: resume pipeline at `stageToResume`, post result to original thread
10. If best-effort+verify: post human's confirmation/correction to original thread
11. Mark escalation as `resolved`

### preflightChecks() Update

Add escalation guard (the design doc already shows this code pattern):
- Query `escalation_state` where `originalThreadTs == threadTs` and `pipelineState == 'awaiting_human'`
- If found and not expired: respond "I'm still waiting for the data team..." and release lock
- If found and expired: mark as `timed_out`, proceed normally

### Escalation Message Format

Posted to escalation channel/DM with Block Kit:

```
🔔 Anna Lytics needs help

**User question**: "{userQuestion}"
**Channel**: #{channelName} (thread link)
**What I'm stuck on**: {ambiguityDescription or supervisorNotes}

**My best guess**: {bestEffortSql or "None — I couldn't generate a reliable query"}

React with ✅ if my guess is correct, or reply with guidance.
```

### Reminders

A lightweight interval check. On each incoming Slack event, check for overdue escalations:
- Query `escalation_state` where `pipelineState == 'awaiting_human'` and `lastReminderAt < now - reminderIntervalMinutes`
- Post reminder to escalation channel: "Still waiting on this one — {link to original escalation}"
- Update `lastReminderAt`

This piggybacks on existing event traffic rather than requiring a separate cron/scheduler.

### Timeout

When `expiresAt` passes:
- Best-effort+verify: mark as `timed_out`, post to original thread: "The data team hasn't weighed in yet, but the answer I showed earlier is my best estimate."
- Park+wait: mark as `timed_out`, post to original thread: "I wasn't able to get an answer from the data team in time. Try asking again or reach out to them directly."

Timeout detection uses the same piggyback-on-events approach as reminders.

---

## Reasoning Transparency

### ResponseContext Enhancement

Add `retrievedSchema` to the existing `ResponseContext` interface:

```typescript
// Added field:
retrievedSchema: {
  name: string;
  description: string;
  columns: { name: string; description: string; dataType: string }[];
}[];
```

This persists all tables the pipeline considered (5-15), not just those used in the final SQL. Enables meta-question answers like "why fct_orders and not fct_subscriptions?"

The pipeline already has this data at generation time — just needs to serialize it into `ResponseContext` before the Firestore write.

### Follow-Up Intent Routing

Phase 1 already implements `followUpClassifier.ts` returning `new_query | refinement | meta_question | discrepancy`. Phase 2 implements the handlers for the last three intents.

The pipeline's follow-up handling (in `pipeline.ts` or `handlers/messages.ts`) routes:
- `new_query` → full pipeline (existing)
- `refinement` → refinement handler (new)
- `meta_question` → meta-question handler (new)
- `discrepancy` → discrepancy handler (new)

### Meta-Question Handler

Load `ResponseContext` for the thread, call Flash with:
- Previous clarified question, SQL, assumptions, reasoning chain, supervisor notes
- `retrievedSchema` (all tables considered, with descriptions and columns)
- `groundingCitations` (teaching chunks used)
- User's follow-up question

No SQL generation. No supervisor. No validation. Single Flash call, ~2-3s.

### Discrepancy Investigation Handler

1. Load `ResponseContext` for the previous answer
2. Parse the discrepancy from the user's message (e.g., "total is $5M but Q4 is only $800K")
3. Generate diagnostic SQL via Primary Agent (Gemini Pro) with context:
   - Original SQL and results metadata
   - The stated discrepancy
   - Instructions to investigate: break down by dimension, check filter effects, look for data gaps
4. Run diagnostic SQL through validation pipeline (L1-L4)
5. Execute diagnostic query
6. Lightweight supervisor review (single Pro call with reduced prompt: "verify this diagnostic is sensible")
7. Present findings to user in plain language

### Refinement Handler

1. Load previous `ResponseContext`
2. Construct composite question: original question + refinement instruction
3. Feed through full pipeline with previous SQL as hint:
   ```
   PREVIOUS SQL (user wants a modification):
   {original_sql}

   Use as a starting point. Generate a complete new query incorporating the refinement.
   ```
4. Schema retrieval can reuse `retrievedSchema` from ResponseContext (optimization)

### Show/Hide Reasoning Toggle

Block Kit has no client-side toggle. Implemented as button action → chat.update:

1. Response includes `🔍 Show reasoning` button (actions block)
2. Click → `block_actions` event → handler loads `ResponseContext`
3. `chat.update()` replaces button with reasoning content:
   - Tables used and why
   - Filters applied
   - Teachings referenced
   - Supervisor assessment
   - `🔍 Hide reasoning` button to toggle back
4. Toggle back → `chat.update()` collapses to button again

No LLM call — reasoning is already in `ResponseContext`. ~200ms round-trip (Firestore read + Slack API).

### Response Override Buttons

Every response includes:
```
[📋 Table] [📝 Summary] [⬇️ CSV] [🔍 Reasoning] [👍] [👎]
```

| Button | Behavior | LLM call? |
|--------|----------|-----------|
| Table | Re-render results as Block Kit table/code block | No |
| Summary | Generate natural language summary | Yes (Flash) |
| CSV | Upload results as CSV file via `files.uploadV2` | No |
| Reasoning | Show/Hide toggle (above) | No |
| 👍 / 👎 | Existing feedback mechanism | No |

Override buttons re-format cached data from `ResponseContext` — no re-execution. Summary is the exception: it requires a Flash call (~2-3s), so the message updates to "Generating summary..." first.

**Important**: Query result rows are NOT stored in ResponseContext (PII concern per design doc). Override buttons that need result data (Table, Summary, CSV) must re-execute the query. BigQuery caches results for 24 hours, so re-execution is fast and free for identical queries within the cache window.

---

## Build Order

1. **Escalation infrastructure**: types, config, Firestore state, escalation agent
2. **Escalation handlers**: message handler for escalation channel, resume pipeline, preflightChecks update
3. **Escalation UX**: Block Kit messages, reminders, timeout
4. **ResponseContext enhancement**: add retrievedSchema, persist in pipeline
5. **Follow-up routing**: wire meta_question/refinement/discrepancy intents to handlers
6. **Meta-question handler**: Flash LLM call from ResponseContext
7. **Refinement handler**: composite question, pipeline re-run with previous SQL
8. **Discrepancy handler**: diagnostic SQL generation, lightweight review
9. **Show/Hide reasoning toggle**: button action, chat.update
10. **Response override buttons**: Table/Summary/CSV re-rendering

---

## Testing Strategy

- Escalation state machine: unit tests with mocked Firestore
- Escalation handlers: unit tests with mocked Slack client
- Reminder/timeout: unit tests for detection logic (pure functions where possible)
- Meta-question/discrepancy/refinement handlers: unit tests with mocked LLM
- Show/Hide toggle: unit test for Block Kit construction + chat.update call
- Override buttons: unit tests for each re-format path
- Integration test: full escalation flow (trigger → suspend → resume → respond)
- Integration test: full follow-up flow (initial query → meta-question → refinement)
