# Phase 2: Escalation + Reasoning Transparency — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add human-in-the-loop escalation (async suspend/resume when the supervisor is uncertain) and reasoning transparency (meta-questions, refinements, discrepancy investigations, show/hide reasoning, response override buttons).

**Architecture:** Escalation follows the same Firestore suspend/resume pattern as `clarificationState.ts`. Reasoning transparency builds on the existing `ResponseContext` (adding `retrievedSchema`) and follow-up intent classifier (already returns `meta_question | refinement | discrepancy` but handlers are unimplemented). Response override buttons and reasoning toggle use Block Kit `block_actions` events with `chat.update()`.

**Tech Stack:** TypeScript, Vitest, Bolt.js, Firestore, Google GenAI SDK (`@google/genai`), Zod, `@slack/types`

**Parent design:** `docs/plans/2026-02-15-phase2-escalation-transparency-design.md`

---

## Task 1: Escalation Types and Config

**Files:**
- Modify: `src/types.ts`
- Modify: `src/config.ts`
- Modify: `src/agents/types.ts`
- Test: `tests/config.test.ts` (if exists, otherwise skip — config is tested via integration)

### Step 1: Add EscalationState to types.ts

Add after the existing `ResponseContext` interface (~line 56):

```typescript
export interface EscalationState {
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
  escalationTs: string;
  statusMsgTs: string;
  bestEffortSql?: string;
  createdAt: Date;
  expiresAt: Date;
  lastReminderAt?: Date;
  traceId: string;
}
```

### Step 2: Add EscalationConfig to config.ts

Add to the `AppConfig` interface:

```typescript
escalation: {
  mode: 'channel' | 'dm';
  channelId?: string;
  analystUserId?: string;
  reminderIntervalMinutes: number;
  timeoutHours: number;
};
```

Add to `loadConfig()`:

```typescript
escalation: {
  mode: (process.env.ESCALATION_MODE || 'channel') as 'channel' | 'dm',
  channelId: process.env.ESCALATION_CHANNEL_ID,
  analystUserId: process.env.ESCALATION_ANALYST_USER_ID,
  reminderIntervalMinutes: parseEnvInt('ESCALATION_REMINDER_MINUTES', 30),
  timeoutHours: parseEnvInt('ESCALATION_TIMEOUT_HOURS', 4),
},
```

### Step 3: Add retrievedSchema to ResponseContext

Add to the `ResponseContext` interface in `src/types.ts`:

```typescript
retrievedSchema?: {
  name: string;
  description: string;
  columns: { name: string; description: string; dataType: string }[];
}[];
```

Optional for backward compatibility — Phase 0/1 responses won't have it.

### Step 4: Run typecheck

Run: `npm run typecheck`
Expected: PASS (new fields are optional or have defaults)

### Step 5: Commit

```
feat(types): add EscalationState, EscalationConfig, retrievedSchema to ResponseContext
```

---

## Task 2: Escalation State Module

**Files:**
- Create: `src/state/escalationState.ts`
- Create: `tests/state/escalationState.test.ts`

Follows the exact pattern of `src/state/clarificationState.ts`.

### Step 1: Write tests

Tests for 6 functions following the `clarificationState.test.ts` mock pattern:

```typescript
// tests/state/escalationState.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock Firestore with same pattern as clarificationState tests
const mockSet = vi.fn();
const mockDelete = vi.fn();
const mockUpdate = vi.fn();
const mockDoc = vi.fn(() => ({ set: mockSet, delete: mockDelete, update: mockUpdate }));
const mockGet = vi.fn();
const mockWhere = vi.fn();
const mockLimit = vi.fn();
const mockCollection = vi.fn(() => ({ doc: mockDoc, where: mockWhere }));

vi.mock('../../src/state/firestore.js', () => ({
  getDb: vi.fn(() => ({ collection: mockCollection })),
}));
```

Test cases:
1. `saveEscalationState` — saves with correct collection, doc ID, sets createdAt/expiresAt
2. `getEscalationByThread` — queries by `originalThreadTs` + `pipelineState: 'awaiting_human'`, returns state or null if expired
3. `getEscalationByThread` — returns null and deletes when expired (same `expiresAt` check as clarification)
4. `getEscalationByEscalationThread` — queries by `escalationTs` for matching human responses
5. `resolveEscalation` — updates `pipelineState` to `'resolved'`
6. `updateReminderTime` — updates `lastReminderAt`
7. `hasPendingEscalation` — convenience boolean wrapper

### Step 2: Run tests — verify they fail

Run: `npx vitest run tests/state/escalationState.test.ts`
Expected: FAIL (module doesn't exist)

### Step 3: Implement escalationState.ts

```typescript
// src/state/escalationState.ts
import { getDb } from './firestore.js';
import type { EscalationState } from '../types.js';

const COLLECTION = 'escalation_state';

export async function saveEscalationState(
  state: Omit<EscalationState, 'createdAt' | 'expiresAt' | 'pipelineState'>,
  timeoutHours: number,
): Promise<void> {
  const db = getDb();
  const now = new Date();
  await db.collection(COLLECTION).doc(state.escalationId).set({
    ...state,
    pipelineState: 'awaiting_human',
    createdAt: now,
    expiresAt: new Date(now.getTime() + timeoutHours * 60 * 60 * 1000),
  });
}

export async function getEscalationByThread(
  threadTs: string,
): Promise<EscalationState | null> {
  // Query by originalThreadTs + pipelineState, check expiresAt
  // Same expiration check pattern as clarificationState
}

export async function getEscalationByEscalationThread(
  escalationTs: string,
): Promise<EscalationState | null> {
  // Query by escalationTs + pipelineState for matching human responses
}

export async function resolveEscalation(escalationId: string): Promise<void> {
  await getDb().collection(COLLECTION).doc(escalationId).update({
    pipelineState: 'resolved',
  });
}

export async function updateReminderTime(escalationId: string): Promise<void> {
  await getDb().collection(COLLECTION).doc(escalationId).update({
    lastReminderAt: new Date(),
  });
}

export async function hasPendingEscalation(threadTs: string): Promise<boolean> {
  const state = await getEscalationByThread(threadTs);
  return state !== null;
}
```

### Step 4: Run tests — verify they pass

Run: `npx vitest run tests/state/escalationState.test.ts`
Expected: PASS

### Step 5: Commit

```
feat(state): add escalation state Firestore module
```

---

## Task 3: Escalation Block Kit Messages

**Files:**
- Create: `src/slack/escalationBlocks.ts`
- Create: `tests/slack/escalationBlocks.test.ts`

### Step 1: Write tests

Test cases:
1. `buildEscalationBlocks` — builds Block Kit for escalation channel message with user question, channel link, stuck description, best guess SQL (or "None")
2. `buildEscalationBlocks` — omits best guess section when no SQL provided
3. `buildUserWaitingBlocks` — builds message for user thread: "I've asked the data team..."
4. `buildBestEffortCaveatBlocks` — builds message for user thread with caveat: "I'm not fully confident... [supervisor note]"
5. `buildEscalationResolvedBlocks` — builds message for user when human has responded
6. `buildEscalationReminderBlocks` — builds reminder message for escalation channel

### Step 2: Run tests — verify they fail

Run: `npx vitest run tests/slack/escalationBlocks.test.ts`

### Step 3: Implement escalationBlocks.ts

Pure functions returning `KnownBlock[]`. Follow the pattern of `src/slack/blocks.ts`:
- Import `KnownBlock`, `SectionBlock`, `ActionsBlock` from `@slack/types`
- Each function takes structured data and returns blocks
- Escalation message includes: header with emoji, user question, channel info, stuck description, best guess, and action hint ("React with check or reply")

### Step 4: Run tests — verify they pass

Run: `npx vitest run tests/slack/escalationBlocks.test.ts`

### Step 5: Commit

```
feat(slack): add escalation Block Kit message builders
```

---

## Task 4: Escalation Decision Logic

**Files:**
- Create: `src/agents/escalationDecision.ts`
- Create: `tests/agents/escalationDecision.test.ts`

Pure function — no LLM call. Determines escalation behavior based on supervisor result.

### Step 1: Write tests

```typescript
interface EscalationDecision {
  shouldEscalate: boolean;
  behavior: 'best_effort_verify' | 'park_wait';
  trigger: 'supervisor_exhausted' | 'mid_pipeline_ambiguity';
}
```

Test cases:
1. Supervisor exhausted + primary confidence >= medium → `best_effort_verify`
2. Supervisor exhausted + primary confidence = low → `park_wait`
3. Supervisor passed → `shouldEscalate: false`
4. Supervisor fail_then_pass → `shouldEscalate: false`

### Step 2: Run tests — verify they fail

### Step 3: Implement

```typescript
export function decideEscalation(
  supervisorVerdict: 'pass' | 'fail_then_pass' | 'exhausted',
  primaryConfidence: 'high' | 'medium' | 'low',
): EscalationDecision {
  if (supervisorVerdict !== 'exhausted') {
    return { shouldEscalate: false, behavior: 'best_effort_verify', trigger: 'supervisor_exhausted' };
  }
  return {
    shouldEscalate: true,
    trigger: 'supervisor_exhausted',
    behavior: primaryConfidence === 'low' ? 'park_wait' : 'best_effort_verify',
  };
}
```

### Step 4: Run tests — verify they pass

### Step 5: Commit

```
feat(agents): add escalation decision logic
```

---

## Task 5: Pipeline Escalation Integration

**Files:**
- Modify: `src/pipeline.ts`
- Modify: `tests/pipeline.test.ts`

### Step 1: Write failing test

Add test case to `tests/pipeline.test.ts`:
- "supervisor exhausted with low confidence triggers park_wait escalation"
  - Mock supervisor loop to return `exhausted` with `finalConfidence: 'low'`
  - Assert: escalation state saved to Firestore, user message updated with "waiting for data team", no query execution
- "supervisor exhausted with medium confidence triggers best_effort_verify"
  - Mock supervisor loop to return `exhausted` with `finalConfidence: 'medium'`
  - Assert: query executed, result shown with caveat, escalation state saved

### Step 2: Run tests — verify they fail

### Step 3: Modify pipeline.ts

After the supervisor loop (currently ~line 157), add escalation decision:

```typescript
const escalationDecision = decideEscalation(supervised.verdict, supervised.sqlResult.confidence);

if (escalationDecision.shouldEscalate) {
  if (escalationDecision.behavior === 'park_wait') {
    // Post "waiting for data team" to user thread
    // Save escalation state to Firestore
    // Release thread lock
    // Return early (no execution)
    return;
  }
  // best_effort_verify: continue to execution, but also save escalation state
  // After execution + response, append caveat and post escalation
}
```

The escalation posting (to the escalation channel) requires `config.escalation`, which means `PipelineConfig` needs to be extended with escalation settings. Add:

```typescript
escalation?: {
  mode: 'channel' | 'dm';
  channelId?: string;
  analystUserId?: string;
  timeoutHours: number;
};
```

### Step 4: Run tests — verify they pass

Run: `npm test`

### Step 5: Commit

```
feat(pipeline): add escalation path after supervisor exhaustion
```

---

## Task 6: Shared preflightChecks Function

**Files:**
- Create: `src/handlers/preflightChecks.ts`
- Create: `tests/handlers/preflightChecks.test.ts`
- Modify: `src/handlers/mentions.ts` (use shared preflightChecks)
- Modify: `src/handlers/commands.ts` (use shared preflightChecks)
- Modify: `src/app.ts` message handler (use shared preflightChecks)

### Step 1: Write tests for preflightChecks

Test cases:
1. Lock acquired, no pending clarification, no pending escalation → returns `true`
2. Lock not acquired → posts "still working", returns `false`
3. Pending escalation (not expired) → posts "waiting for data team", releases lock, returns `false`
4. Pending escalation (expired) → marks as timed_out, returns `true`
5. Pending clarification (not expired) → releases lock, returns `false`

### Step 2: Run tests — verify they fail

### Step 3: Implement preflightChecks

```typescript
export async function preflightChecks(
  channel: string,
  threadTs: string,
  client: WebClient,
): Promise<boolean> {
  // 1. Thread lock
  const locked = await acquireThreadLock(threadTs);
  if (!locked) {
    await client.chat.postMessage({
      channel, thread_ts: threadTs,
      text: "I'm still working on your previous question...",
    });
    return false;
  }

  // 2. Pending clarification (existing pattern)
  if (await hasPendingClarification(threadTs)) {
    await releaseThreadLock(threadTs);
    return false;
  }

  // 3. Pending escalation (new)
  const escalation = await getEscalationByThread(threadTs);
  if (escalation) {
    await client.chat.postMessage({
      channel, thread_ts: threadTs,
      text: "I'm still waiting for the data team on your previous question. I'll reply here when I have an answer.",
    });
    await releaseThreadLock(threadTs);
    return false;
  }

  return true;
}
```

### Step 4: Update handlers to use preflightChecks

Replace inline lock acquisition in `mentions.ts`, `commands.ts`, and `app.ts` message handler with calls to `preflightChecks()`. This is a refactor that preserves existing behavior while adding escalation guards.

### Step 5: Run all tests

Run: `npm test`
Expected: All 203+ tests pass

### Step 6: Commit

```
refactor(handlers): extract shared preflightChecks with escalation guard
```

---

## Task 7: Escalation Response Handler

**Files:**
- Create: `src/handlers/escalationResponse.ts`
- Create: `tests/handlers/escalationResponse.test.ts`
- Modify: `src/app.ts` (register escalation message listener)

### Step 1: Write tests

Test cases:
1. Message in escalation thread matches pending escalation → loads state, returns resume context
2. Message in escalation thread with no matching escalation → returns null
3. Emoji reaction (checkmark) on escalation message → confirms best-effort answer
4. `resumeFromEscalation` — builds pipeline input from saved escalation context, calls `runPipeline`

### Step 2: Run tests — verify they fail

### Step 3: Implement escalation response handler

```typescript
// src/handlers/escalationResponse.ts
export async function checkEscalationResponse(
  event: { thread_ts?: string; text?: string; channel: string },
): Promise<EscalationResumeContext | null> {
  if (!event.thread_ts) return null;

  const state = await getEscalationByEscalationThread(event.thread_ts);
  if (!state) return null;

  return {
    escalationId: state.escalationId,
    originalChannel: state.originalChannel,
    originalThreadTs: state.originalThreadTs,
    statusMsgTs: state.statusMsgTs,
    humanGuidance: event.text || '',
    behavior: state.behavior,
    context: state.context,
    traceId: state.traceId,
  };
}
```

### Step 4: Wire into app.ts

In the `app.event('message', ...)` handler, add a check for escalation responses:
- Before the existing shouldRespond check, check if the message is in the escalation channel
- If so, call `checkEscalationResponse(event)` and handle resume

For `park_wait`: resume pipeline with human guidance injected into the question context. Post result to original thread.

For `best_effort_verify`: post human's confirmation/correction to original thread as a follow-up.

Both paths: call `resolveEscalation(escalationId)`.

### Step 5: Run tests — verify they pass

Run: `npm test`

### Step 6: Commit

```
feat(handlers): add escalation response handler with pipeline resumption
```

---

## Task 8: Escalation Reminders and Timeout

**Files:**
- Create: `src/handlers/escalationLifecycle.ts`
- Create: `tests/handlers/escalationLifecycle.test.ts`
- Modify: `src/app.ts` (call lifecycle check on events)

### Step 1: Write tests

Test cases:
1. `checkOverdueEscalations` — finds escalations past reminder interval, posts reminder, updates `lastReminderAt`
2. `checkOverdueEscalations` — skips escalations within reminder interval
3. `checkTimedOutEscalations` — finds expired escalations, posts timeout message to user thread, marks as `timed_out`
4. Timeout for `park_wait` — posts "couldn't get answer" message
5. Timeout for `best_effort_verify` — posts "data team hasn't weighed in" message

### Step 2: Run tests — verify they fail

### Step 3: Implement

```typescript
// src/handlers/escalationLifecycle.ts
export async function checkOverdueEscalations(
  client: WebClient,
  config: EscalationConfig,
): Promise<void> {
  // Query escalation_state where pipelineState == 'awaiting_human'
  // For each: check lastReminderAt vs reminderIntervalMinutes
  // If overdue: post reminder to escalation channel, update lastReminderAt
  // Also check expiresAt for timeout
}
```

Piggyback on existing event traffic: call `checkOverdueEscalations` inside the message event handler (after the main logic, non-blocking with `.catch()`). This avoids needing a separate cron.

### Step 4: Run tests — verify they pass

### Step 5: Commit

```
feat(handlers): add escalation reminder and timeout lifecycle
```

---

## Task 9: Persist retrievedSchema in Pipeline

**Files:**
- Modify: `src/pipeline.ts`
- Modify: `tests/pipeline.test.ts`

### Step 1: Write failing test

Add test assertion to the happy path integration test:
- After pipeline completes, check that the saved `ResponseContext` includes `retrievedSchema` with table names, descriptions, and column info matching the input tables.

### Step 2: Run test — verify it fails

### Step 3: Modify pipeline.ts

In the "Persist" stage (~line 227), add `retrievedSchema` to the ResponseContext being saved:

```typescript
const responseCtx: ResponseContext = {
  // ... existing fields ...
  retrievedSchema: tables.map(t => ({
    name: t.name,
    description: t.description,
    columns: t.columns.map(c => ({
      name: c.name,
      description: c.description,
      dataType: c.dataType,
    })),
  })),
};
```

### Step 4: Run tests — verify they pass

Run: `npm test`

### Step 5: Commit

```
feat(pipeline): persist retrievedSchema in ResponseContext
```

---

## Task 10: Show/Hide Reasoning Toggle

**Files:**
- Create: `src/slack/reasoningBlocks.ts`
- Create: `tests/slack/reasoningBlocks.test.ts`
- Modify: `src/slack/blocks.ts` (add reasoning button to feedback actions)
- Modify: `src/app.ts` (register `show_reasoning` / `hide_reasoning` action handlers)

### Step 1: Write tests

Test cases for `reasoningBlocks.ts`:
1. `buildReasoningBlocks` — given a ResponseContext, builds section blocks showing: tables used (with descriptions), filters applied, teachings referenced (from groundingCitations), supervisor assessment, confidence
2. `buildReasoningBlocks` — handles missing optional fields gracefully
3. `buildReasoningToggleButton` — returns actions block with `show_reasoning_{traceId}` action_id

Test cases for modified `blocks.ts`:
4. `buildFeedbackActions` now includes reasoning toggle button alongside thumbs up/down

### Step 2: Run tests — verify they fail

### Step 3: Implement

```typescript
// src/slack/reasoningBlocks.ts
export function buildReasoningBlocks(ctx: ResponseContext): KnownBlock[] {
  const blocks: KnownBlock[] = [];

  // Tables used
  blocks.push({
    type: 'section',
    text: { type: 'mrkdwn', text: `*Tables:* ${ctx.tablesUsed.join(', ')}` },
  });

  // Teachings referenced
  if (ctx.groundingCitations?.length) {
    const teachings = ctx.groundingCitations.map(c => c.sourceFile).join(', ');
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*Guided by:* ${teachings}` },
    });
  }

  // Supervisor assessment
  blocks.push({
    type: 'section',
    text: { type: 'mrkdwn', text: `*Review:* ${ctx.supervisorVerdict} — ${ctx.supervisorNotes}` },
  });

  // Confidence
  blocks.push({
    type: 'section',
    text: { type: 'mrkdwn', text: `*Confidence:* ${ctx.confidence}` },
  });

  // Hide button
  blocks.push({
    type: 'actions',
    elements: [{
      type: 'button',
      text: { type: 'plain_text', text: '🔍 Hide reasoning' },
      action_id: `hide_reasoning_${ctx.traceId}`,
      value: `${ctx.threadTs}_${ctx.statusMsgTs}`,
    }],
  });

  return blocks;
}
```

Modify `buildFeedbackActions` in `blocks.ts` to include the reasoning button:

```typescript
{
  type: 'button',
  text: { type: 'plain_text', text: '🔍 Reasoning' },
  action_id: `show_reasoning_${traceId}`,
  value: `${threadTs}_${statusMsgTs}`,
},
```

This means `buildFeedbackActions` needs `threadTs` and `statusMsgTs` parameters added. Update callers.

### Step 4: Wire action handlers in app.ts

```typescript
// Show reasoning
app.action(/^show_reasoning_/, async ({ action, body, client, ack }) => {
  await ack();
  const compoundKey = action.value; // "threadTs_statusMsgTs"
  const ctx = await getResponseContext(compoundKey);
  if (!ctx) return;

  const reasoningBlocks = buildReasoningBlocks(ctx);
  // Replace current message blocks, inserting reasoning before feedback actions
  await client.chat.update({
    channel: body.channel!.id,
    ts: body.message!.ts,
    blocks: [...existingContentBlocks, ...reasoningBlocks],
  });
});
```

### Step 5: Run tests — verify they pass

Run: `npm test`

### Step 6: Commit

```
feat(slack): add show/hide reasoning toggle with Block Kit actions
```

---

## Task 11: Response Override Buttons (Table, Summary, CSV)

**Files:**
- Create: `src/handlers/responseOverrides.ts`
- Create: `tests/handlers/responseOverrides.test.ts`
- Modify: `src/slack/blocks.ts` (add override buttons)
- Modify: `src/app.ts` (register action handlers)

### Step 1: Write tests

Test cases:
1. `handleTableOverride` — loads ResponseContext, re-executes query (BigQuery cache), formats as table blocks, updates message
2. `handleSummaryOverride` — loads ResponseContext, re-executes query, calls Flash to summarize, updates message
3. `handleCsvOverride` — loads ResponseContext, re-executes query, uploads CSV via `files.uploadV2`
4. `handleTableOverride` — when re-execution fails, posts error message

### Step 2: Run tests — verify they fail

### Step 3: Implement

Override buttons need to re-execute the query because result rows are NOT stored in ResponseContext (PII concern per design doc). BigQuery caches results for 24 hours, so re-execution of the same SQL is fast and free.

```typescript
// src/handlers/responseOverrides.ts
export async function handleTableOverride(
  compoundKey: string,
  channel: string,
  messageTs: string,
  client: WebClient,
): Promise<void> {
  const ctx = await getResponseContext(compoundKey);
  if (!ctx) return;

  // Re-execute the original query (BigQuery cache hit)
  const result = await executeQuery(ctx.generatedSql, ...);
  const tableBlocks = buildTableBlocks(result.rows, result.columnNames);

  await client.chat.update({
    channel, ts: messageTs,
    blocks: [...tableBlocks, buildFeedbackActions(ctx.traceId, ctx.threadTs, ctx.statusMsgTs)],
  });
}

export async function handleSummaryOverride(
  compoundKey: string,
  channel: string,
  messageTs: string,
  client: WebClient,
  apiKey: string,
): Promise<void> {
  // Show "Generating summary..." first
  await client.chat.update({ channel, ts: messageTs, text: 'Generating summary...' });

  const ctx = await getResponseContext(compoundKey);
  if (!ctx) return;

  const result = await executeQuery(ctx.generatedSql, ...);

  // Flash LLM call to summarize
  const ai = new GoogleGenAI({ apiKey });
  const response = await ai.models.generateContent({
    model: 'gemini-3.0-flash',
    contents: `Summarize these query results in plain language:\n${JSON.stringify(result.rows.slice(0, 50))}`,
  });

  await client.chat.update({
    channel, ts: messageTs,
    text: response.text,
    blocks: [{ type: 'section', text: { type: 'mrkdwn', text: response.text } },
             buildFeedbackActions(ctx.traceId, ctx.threadTs, ctx.statusMsgTs)],
  });
}

export async function handleCsvOverride(
  compoundKey: string,
  channel: string,
  threadTs: string,
  client: WebClient,
): Promise<void> {
  const ctx = await getResponseContext(compoundKey);
  if (!ctx) return;

  const result = await executeQuery(ctx.generatedSql, ...);

  // Build CSV string
  const header = result.columnNames.join(',');
  const rows = result.rows.map(r =>
    result.columnNames.map(c => JSON.stringify(String(r[c] ?? ''))).join(',')
  );
  const csv = [header, ...rows].join('\n');

  await client.filesUploadV2({
    channel_id: channel,
    thread_ts: threadTs,
    content: csv,
    filename: 'query_results.csv',
    title: 'Query Results',
  });
}
```

### Step 4: Add override buttons to blocks.ts

Add to the actions block returned by `buildFeedbackActions`:

```typescript
{ type: 'button', text: { type: 'plain_text', text: '📋 Table' },
  action_id: `override_table_${traceId}`, value: compoundKey },
{ type: 'button', text: { type: 'plain_text', text: '📝 Summary' },
  action_id: `override_summary_${traceId}`, value: compoundKey },
{ type: 'button', text: { type: 'plain_text', text: '⬇️ CSV' },
  action_id: `override_csv_${traceId}`, value: compoundKey },
```

### Step 5: Wire action handlers in app.ts

Register `override_table_`, `override_summary_`, `override_csv_` action handlers.

### Step 6: Run tests — verify they pass

Run: `npm test`

### Step 7: Commit

```
feat(handlers): add response override buttons (Table, Summary, CSV)
```

---

## Task 12: Meta-Question Handler

**Files:**
- Create: `src/agents/metaQuestionHandler.ts`
- Create: `tests/agents/metaQuestionHandler.test.ts`

### Step 1: Write tests

Test cases:
1. "Why did you use fct_orders?" — loads ResponseContext with retrievedSchema, calls Flash, returns plain-language explanation mentioning the table description
2. "What does completed mean?" — returns explanation referencing reasoning chain and teachings
3. Returns explanation even when groundingCitations is empty (no teachings)
4. Throws on empty ResponseContext

### Step 2: Run tests — verify they fail

### Step 3: Implement

```typescript
// src/agents/metaQuestionHandler.ts
export async function handleMetaQuestion(
  followUpQuestion: string,
  ctx: ResponseContext,
  apiKey: string,
): Promise<string> {
  const ai = new GoogleGenAI({ apiKey });

  const schemaContext = ctx.retrievedSchema?.map(t =>
    `Table: ${t.name}\nDescription: ${t.description}\nColumns: ${t.columns.map(c => `${c.name} (${c.dataType}): ${c.description}`).join(', ')}`
  ).join('\n\n') || 'No schema context available';

  const citationsContext = ctx.groundingCitations?.map(c =>
    `Teaching: ${c.sourceFile}\n${c.chunkText}`
  ).join('\n\n') || 'No teachings referenced';

  const prompt = `You are explaining your previous data analysis to a business user.

YOUR PREVIOUS RESPONSE:
Question: ${ctx.clarifiedQuestion}
SQL: ${ctx.generatedSql}
Assumptions: ${ctx.assumptions.join(', ')}
Reasoning: ${ctx.reasoningChain}
Supervisor: ${ctx.supervisorNotes}

TABLES YOU CONSIDERED:
${schemaContext}

TEACHINGS REFERENCED:
${citationsContext}

USER FOLLOW-UP: ${followUpQuestion}

Explain in plain language. Be specific about WHY you chose the tables you used and WHY you did NOT use others. Reference dbt descriptions and teachings.`;

  const response = await ai.models.generateContent({
    model: 'gemini-3.0-flash',
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
  });

  if (!response.text) throw new Error('Empty response from Gemini');
  return response.text;
}
```

### Step 4: Run tests — verify they pass

### Step 5: Commit

```
feat(agents): add meta-question handler using Flash LLM
```

---

## Task 13: Refinement Handler

**Files:**
- Create: `src/agents/refinementHandler.ts`
- Create: `tests/agents/refinementHandler.test.ts`

### Step 1: Write tests

Test cases:
1. `buildRefinementInput` — given previous ResponseContext + "break down by region", constructs composite question and pipeline input with previous SQL as hint
2. Composite question merges original + refinement: "Show me revenue (Refinement: break down by region)"
3. `previousAttempt` is set with original SQL (not as an error, but as a starting point)

### Step 2: Run tests — verify they fail

### Step 3: Implement

```typescript
// src/agents/refinementHandler.ts
export function buildRefinementInput(
  refinementText: string,
  previousCtx: ResponseContext,
): { compositeQuestion: string; previousSql: string } {
  const compositeQuestion = `${previousCtx.clarifiedQuestion}\n\nRefinement: ${refinementText}`;
  return {
    compositeQuestion,
    previousSql: previousCtx.generatedSql,
  };
}
```

The actual pipeline re-run happens in the handler wiring (Task 16). This module just prepares the input.

The `previousAttempt` in `GenerateSqlOptions` needs a new flavor — currently it's `{ sql, error }` which implies failure. For refinements, we need `{ sql, refinement }` to indicate a starting point, not an error. Modify the system prompt builder in `sqlGenerator.ts` to handle this:

```typescript
// In buildSystemPrompt():
if (opts.previousAttempt?.refinement) {
  sections.push(`PREVIOUS SQL (user wants a modification):\n${opts.previousAttempt.sql}\n\nUse as a starting point. Generate a complete new query incorporating the refinement.`);
}
```

### Step 4: Run tests — verify they pass

### Step 5: Commit

```
feat(agents): add refinement handler with composite question builder
```

---

## Task 14: Discrepancy Investigation Handler

**Files:**
- Create: `src/agents/discrepancyHandler.ts`
- Create: `tests/agents/discrepancyHandler.test.ts`

### Step 1: Write tests

Test cases:
1. `generateDiagnosticSql` — given ResponseContext + discrepancy text, calls Gemini Pro with diagnostic instructions, returns structured output with diagnostic SQL + explanation
2. Uses the original SQL and result metadata as context
3. Returns structured output with `diagnosticSql`, `explanation`, `investigationPlan`

### Step 2: Run tests — verify they fail

### Step 3: Implement

```typescript
// src/agents/discrepancyHandler.ts
export async function generateDiagnosticSql(
  discrepancyText: string,
  ctx: ResponseContext,
  apiKey: string,
): Promise<{ diagnosticSql: string; explanation: string }> {
  const ai = new GoogleGenAI({ apiKey });

  const prompt = `You are investigating a data discrepancy reported by a business user.

ORIGINAL QUESTION: ${ctx.clarifiedQuestion}
ORIGINAL SQL: ${ctx.generatedSql}
ORIGINAL RESULTS: ${ctx.queryResults.rowCount} rows, columns: ${ctx.queryResults.columnNames.join(', ')}

USER'S CONCERN: ${discrepancyText}

Generate a diagnostic SQL query to investigate. Consider:
- Break down the original query by the dimension in question
- Check for filter effects (how many rows excluded)
- Look for data gaps (NULL values, missing dates)`;

  const response = await ai.models.generateContent({
    model: 'gemini-3.0-pro',
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    config: {
      responseMimeType: 'application/json',
      responseJsonSchema: toJSONSchema(DiagnosticSchema),
    },
  });

  return JSON.parse(response.text);
}
```

The diagnostic SQL goes through the validation pipeline (L1-L4) and a lightweight supervisor review (single call with reduced prompt) before execution. This wiring happens in Task 16.

### Step 4: Run tests — verify they pass

### Step 5: Commit

```
feat(agents): add discrepancy investigation handler
```

---

## Task 15: getResponseContext Function

**Files:**
- Modify: `src/state/responseContext.ts`
- Modify: `tests/state/responseContext.test.ts`

### Step 1: Write failing test

Test cases:
1. `getResponseContext(compoundKey)` — returns full ResponseContext for existing document
2. `getResponseContext(compoundKey)` — returns null for non-existent document
3. `getLatestResponseContext(threadTs)` — returns most recent ResponseContext for a thread (needed for meta-questions, refinements, discrepancies where we don't have the exact `statusMsgTs`)

### Step 2: Run tests — verify they fail

### Step 3: Implement

```typescript
export async function getResponseContext(compoundKey: string): Promise<ResponseContext | null> {
  const doc = await getDb().collection('response_context').doc(compoundKey).get();
  if (!doc.exists) return null;
  return doc.data() as ResponseContext;
}

export async function getLatestResponseContext(threadTs: string): Promise<ResponseContext | null> {
  const snapshot = await getDb().collection('response_context')
    .where('threadTs', '==', threadTs)
    .orderBy('createdAt', 'desc')
    .limit(1)
    .get();
  if (snapshot.empty) return null;
  return snapshot.docs[0].data() as ResponseContext;
}
```

### Step 4: Run tests — verify they pass

### Step 5: Commit

```
feat(state): add getResponseContext and getLatestResponseContext
```

---

## Task 16: Follow-Up Intent Routing

**Files:**
- Modify: `src/pipeline.ts` or create `src/handlers/followUpRouter.ts`
- Modify: `src/app.ts` (message handler)
- Create: `tests/handlers/followUpRouter.test.ts`

This task wires the follow-up intent classifier (already exists in `src/agents/followUpClassifier.ts`) to the handlers built in Tasks 12-14.

### Step 1: Write tests

Test cases:
1. `routeFollowUp` with intent `meta_question` — calls `handleMetaQuestion`, posts Flash response to thread
2. `routeFollowUp` with intent `refinement` — calls `buildRefinementInput`, runs pipeline with composite question and previous SQL hint
3. `routeFollowUp` with intent `discrepancy` — calls `generateDiagnosticSql`, validates, executes, presents findings
4. `routeFollowUp` with intent `new_query` — runs standard pipeline (existing behavior)

### Step 2: Run tests — verify they fail

### Step 3: Implement follow-up router

```typescript
// src/handlers/followUpRouter.ts
export async function routeFollowUp(
  intent: FollowUpIntent,
  message: string,
  threadTs: string,
  channel: string,
  statusMsgTs: string,
  client: WebClient,
  config: PipelineConfig,
  tables: TableContext[],
): Promise<void> {
  switch (intent) {
    case 'meta_question': {
      const ctx = await getLatestResponseContext(threadTs);
      if (!ctx) { /* post "no previous context" message */ return; }
      const answer = await handleMetaQuestion(message, ctx, config.geminiApiKey);
      await client.chat.update({ channel, ts: statusMsgTs, text: answer });
      break;
    }
    case 'refinement': {
      const ctx = await getLatestResponseContext(threadTs);
      if (!ctx) return;
      const { compositeQuestion, previousSql } = buildRefinementInput(message, ctx);
      await runPipeline({
        question: compositeQuestion,
        channel, threadTs, statusMsgTs, client, tables, config,
        // Pass previous SQL as hint via previousAttempt with refinement flag
      });
      break;
    }
    case 'discrepancy': {
      const ctx = await getLatestResponseContext(threadTs);
      if (!ctx) return;
      await client.chat.update({ channel, ts: statusMsgTs, text: 'Investigating...' });
      const diagnostic = await generateDiagnosticSql(message, ctx, config.geminiApiKey);
      // Validate diagnostic SQL through L1-L4
      // Execute
      // Lightweight supervisor review
      // Format and present findings
      break;
    }
    case 'new_query':
    default:
      await runPipeline({ question: message, channel, threadTs, statusMsgTs, client, tables, config });
  }
}
```

### Step 4: Wire into message handler in app.ts

In the message event handler, after `shouldRespond` check and before pipeline run:
- If the message is in a thread with a previous bot response, classify follow-up intent
- Route to `routeFollowUp`

```typescript
// In app.ts message handler, after shouldRespond check:
if (event.thread_ts) {
  const threadContext = await buildThreadContext(...);
  const { intent } = await classifyFollowUp(event.text, threadContext, config.gemini.apiKey);
  if (intent !== 'new_query') {
    await routeFollowUp(intent, event.text, threadTs, event.channel, statusMsgTs, client, pipelineConfig, tables);
    return;
  }
}
// Fall through to standard pipeline for new_query
```

### Step 5: Run all tests

Run: `npm test`
Expected: All tests pass

### Step 6: Commit

```
feat(handlers): add follow-up intent routing for meta-questions, refinements, and discrepancies
```

---

## Task 17: Escalation Integration Test

**Files:**
- Modify: `tests/integration/pipeline.integration.test.ts`

### Step 1: Add escalation integration test

Test: "supervisor exhausted with park_wait escalation suspends pipeline"
- Configure pipeline with escalation config
- Mock supervisor to return `exhausted` with `finalConfidence: 'low'`
- Assert: no query execution, escalation state saved to Firestore, user message updated with "waiting for data team" text

Test: "supervisor exhausted with best_effort_verify shows result with caveat"
- Configure with escalation config
- Mock supervisor to return `exhausted` with `finalConfidence: 'medium'`
- Assert: query executed, result shown with caveat text, escalation state saved

### Step 2: Run tests — verify they pass

Run: `npx vitest run tests/integration/pipeline.integration.test.ts`

### Step 3: Commit

```
test(integration): add escalation flow integration tests
```

---

## Task 18: Follow-Up Flow Integration Test

**Files:**
- Modify: `tests/integration/pipeline.integration.test.ts` or create `tests/integration/followUp.integration.test.ts`

### Step 1: Add follow-up integration tests

Test: "meta-question loads ResponseContext and answers via Flash"
- Pre-populate Firestore with a ResponseContext (including retrievedSchema)
- Mock follow-up classifier to return `meta_question`
- Mock Flash response
- Assert: Flash called with ResponseContext content, response posted to thread, no SQL generation

Test: "refinement re-runs pipeline with composite question"
- Pre-populate Firestore with ResponseContext
- Mock classifier to return `refinement`
- Mock full pipeline (clarification + SQL gen + supervisor + execution)
- Assert: SQL generation prompt includes previous SQL as starting point

### Step 2: Run tests — verify they pass

Run: `npm test`

### Step 3: Commit

```
test(integration): add follow-up flow integration tests (meta-question, refinement)
```

---

## Final Verification

After all 18 tasks:

```bash
npm run typecheck    # No type errors
npm test             # All tests pass (203 existing + ~40-50 new)
```

## Summary

| # | Task | Files | Tests |
|---|------|-------|-------|
| 1 | Escalation types + config | types.ts, config.ts | typecheck |
| 2 | Escalation state module | state/escalationState.ts | 7 tests |
| 3 | Escalation Block Kit | slack/escalationBlocks.ts | 6 tests |
| 4 | Escalation decision logic | agents/escalationDecision.ts | 4 tests |
| 5 | Pipeline escalation path | pipeline.ts | 2 tests |
| 6 | Shared preflightChecks | handlers/preflightChecks.ts | 5 tests |
| 7 | Escalation response handler | handlers/escalationResponse.ts | 4 tests |
| 8 | Reminders + timeout | handlers/escalationLifecycle.ts | 5 tests |
| 9 | Persist retrievedSchema | pipeline.ts | 1 test |
| 10 | Show/Hide reasoning toggle | slack/reasoningBlocks.ts | 4 tests |
| 11 | Response override buttons | handlers/responseOverrides.ts | 4 tests |
| 12 | Meta-question handler | agents/metaQuestionHandler.ts | 4 tests |
| 13 | Refinement handler | agents/refinementHandler.ts | 3 tests |
| 14 | Discrepancy handler | agents/discrepancyHandler.ts | 3 tests |
| 15 | getResponseContext | state/responseContext.ts | 3 tests |
| 16 | Follow-up routing | handlers/followUpRouter.ts | 4 tests |
| 17 | Escalation integration test | integration/ | 2 tests |
| 18 | Follow-up integration test | integration/ | 2 tests |
