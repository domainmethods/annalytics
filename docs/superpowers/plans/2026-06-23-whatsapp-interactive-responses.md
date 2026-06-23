# WhatsApp Interactive Responses Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add WhatsApp-native interactive answer controls for feedback, reasoning, SQL visibility, and table/summary views while preserving the gated WhatsApp prototype boundary.

**Architecture:** Use official WhatsApp Cloud API reply buttons and list messages, with short action IDs backed by a TTL'd Firestore action-context collection. Keep WhatsApp interaction builders and handlers under `src/whatsapp/`; reuse `response_context` as the backing record and avoid Slack Block Kit abstractions. Negative feedback is record-only in this slice; WhatsApp-origin analyst escalation remains out of scope.

**Tech Stack:** TypeScript, Express webhook routing, Meta WhatsApp Cloud API `/messages`, Firestore state modules, Vitest, existing BigQuery validation/execution helpers, existing Gemini `generateForNode('summaryOverride', ...)`.

---

## Scope Decisions From The Design

- Implement `whatsapp_action_context` from the start. This avoids relying on long Meta action IDs that include encoded WhatsApp message IDs.
- Implement `whatsapp_pending_feedback_notes` for `Problem -> Other` free-text capture.
- Do not implement WhatsApp-origin Slack analyst escalation.
- Do not implement CSV/document export.
- Do not add `sendInteractive` to the generic `ChannelClient`; keep it WhatsApp-specific.
- Do not change Slack interactivity.

## File Structure

- `src/state/responseContext.ts`
  - Export response-context document-key helper.
  - Add feedback update by document key.

- `src/state/whatsappActionContext.ts` (new)
  - Create and load short-lived action contexts.
  - Stores `kind`, `responseContextKey`, `conversationId`, `userId`, and TTL.

- `src/state/whatsappPendingFeedback.ts` (new)
  - Store, load, and clear the "next WhatsApp text is feedback note" state.

- `src/whatsapp/actionIds.ts` (new)
  - Validate and build compact `wa:v1:<kind>:<contextId>` action IDs.

- `src/whatsapp/interactive.ts` (new)
  - WhatsApp-specific reply-button/list message types and builders.

- `src/whatsapp/client.ts`
  - Return a concrete WhatsApp client with `sendText` and `sendInteractive`.

- `src/whatsapp/payload.ts`
  - Parse WhatsApp `interactive.button_reply` and `interactive.list_reply` webhook messages.

- `src/whatsapp/webhook.ts`
  - Route parsed actions to a new action handler.

- `src/whatsapp/actions.ts` (new)
  - Dispatch action IDs, load context, record feedback, render details, and send follow-ups.

- `src/whatsapp/overrides.ts` (new)
  - Re-execute persisted SQL safely for table/summary follow-ups.

- `src/execution/overrideTypes.ts` (new)
  - Own the shared override execution config type used by Slack and WhatsApp override paths.

- `src/whatsapp/renderer.ts`
  - Add reasoning, SQL, and feedback-note acknowledgement renderers.

- `src/whatsapp/pipeline.ts`
  - Send the interactive answer-control prompt after answer context persistence.

- `src/whatsapp/messages.ts`
  - Capture pending WhatsApp free-text feedback before normal pipeline execution.

- `infra/firestore.ttls.json`
  - Add TTL entries for `whatsapp_action_context` and `whatsapp_pending_feedback_notes`.

- Tests:
  - `tests/state/responseContext.test.ts`
  - `tests/state/whatsappActionContext.test.ts`
  - `tests/state/whatsappPendingFeedback.test.ts`
  - `tests/whatsapp/actionIds.test.ts`
  - `tests/whatsapp/interactive.test.ts`
  - `tests/whatsapp/client.test.ts`
  - `tests/whatsapp/payload.test.ts`
  - `tests/whatsapp/webhook.test.ts`
  - `tests/whatsapp/actions.test.ts`
  - `tests/whatsapp/pipeline.test.ts`
  - `tests/whatsapp/messages.test.ts`
  - `tests/whatsapp/renderer.test.ts`
  - `tests/infra/firestoreTtls.test.ts`

---

### Task 1: Response Context Keys And Action Context State

**Files:**
- Modify: `src/state/responseContext.ts`
- Create: `src/state/whatsappActionContext.ts`
- Modify: `infra/firestore.ttls.json`
- Test: `tests/state/responseContext.test.ts`
- Test: `tests/state/whatsappActionContext.test.ts`
- Test: `tests/infra/firestoreTtls.test.ts`

- [ ] **Step 1: Add failing response-context key and feedback tests**

Add these tests to `tests/state/responseContext.test.ts` or the existing response-context test file that already mocks Firestore:

```typescript
import {
  recordFeedbackByResponseContextKey,
  responseContextDocumentId,
} from '../../src/state/responseContext.js';

it('exports the encoded WhatsApp response context document id', () => {
  expect(responseContextDocumentId({
    surface: 'whatsapp',
    responseId: 'trace-1',
    threadTs: 'whatsapp:15551234567',
    statusMsgTs: 'wamid.outbound/A+B=',
    clarifiedQuestion: 'What was revenue?',
    assumptions: [],
    reasoningChain: '',
    generatedSql: 'SELECT 1',
    explanation: 'Revenue was 1.',
    tablesUsed: [],
    confidence: 'high',
    clarificationConfidence: 'high',
    primaryAgentConfidence: 'high',
    queryResults: { rowCount: 1, columnNames: ['revenue'], bytesProcessed: 0 },
    pipelineDurationMs: 10,
    traceId: 'trace-1',
    createdAt: new Date('2026-06-23T00:00:00.000Z'),
    groundingCitations: [],
    teachingsUsed: [],
  })).toBe('whatsapp:15551234567_wamid.outbound%2FA%2BB%3D');
});

it('records feedback by persisted response context document key', async () => {
  await recordFeedbackByResponseContextKey('whatsapp:15551234567_wamid.outbound%2FA%2BB%3D', 'negative');

  expect(mockCollection).toHaveBeenCalledWith('response_context');
  expect(mockDoc).toHaveBeenCalledWith('whatsapp:15551234567_wamid.outbound%2FA%2BB%3D');
  expect(mockUpdate).toHaveBeenCalledWith({ negativeFeedback: true });
});
```

If the test file uses different mock names, adapt the assertions to the existing Firestore mock variables in that file.

- [ ] **Step 2: Run the failing response-context tests**

Run:

```bash
npx vitest run tests/state/responseContext.test.ts tests/state/responseContext.feedback.test.ts
```

Expected: FAIL because `responseContextDocumentId` and `recordFeedbackByResponseContextKey` are not exported.

- [ ] **Step 3: Implement response-context helpers**

In `src/state/responseContext.ts`, export the existing document-id helper and add key-based feedback recording:

```typescript
export function responseContextDocumentId(ctx: ResponseContext): string {
  if (ctx.surface === 'whatsapp') {
    return `${ctx.threadTs}_${encodeURIComponent(ctx.statusMsgTs)}`;
  }
  return `${ctx.threadTs}_${ctx.statusMsgTs}`;
}

export async function saveResponseContext(ctx: ResponseContext): Promise<void> {
  const now = new Date();
  await getDb()
    .collection('response_context')
    .doc(responseContextDocumentId(ctx))
    .set({
      ...ctx,
      createdAt: now,
      expiresAt: new Date(now.getTime() + RETENTION_DAYS * 86_400_000),
    });
}

export async function recordFeedbackByResponseContextKey(
  responseContextKey: string,
  feedbackType: 'positive' | 'negative',
): Promise<void> {
  await getDb()
    .collection('response_context')
    .doc(responseContextKey)
    .update({
      negativeFeedback: feedbackType === 'negative',
    });
}
```

Remove or replace the old private `responseContextDocId` function. Keep `recordFeedback(threadTs, messageTs, feedbackType)` unchanged for Slack.

- [ ] **Step 4: Add failing action-context state tests**

Create `tests/state/whatsappActionContext.test.ts`:

```typescript
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockSet = vi.fn();
const mockGet = vi.fn();
const mockDoc = vi.fn(() => ({ set: mockSet, get: mockGet }));
const mockCollection = vi.fn(() => ({ doc: mockDoc }));

vi.mock('../../src/state/firestore.js', () => ({
  getDb: vi.fn(() => ({ collection: mockCollection })),
}));

import {
  createWhatsAppActionContext,
  getWhatsAppActionContext,
} from '../../src/state/whatsappActionContext.js';

describe('whatsappActionContext', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSet.mockResolvedValue(undefined);
  });

  it('stores action context with a generated id and ttl', async () => {
    const id = await createWhatsAppActionContext({
      idFactory: () => 'ctx_123',
      kind: 'show_sql',
      responseContextKey: 'whatsapp:15551234567_wamid.1',
      conversationId: 'whatsapp:15551234567',
      userId: '15551234567',
    });

    expect(id).toBe('ctx_123');
    expect(mockCollection).toHaveBeenCalledWith('whatsapp_action_context');
    expect(mockDoc).toHaveBeenCalledWith('ctx_123');
    expect(mockSet).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'show_sql',
      responseContextKey: 'whatsapp:15551234567_wamid.1',
      conversationId: 'whatsapp:15551234567',
      userId: '15551234567',
      createdAt: expect.any(Date),
      expiresAt: expect.any(Date),
    }));
  });

  it('returns null when the action context doc is missing', async () => {
    mockGet.mockResolvedValue({ exists: false });

    await expect(getWhatsAppActionContext('ctx_missing')).resolves.toBeNull();
  });

  it('loads stored action context and converts Firestore timestamps', async () => {
    const createdAt = new Date('2026-06-23T01:00:00.000Z');
    const expiresAt = new Date('2026-06-24T01:00:00.000Z');
    mockGet.mockResolvedValue({
      exists: true,
      id: 'ctx_123',
      data: () => ({
        kind: 'show_reasoning',
        responseContextKey: 'key-1',
        conversationId: 'whatsapp:15551234567',
        userId: '15551234567',
        createdAt: { toDate: () => createdAt },
        expiresAt: { toDate: () => expiresAt },
      }),
    });

    await expect(getWhatsAppActionContext('ctx_123')).resolves.toEqual({
      id: 'ctx_123',
      kind: 'show_reasoning',
      responseContextKey: 'key-1',
      conversationId: 'whatsapp:15551234567',
      userId: '15551234567',
      createdAt,
      expiresAt,
    });
  });
});
```

- [ ] **Step 5: Run the failing action-context tests**

Run:

```bash
npx vitest run tests/state/whatsappActionContext.test.ts
```

Expected: FAIL because `src/state/whatsappActionContext.ts` does not exist.

- [ ] **Step 6: Implement action-context state**

Create `src/state/whatsappActionContext.ts`:

```typescript
import { randomUUID } from 'node:crypto';
import { getDb } from './firestore.js';

const COLLECTION = 'whatsapp_action_context';
const RETENTION_MS = 24 * 60 * 60 * 1000;

type FirestoreTimestamp = { toDate: () => Date };

export interface CreateWhatsAppActionContextInput {
  kind: string;
  responseContextKey: string;
  conversationId: string;
  userId: string;
  idFactory?: () => string;
}

export interface StoredWhatsAppActionContext {
  id: string;
  kind: string;
  responseContextKey: string;
  conversationId: string;
  userId: string;
  createdAt: Date;
  expiresAt: Date;
}

function toDate(value: Date | FirestoreTimestamp | undefined): Date | undefined {
  if (value === undefined) return undefined;
  return value instanceof Date ? value : value.toDate();
}

export async function createWhatsAppActionContext(
  input: CreateWhatsAppActionContextInput,
): Promise<string> {
  const id = input.idFactory?.() ?? randomUUID();
  const now = new Date();
  await getDb()
    .collection(COLLECTION)
    .doc(id)
    .set({
      kind: input.kind,
      responseContextKey: input.responseContextKey,
      conversationId: input.conversationId,
      userId: input.userId,
      createdAt: now,
      expiresAt: new Date(now.getTime() + RETENTION_MS),
    });
  return id;
}

export async function getWhatsAppActionContext(
  id: string,
): Promise<StoredWhatsAppActionContext | null> {
  const doc = await getDb().collection(COLLECTION).doc(id).get();
  if (!doc.exists) return null;
  const data = doc.data() as Record<string, unknown>;
  return {
    id: doc.id,
    kind: String(data.kind),
    responseContextKey: String(data.responseContextKey),
    conversationId: String(data.conversationId),
    userId: String(data.userId),
    createdAt: toDate(data.createdAt as Date | FirestoreTimestamp)!,
    expiresAt: toDate(data.expiresAt as Date | FirestoreTimestamp)!,
  };
}
```

- [ ] **Step 7: Add TTL manifest coverage**

Update `infra/firestore.ttls.json` by appending:

```json
{ "collectionGroup": "whatsapp_action_context", "field": "expiresAt" }
```

Update `tests/infra/firestoreTtls.test.ts` expected array to include:

```typescript
{ collectionGroup: 'whatsapp_action_context', field: 'expiresAt' },
```

Do not add `feedback_notes`; it remains human-drained and intentionally absent.

- [ ] **Step 8: Verify Task 1 tests pass**

Run:

```bash
npx vitest run tests/state/responseContext.test.ts tests/state/responseContext.feedback.test.ts tests/state/whatsappActionContext.test.ts tests/infra/firestoreTtls.test.ts
```

Expected: PASS.

- [ ] **Step 9: Commit Task 1**

```bash
git add src/state/responseContext.ts src/state/whatsappActionContext.ts infra/firestore.ttls.json tests/state/responseContext.test.ts tests/state/responseContext.feedback.test.ts tests/state/whatsappActionContext.test.ts tests/infra/firestoreTtls.test.ts
git commit -m "feat: add whatsapp action context state"
```

---

### Task 2: WhatsApp Action IDs, Interactive Builders, And Client Sends

**Files:**
- Create: `src/whatsapp/actionIds.ts`
- Create: `src/whatsapp/interactive.ts`
- Modify: `src/whatsapp/client.ts`
- Test: `tests/whatsapp/actionIds.test.ts`
- Test: `tests/whatsapp/interactive.test.ts`
- Test: `tests/whatsapp/client.test.ts`

- [ ] **Step 1: Write failing action-id tests**

Create `tests/whatsapp/actionIds.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { buildWhatsAppActionId, parseWhatsAppActionId } from '../../src/whatsapp/actionIds.js';

describe('whatsapp action ids', () => {
  it('builds compact versioned action ids', () => {
    expect(buildWhatsAppActionId('show_sql', 'ctx_123')).toBe('wa:v1:show_sql:ctx_123');
  });

  it('parses valid ids', () => {
    expect(parseWhatsAppActionId('wa:v1:override_summary:ctx_456')).toEqual({
      kind: 'override_summary',
      contextId: 'ctx_456',
    });
  });

  it('rejects unknown action kinds', () => {
    expect(parseWhatsAppActionId('wa:v1:delete_everything:ctx_456')).toBeNull();
  });

  it('rejects malformed ids', () => {
    expect(parseWhatsAppActionId('show_sql:ctx_456')).toBeNull();
    expect(parseWhatsAppActionId('wa:v2:show_sql:ctx_456')).toBeNull();
    expect(parseWhatsAppActionId('wa:v1:show_sql:')).toBeNull();
  });
});
```

- [ ] **Step 2: Run action-id tests to verify failure**

Run:

```bash
npx vitest run tests/whatsapp/actionIds.test.ts
```

Expected: FAIL because `src/whatsapp/actionIds.ts` does not exist.

- [ ] **Step 3: Implement action IDs**

Create `src/whatsapp/actionIds.ts`:

```typescript
export const WHATSAPP_ACTION_KINDS = [
  'ok',
  'problem',
  'actions',
  'reason_wrong_number',
  'reason_wrong_data',
  'reason_not_asked',
  'reason_other',
  'show_reasoning',
  'show_sql',
  'override_table',
  'override_summary',
] as const;

export type WhatsAppActionKind = typeof WHATSAPP_ACTION_KINDS[number];

const KIND_SET = new Set<string>(WHATSAPP_ACTION_KINDS);

export function buildWhatsAppActionId(kind: WhatsAppActionKind, contextId: string): string {
  return `wa:v1:${kind}:${contextId}`;
}

export function parseWhatsAppActionId(
  value: string,
): { kind: WhatsAppActionKind; contextId: string } | null {
  const parts = value.split(':');
  if (parts.length !== 4) return null;
  const [prefix, version, rawKind, contextId] = parts;
  if (prefix !== 'wa' || version !== 'v1' || !KIND_SET.has(rawKind) || !contextId) {
    return null;
  }
  return { kind: rawKind as WhatsAppActionKind, contextId };
}
```

- [ ] **Step 4: Write failing interactive builder tests**

Create `tests/whatsapp/interactive.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import {
  buildAnswerActionsList,
  buildAnswerFeedbackButtons,
  buildProblemReasonPicker,
} from '../../src/whatsapp/interactive.js';

describe('whatsapp interactive builders', () => {
  it('builds the top-level answer feedback buttons', () => {
    expect(buildAnswerFeedbackButtons({
      okId: 'wa:v1:ok:ctx_ok',
      problemId: 'wa:v1:problem:ctx_problem',
      actionsId: 'wa:v1:actions:ctx_actions',
    })).toEqual({
      kind: 'reply_buttons',
      body: 'Was this answer useful?',
      buttons: [
        { id: 'wa:v1:ok:ctx_ok', title: 'Looks right' },
        { id: 'wa:v1:problem:ctx_problem', title: 'Problem' },
        { id: 'wa:v1:actions:ctx_actions', title: 'Actions' },
      ],
    });
  });

  it('builds a problem reason list with four rows', () => {
    const message = buildProblemReasonPicker({
      wrongNumberId: 'wa:v1:reason_wrong_number:ctx_1',
      wrongDataId: 'wa:v1:reason_wrong_data:ctx_2',
      notAskedId: 'wa:v1:reason_not_asked:ctx_3',
      otherId: 'wa:v1:reason_other:ctx_4',
    });

    expect(message.kind).toBe('list');
    expect(message.buttonText).toBe('Choose reason');
    expect(message.sections[0].rows.map(row => row.title)).toEqual([
      'Wrong number',
      'Wrong data',
      'Not my question',
      'Other',
    ]);
  });

  it('suppresses table and summary actions for single-scalar answers', () => {
    const message = buildAnswerActionsList({
      showReasoningId: 'wa:v1:show_reasoning:ctx_1',
      showSqlId: 'wa:v1:show_sql:ctx_2',
      tableId: 'wa:v1:override_table:ctx_3',
      summaryId: 'wa:v1:override_summary:ctx_4',
      rowCount: 1,
      columnCount: 1,
    });

    expect(message.sections[0].rows.map(row => row.title)).toEqual([
      'Show reasoning',
      'Show SQL',
    ]);
  });

  it('includes table and summary actions for table-shaped answers', () => {
    const message = buildAnswerActionsList({
      showReasoningId: 'wa:v1:show_reasoning:ctx_1',
      showSqlId: 'wa:v1:show_sql:ctx_2',
      tableId: 'wa:v1:override_table:ctx_3',
      summaryId: 'wa:v1:override_summary:ctx_4',
      rowCount: 25,
      columnCount: 4,
    });

    expect(message.sections[0].rows.map(row => row.title)).toEqual([
      'Show reasoning',
      'Show SQL',
      'Table view',
      'Summary view',
    ]);
  });
});
```

- [ ] **Step 5: Run interactive builder tests to verify failure**

Run:

```bash
npx vitest run tests/whatsapp/interactive.test.ts
```

Expected: FAIL because `src/whatsapp/interactive.ts` does not exist.

- [ ] **Step 6: Implement interactive builders**

Create `src/whatsapp/interactive.ts`:

```typescript
export interface WhatsAppReplyButton {
  id: string;
  title: string;
}

export interface WhatsAppListRow {
  id: string;
  title: string;
  description?: string;
}

export interface WhatsAppListSection {
  title: string;
  rows: WhatsAppListRow[];
}

export type WhatsAppInteractiveMessage =
  | {
    kind: 'reply_buttons';
    body: string;
    footer?: string;
    buttons: WhatsAppReplyButton[];
  }
  | {
    kind: 'list';
    body: string;
    footer?: string;
    buttonText: string;
    sections: WhatsAppListSection[];
  };

export function buildAnswerFeedbackButtons(input: {
  okId: string;
  problemId: string;
  actionsId: string;
}): WhatsAppInteractiveMessage {
  return {
    kind: 'reply_buttons',
    body: 'Was this answer useful?',
    buttons: [
      { id: input.okId, title: 'Looks right' },
      { id: input.problemId, title: 'Problem' },
      { id: input.actionsId, title: 'Actions' },
    ],
  };
}

export function buildProblemReasonPicker(input: {
  wrongNumberId: string;
  wrongDataId: string;
  notAskedId: string;
  otherId: string;
}): WhatsAppInteractiveMessage {
  return {
    kind: 'list',
    body: 'What was wrong with this answer?',
    buttonText: 'Choose reason',
    sections: [{
      title: 'Feedback',
      rows: [
        { id: input.wrongNumberId, title: 'Wrong number' },
        { id: input.wrongDataId, title: 'Wrong data' },
        { id: input.notAskedId, title: 'Not my question' },
        { id: input.otherId, title: 'Other' },
      ],
    }],
  };
}

export function buildAnswerActionsList(input: {
  showReasoningId: string;
  showSqlId: string;
  tableId: string;
  summaryId: string;
  rowCount: number;
  columnCount: number;
}): WhatsAppInteractiveMessage {
  const rows: WhatsAppListRow[] = [
    { id: input.showReasoningId, title: 'Show reasoning' },
    { id: input.showSqlId, title: 'Show SQL' },
  ];

  if (input.rowCount > 0 && !(input.rowCount === 1 && input.columnCount === 1)) {
    rows.push(
      { id: input.tableId, title: 'Table view' },
      { id: input.summaryId, title: 'Summary view' },
    );
  }

  return {
    kind: 'list',
    body: 'What would you like to see?',
    buttonText: 'Open actions',
    sections: [{ title: 'Answer actions', rows }],
  };
}
```

- [ ] **Step 7: Add failing WhatsApp client interactive send test**

Append to `tests/whatsapp/client.test.ts`:

```typescript
it('sends a Cloud API interactive reply-button message', async () => {
  const fetchImpl = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ messages: [{ id: 'wamid.interactive' }] }),
  });
  const client = createWhatsAppClient({
    accessToken: 'access-token',
    phoneNumberId: 'phone-1',
    graphApiVersion: 'v23.0',
    fetchImpl,
  });

  const result = await client.sendInteractive({
    surface: 'whatsapp',
    conversationId: 'whatsapp:15551234567',
    userId: '15551234567',
  }, {
    kind: 'reply_buttons',
    body: 'Was this answer useful?',
    buttons: [
      { id: 'wa:v1:ok:ctx_ok', title: 'Looks right' },
      { id: 'wa:v1:problem:ctx_problem', title: 'Problem' },
    ],
  });

  expect(result).toEqual({ messageId: 'wamid.interactive' });
  expect(fetchImpl).toHaveBeenCalledWith(
    'https://graph.facebook.com/v23.0/phone-1/messages',
    expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: '15551234567',
        type: 'interactive',
        interactive: {
          type: 'button',
          body: { text: 'Was this answer useful?' },
          action: {
            buttons: [
              { type: 'reply', reply: { id: 'wa:v1:ok:ctx_ok', title: 'Looks right' } },
              { type: 'reply', reply: { id: 'wa:v1:problem:ctx_problem', title: 'Problem' } },
            ],
          },
        },
      }),
    }),
  );
});

it('sends a Cloud API interactive list message', async () => {
  const fetchImpl = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ messages: [{ id: 'wamid.list' }] }),
  });
  const client = createWhatsAppClient({
    accessToken: 'access-token',
    phoneNumberId: 'phone-1',
    graphApiVersion: 'v23.0',
    fetchImpl,
  });

  await client.sendInteractive({
    surface: 'whatsapp',
    conversationId: 'whatsapp:15551234567',
    userId: '15551234567',
  }, {
    kind: 'list',
    body: 'What would you like to see?',
    buttonText: 'Open actions',
    sections: [{
      title: 'Answer actions',
      rows: [{ id: 'wa:v1:show_sql:ctx_1', title: 'Show SQL' }],
    }],
  });

  expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toMatchObject({
    type: 'interactive',
    interactive: {
      type: 'list',
      body: { text: 'What would you like to see?' },
      action: {
        button: 'Open actions',
        sections: [{
          title: 'Answer actions',
          rows: [{ id: 'wa:v1:show_sql:ctx_1', title: 'Show SQL' }],
        }],
      },
    },
  });
});
```

- [ ] **Step 8: Run client tests to verify failure**

Run:

```bash
npx vitest run tests/whatsapp/client.test.ts
```

Expected: FAIL because `sendInteractive` is not defined.

- [ ] **Step 9: Implement client interactive sends**

In `src/whatsapp/client.ts`, import the new type and add a concrete client interface:

```typescript
import type { ChannelClient, ConversationRef } from '../channels/types.js';
import type { WhatsAppInteractiveMessage } from './interactive.js';

export interface WhatsAppClient extends ChannelClient {
  sendInteractive(
    conversation: ConversationRef,
    message: WhatsAppInteractiveMessage,
  ): Promise<{ messageId: string }>;
}
```

Add this helper in the file:

```typescript
function interactivePayload(message: WhatsAppInteractiveMessage): Record<string, unknown> {
  if (message.kind === 'reply_buttons') {
    return {
      type: 'button',
      body: { text: message.body },
      ...(message.footer ? { footer: { text: message.footer } } : {}),
      action: {
        buttons: message.buttons.map((button) => ({
          type: 'reply',
          reply: { id: button.id, title: button.title },
        })),
      },
    };
  }

  return {
    type: 'list',
    body: { text: message.body },
    ...(message.footer ? { footer: { text: message.footer } } : {}),
    action: {
      button: message.buttonText,
      sections: message.sections.map((section) => ({
        title: section.title,
        rows: section.rows.map((row) => ({
          id: row.id,
          title: row.title,
          ...(row.description ? { description: row.description } : {}),
        })),
      })),
    },
  };
}
```

Change the return type:

```typescript
export function createWhatsAppClient(config: WhatsAppClientConfig): WhatsAppClient {
```

Add `sendInteractive` next to `sendText`, sharing the same safe error behavior and `firstMessageId` parsing:

```typescript
async sendInteractive(conversation, message) {
  let response: FetchResponse;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: conversation.userId,
        type: 'interactive',
        interactive: interactivePayload(message),
      }),
    });
  } catch {
    throw new Error('WhatsApp send failed before receiving a response');
  }

  if (!response.ok) {
    throw new Error(`WhatsApp send failed with status ${response.status ?? 'unknown'}`);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error('WhatsApp send returned an unreadable response');
  }

  const messageId = firstMessageId(payload);
  if (!messageId) {
    throw new Error('WhatsApp send succeeded without a message id');
  }

  return { messageId };
}
```

- [ ] **Step 10: Verify Task 2 tests pass**

Run:

```bash
npx vitest run tests/whatsapp/actionIds.test.ts tests/whatsapp/interactive.test.ts tests/whatsapp/client.test.ts
```

Expected: PASS.

- [ ] **Step 11: Commit Task 2**

```bash
git add src/whatsapp/actionIds.ts src/whatsapp/interactive.ts src/whatsapp/client.ts tests/whatsapp/actionIds.test.ts tests/whatsapp/interactive.test.ts tests/whatsapp/client.test.ts
git commit -m "feat: add whatsapp interactive message client"
```

---

### Task 3: Parse Interactive Webhook Replies And Route Them

**Files:**
- Modify: `src/whatsapp/payload.ts`
- Modify: `src/whatsapp/webhook.ts`
- Test: `tests/whatsapp/payload.test.ts`
- Test: `tests/whatsapp/webhook.test.ts`

- [ ] **Step 1: Add failing payload parser tests**

Append to `tests/whatsapp/payload.test.ts`:

```typescript
it('parses interactive button replies as actions', () => {
  const payload = structuredClone(textPayload);
  payload.entry[0].changes[0].value.messages[0] = {
    from: '15551234567',
    id: 'wamid.button',
    timestamp: '1780000000',
    type: 'interactive',
    interactive: {
      type: 'button_reply',
      button_reply: { id: 'wa:v1:ok:ctx_ok', title: 'Looks right' },
    },
  } as any;

  const result = parseWhatsAppWebhookPayload(payload, 'phone-1');

  expect(result.messages).toEqual([]);
  expect(result.unsupported).toEqual([]);
  expect(result.actions).toEqual([{
    providerMessageId: 'wamid.button',
    conversation: {
      surface: 'whatsapp',
      conversationId: 'whatsapp:15551234567',
      userId: '15551234567',
    },
    receivedAt: new Date(1780000000 * 1000),
    actionId: 'wa:v1:ok:ctx_ok',
    actionTitle: 'Looks right',
    kind: 'button_reply',
  }]);
});

it('parses interactive list replies as actions', () => {
  const payload = structuredClone(textPayload);
  payload.entry[0].changes[0].value.messages[0] = {
    from: '15551234567',
    id: 'wamid.list',
    timestamp: '1780000000',
    type: 'interactive',
    interactive: {
      type: 'list_reply',
      list_reply: { id: 'wa:v1:show_sql:ctx_sql', title: 'Show SQL' },
    },
  } as any;

  const result = parseWhatsAppWebhookPayload(payload, 'phone-1');

  expect(result.actions).toEqual([expect.objectContaining({
    providerMessageId: 'wamid.list',
    actionId: 'wa:v1:show_sql:ctx_sql',
    actionTitle: 'Show SQL',
    kind: 'list_reply',
  })]);
});
```

- [ ] **Step 2: Run payload parser tests to verify failure**

Run:

```bash
npx vitest run tests/whatsapp/payload.test.ts
```

Expected: FAIL because `ParsedWhatsAppWebhook` has no `actions`.

- [ ] **Step 3: Implement action parsing**

In `src/whatsapp/payload.ts`, add:

```typescript
export interface WhatsAppInteractiveAction {
  providerMessageId: string;
  conversation: ConversationRef;
  receivedAt: Date;
  actionId: string;
  actionTitle: string;
  kind: 'button_reply' | 'list_reply';
}

export interface ParsedWhatsAppWebhook {
  messages: ChannelMessage[];
  unsupported: UnsupportedWhatsAppMessage[];
  actions: WhatsAppInteractiveAction[];
}
```

Initialize:

```typescript
const parsed: ParsedWhatsAppWebhook = { messages: [], unsupported: [], actions: [] };
```

Before the `if (type !== 'text')` unsupported branch, add:

```typescript
if (type === 'interactive') {
  const interactive = asRecord(message.interactive);
  const interactiveType = typeof interactive?.type === 'string' ? interactive.type : '';

  if (interactiveType === 'button_reply') {
    const reply = asRecord(interactive.button_reply);
    const actionId = typeof reply?.id === 'string' ? reply.id : '';
    const actionTitle = typeof reply?.title === 'string' ? reply.title : '';
    if (actionId) {
      parsed.actions.push({
        providerMessageId: id,
        conversation,
        receivedAt,
        actionId,
        actionTitle,
        kind: 'button_reply',
      });
    }
    continue;
  }

  if (interactiveType === 'list_reply') {
    const reply = asRecord(interactive.list_reply);
    const actionId = typeof reply?.id === 'string' ? reply.id : '';
    const actionTitle = typeof reply?.title === 'string' ? reply.title : '';
    if (actionId) {
      parsed.actions.push({
        providerMessageId: id,
        conversation,
        receivedAt,
        actionId,
        actionTitle,
        kind: 'list_reply',
      });
    }
    continue;
  }

  parsed.unsupported.push({
    providerMessageId: id,
    conversation,
    receivedAt,
    type: interactiveType ? `interactive:${interactiveType}` : 'interactive',
  });
  continue;
}
```

- [ ] **Step 4: Add failing webhook routing test**

In `tests/whatsapp/webhook.test.ts`, extend the hoisted mocks:

```typescript
handleWhatsAppActions: vi.fn(),
```

Update the `vi.mock('../../src/whatsapp/messages.js', ...)` block or add a new mock for `../../src/whatsapp/actions.js` depending on where the handler imports from:

```typescript
vi.mock('../../src/whatsapp/actions.js', () => ({
  handleWhatsAppActions: mockValues.handleWhatsAppActions,
}));
```

Add this test:

```typescript
it('routes interactive actions before text messages', async () => {
  const payload = whatsappPayload({
    entry: [{
      changes: [{
        value: {
          metadata: { phone_number_id: PHONE_NUMBER_ID },
          messages: [{
            from: '15551234567',
            id: 'wamid.button',
            timestamp: '1780000000',
            type: 'interactive',
            interactive: {
              type: 'button_reply',
              button_reply: { id: 'wa:v1:ok:ctx_ok', title: 'Looks right' },
            },
          }],
        },
      }],
    }],
  });
  const rawBody = Buffer.from(JSON.stringify(payload));
  const { response, status, send } = res();

  await postHandler(req({
    body: rawBody,
    headers: { 'x-hub-signature-256': sign(rawBody) },
  }), response);

  expect(mockValues.handleWhatsAppActions).toHaveBeenCalledWith([
    expect.objectContaining({
      providerMessageId: 'wamid.button',
      actionId: 'wa:v1:ok:ctx_ok',
      kind: 'button_reply',
    }),
  ], {
    client,
    tables: deps.tables,
    config: deps.config,
    rateLimitPerHour: 30,
    allowedWaIds: ['15551234567'],
  });
  expect(mockValues.handleWhatsAppMessages).toHaveBeenCalledWith([], expect.any(Object));
  expect(status).toHaveBeenCalledWith(200);
  expect(send).toHaveBeenCalledWith('OK');
});
```

- [ ] **Step 5: Run webhook tests to verify failure**

Run:

```bash
npx vitest run tests/whatsapp/webhook.test.ts
```

Expected: FAIL because `handleWhatsAppActions` is not called.

- [ ] **Step 6: Wire webhook routing**

Create a compile-only exported no-op in `src/whatsapp/actions.ts` so the import compiles before Task 5 adds behavior:

```typescript
import type { WhatsAppClient } from './client.js';
import type { WhatsAppInteractiveAction } from './payload.js';
import type { TableContext } from '../dbt/types.js';
import type { PipelineConfig } from '../pipeline.js';

export interface HandleWhatsAppActionsDeps {
  client: WhatsAppClient;
  tables: TableContext[];
  config: PipelineConfig;
  rateLimitPerHour: number;
  allowedWaIds: string[];
}

export async function handleWhatsAppActions(
  _actions: WhatsAppInteractiveAction[],
  _deps: HandleWhatsAppActionsDeps,
): Promise<void> {
}
```

In `src/whatsapp/webhook.ts`, import and call it before unsupported/text handlers:

```typescript
import { handleWhatsAppActions } from './actions.js';
import type { WhatsAppClient } from './client.js';
```

Change the dependency type:

```typescript
client: WhatsAppClient;
```

Call:

```typescript
await handleWhatsAppActions(parsed.actions, {
  client: deps.client,
  tables: deps.tables,
  config: deps.config,
  rateLimitPerHour: deps.rateLimitPerHour,
  allowedWaIds: deps.allowedWaIds,
});
```

- [ ] **Step 7: Verify Task 3 tests pass**

Run:

```bash
npx vitest run tests/whatsapp/payload.test.ts tests/whatsapp/webhook.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit Task 3**

```bash
git add src/whatsapp/payload.ts src/whatsapp/webhook.ts src/whatsapp/actions.ts tests/whatsapp/payload.test.ts tests/whatsapp/webhook.test.ts
git commit -m "feat: parse whatsapp interactive replies"
```

---

### Task 4: Send Answer Control Buttons After WhatsApp Answers

**Files:**
- Modify: `src/whatsapp/pipeline.ts`
- Test: `tests/whatsapp/pipeline.test.ts`

- [ ] **Step 1: Add failing pipeline test**

In `tests/whatsapp/pipeline.test.ts`, import `responseContextDocumentId` if needed and extend the first `acks, answers...` test with a `sendAnswerControls` mock:

```typescript
const sendAnswerControls = vi.fn().mockResolvedValue(undefined);
```

Pass it into `runWhatsAppPipeline`:

```typescript
const result = await runWhatsAppPipeline({
  message,
  client,
  answerQuestion,
  saveResponseContext,
  markVisible,
  sendAnswerControls,
});
```

Assert it was called after response context save:

```typescript
expect(sendAnswerControls).toHaveBeenCalledWith(
  conversation,
  'whatsapp:15551234567_outbound%2FA%2BB%3D',
  expect.objectContaining({
    traceId: 'trace-response',
    statusMsgTs: 'outbound/A+B=',
    surface: 'whatsapp',
  }),
);
expect(saveResponseContext.mock.invocationCallOrder[0])
  .toBeLessThan(sendAnswerControls.mock.invocationCallOrder[0]);
```

Add a failure-path test:

```typescript
it('logs but does not fail the answer when answer controls fail', async () => {
  const client = createClient();
  const answerQuestion = vi.fn().mockResolvedValue({
    kind: 'answer',
    explanation: 'Revenue was 123 yesterday.',
    rows: [{ revenue: 123 }],
    columnNames: ['revenue'],
    totalRows: 1,
    assumptions: [],
    traceId: 'trace-answer',
    responseContext: responseContext(),
  });
  const saveResponseContext = vi.fn().mockResolvedValue(undefined);
  const sendAnswerControls = vi.fn().mockRejectedValue(new Error('provider failed'));

  await expect(runWhatsAppPipeline({
    message,
    client,
    answerQuestion,
    saveResponseContext,
    sendAnswerControls,
  })).resolves.toEqual({ visible: true, outcome: 'answer' });

  expect(sendAnswerControls).toHaveBeenCalledOnce();
  expect(client.sendText).toHaveBeenCalledTimes(2);
});
```

- [ ] **Step 2: Run pipeline tests to verify failure**

Run:

```bash
npx vitest run tests/whatsapp/pipeline.test.ts
```

Expected: FAIL because `sendAnswerControls` is not accepted or called.

- [ ] **Step 3: Implement answer-control hook**

In `src/whatsapp/pipeline.ts`, import:

```typescript
import { responseContextDocumentId } from '../state/responseContext.js';
```

Extend `RunWhatsAppPipelineInput`:

```typescript
sendAnswerControls?: (
  conversation: ChannelMessage['conversation'],
  responseContextKey: string,
  ctx: ResponseContext,
) => Promise<void>;
```

After the answer is sent, build the saved context once:

```typescript
const savedContext: ResponseContext = {
  ...outcome.responseContext,
  threadTs: conversationId,
  statusMsgTs: sent.messageId,
  surface: 'whatsapp',
};
```

Save and then send controls:

```typescript
try {
  await input.saveResponseContext(savedContext);
} catch (err) {
  logger.error({ err }, 'whatsapp.response_context_save_failed');
}

if (input.sendAnswerControls) {
  try {
    await input.sendAnswerControls(
      message.conversation,
      responseContextDocumentId(savedContext),
      savedContext,
    );
  } catch (err) {
    logger.error({ err }, 'whatsapp.answer_controls_send_failed');
  }
}
```

Keep the existing behavior that response-context save failure is logged and does not turn the already-visible answer into a safe-error message.

- [ ] **Step 4: Verify Task 4 tests pass**

Run:

```bash
npx vitest run tests/whatsapp/pipeline.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit Task 4**

```bash
git add src/whatsapp/pipeline.ts tests/whatsapp/pipeline.test.ts
git commit -m "feat: hook whatsapp answer controls into pipeline"
```

---

### Task 5: Implement WhatsApp Action Handler For Feedback And Details

**Files:**
- Modify: `src/whatsapp/actions.ts`
- Modify: `src/whatsapp/renderer.ts`
- Test: `tests/whatsapp/actions.test.ts`
- Test: `tests/whatsapp/renderer.test.ts`

- [ ] **Step 1: Add failing renderer tests**

Append to `tests/whatsapp/renderer.test.ts`:

```typescript
import {
  renderWhatsAppReasoning,
  renderWhatsAppSql,
  renderWhatsAppFeedbackAck,
  renderWhatsAppExpiredAction,
} from '../../src/whatsapp/renderer.js';

it('renders reasoning from response context safely', () => {
  expect(renderWhatsAppReasoning({
    explanation: 'Revenue was 123.',
    assumptions: ['Completed orders only'],
    reasoningChain: 'Used the revenue card and fct_orders.',
    supervisorNotes: 'Looks valid.',
    groundingCitations: [{ sourceFile: 'reference_card:revenue', quote: 'Revenue uses completed orders.' }],
    traceId: 'trace-1',
  })).toContain('Reasoning');
});

it('renders generated SQL behind an explicit action', () => {
  expect(renderWhatsAppSql('SELECT 1', 'trace-1')).toContain('SELECT 1');
});

it('renders feedback acknowledgements', () => {
  expect(renderWhatsAppFeedbackAck('positive')).toBe('Got it. I marked this answer as useful.');
  expect(renderWhatsAppFeedbackAck('negative')).toBe('Got it. I logged this feedback for review.');
});

it('renders expired action recovery copy', () => {
  expect(renderWhatsAppExpiredAction()).toContain('cannot find that answer context');
});
```

Use the actual `GroundingCitation` shape from `src/types.ts`; if it has different fields, keep only fields accepted by the type.

- [ ] **Step 2: Run renderer tests to verify failure**

Run:

```bash
npx vitest run tests/whatsapp/renderer.test.ts
```

Expected: FAIL because the new renderers do not exist.

- [ ] **Step 3: Implement detail renderers**

In `src/whatsapp/renderer.ts`, export:

```typescript
export function renderWhatsAppFeedbackAck(kind: 'positive' | 'negative'): string {
  return kind === 'positive'
    ? 'Got it. I marked this answer as useful.'
    : 'Got it. I logged this feedback for review.';
}

export function renderWhatsAppExpiredAction(): string {
  return 'I cannot find that answer context anymore. Ask the question again if you want me to re-check it.';
}

export function renderWhatsAppSql(sql: string, traceId: string): string {
  return capMessageWithFooter(`SQL:\n${sql}`, `(trace: ${traceId})`);
}

export function renderWhatsAppReasoning(input: {
  explanation: string;
  assumptions: string[];
  reasoningChain: string;
  supervisorNotes?: string;
  groundingCitations: Array<{ sourceFile: string; quote?: string }>;
  traceId: string;
}): string {
  const sections = [
    'Reasoning',
    input.explanation.trim(),
  ];

  if (input.reasoningChain.trim()) {
    sections.push(`Steps:\n${input.reasoningChain.trim()}`);
  }

  if (input.assumptions.length > 0) {
    sections.push([
      'Assumptions:',
      ...input.assumptions.map((assumption) => `- ${assumption}`),
    ].join('\n'));
  }

  if (input.supervisorNotes?.trim()) {
    sections.push(`Review:\n${input.supervisorNotes.trim()}`);
  }

  if (input.groundingCitations.length > 0) {
    sections.push([
      'Sources:',
      ...input.groundingCitations.map((citation) => `- ${citation.sourceFile}`),
    ].join('\n'));
  }

  return capMessageWithFooter(sections.join('\n\n'), `(trace: ${input.traceId})`);
}
```

- [ ] **Step 4: Add failing action handler tests for feedback and detail actions**

Create `tests/whatsapp/actions.test.ts` with mocks:

```typescript
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResponseContext } from '../../src/types.js';
import type { WhatsAppClient } from '../../src/whatsapp/client.js';
import type { WhatsAppInteractiveAction } from '../../src/whatsapp/payload.js';

vi.mock('../../src/state/whatsappEventDedupe.js', () => ({
  claimWhatsAppEvent: vi.fn(),
  markWhatsAppEventVisible: vi.fn(),
  releaseWhatsAppEventClaim: vi.fn(),
}));
vi.mock('../../src/state/whatsappActionContext.js', () => ({
  createWhatsAppActionContext: vi.fn(),
  getWhatsAppActionContext: vi.fn(),
}));
vi.mock('../../src/state/responseContext.js', () => ({
  getResponseContext: vi.fn(),
  recordFeedbackByResponseContextKey: vi.fn(),
}));

import {
  claimWhatsAppEvent,
  markWhatsAppEventVisible,
  releaseWhatsAppEventClaim,
} from '../../src/state/whatsappEventDedupe.js';
import {
  createWhatsAppActionContext,
  getWhatsAppActionContext,
} from '../../src/state/whatsappActionContext.js';
import {
  getResponseContext,
  recordFeedbackByResponseContextKey,
} from '../../src/state/responseContext.js';
import { handleWhatsAppActions } from '../../src/whatsapp/actions.js';

const conversation = {
  surface: 'whatsapp' as const,
  conversationId: 'whatsapp:15551234567',
  userId: '15551234567',
};

function action(actionId: string): WhatsAppInteractiveAction {
  return {
    providerMessageId: 'wamid.action',
    conversation,
    receivedAt: new Date('2026-06-23T00:00:00.000Z'),
    actionId,
    actionTitle: 'Action',
    kind: 'button_reply',
  };
}

function client(): WhatsAppClient {
  return {
    sendText: vi.fn().mockResolvedValue({ messageId: 'outbound.text' }),
    sendInteractive: vi.fn().mockResolvedValue({ messageId: 'outbound.interactive' }),
  };
}

function ctx(overrides: Partial<ResponseContext> = {}): ResponseContext {
  return {
    surface: 'whatsapp',
    responseId: 'trace-1',
    threadTs: 'whatsapp:15551234567',
    statusMsgTs: 'wamid.outbound',
    clarifiedQuestion: 'What was revenue?',
    assumptions: [],
    reasoningChain: 'Used fct_orders.',
    generatedSql: 'SELECT 1',
    explanation: 'Revenue was 1.',
    tablesUsed: [],
    confidence: 'high',
    clarificationConfidence: 'high',
    primaryAgentConfidence: 'high',
    queryResults: { rowCount: 1, columnNames: ['revenue'], bytesProcessed: 0 },
    pipelineDurationMs: 10,
    traceId: 'trace-1',
    createdAt: new Date('2026-06-23T00:00:00.000Z'),
    groundingCitations: [],
    teachingsUsed: [],
    ...overrides,
  };
}

describe('handleWhatsAppActions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(claimWhatsAppEvent).mockResolvedValue(true);
    vi.mocked(markWhatsAppEventVisible).mockResolvedValue(undefined);
    vi.mocked(releaseWhatsAppEventClaim).mockResolvedValue(undefined);
    vi.mocked(getWhatsAppActionContext).mockResolvedValue({
      id: 'ctx_ok',
      kind: 'ok',
      responseContextKey: 'response-key',
      conversationId: 'whatsapp:15551234567',
      userId: '15551234567',
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    });
    vi.mocked(getResponseContext).mockResolvedValue(ctx());
    vi.mocked(recordFeedbackByResponseContextKey).mockResolvedValue(undefined);
    vi.mocked(createWhatsAppActionContext).mockResolvedValue('ctx_next');
  });

  it('records positive feedback and sends an ack', async () => {
    const waClient = client();

    await handleWhatsAppActions([action('wa:v1:ok:ctx_ok')], {
      client: waClient,
      tables: [],
      config: {} as any,
      rateLimitPerHour: 30,
      allowedWaIds: ['15551234567'],
    });

    expect(recordFeedbackByResponseContextKey).toHaveBeenCalledWith('response-key', 'positive');
    expect(waClient.sendText).toHaveBeenCalledWith(conversation, 'Got it. I marked this answer as useful.');
    expect(markWhatsAppEventVisible).toHaveBeenCalledWith('wamid.action');
  });

  it('sends expired-action copy when response context is gone', async () => {
    vi.mocked(getResponseContext).mockResolvedValue(null);
    const waClient = client();

    await handleWhatsAppActions([action('wa:v1:show_sql:ctx_ok')], {
      client: waClient,
      tables: [],
      config: {} as any,
      rateLimitPerHour: 30,
      allowedWaIds: ['15551234567'],
    });

    expect(waClient.sendText).toHaveBeenCalledWith(
      conversation,
      expect.stringContaining('cannot find that answer context'),
    );
  });

  it('renders SQL without calling Gemini or BigQuery', async () => {
    vi.mocked(getWhatsAppActionContext).mockResolvedValue({
      id: 'ctx_sql',
      kind: 'show_sql',
      responseContextKey: 'response-key',
      conversationId: 'whatsapp:15551234567',
      userId: '15551234567',
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    });
    const waClient = client();

    await handleWhatsAppActions([action('wa:v1:show_sql:ctx_sql')], {
      client: waClient,
      tables: [],
      config: {} as any,
      rateLimitPerHour: 30,
      allowedWaIds: ['15551234567'],
    });

    expect(waClient.sendText).toHaveBeenCalledWith(conversation, expect.stringContaining('SELECT 1'));
  });
});
```

- [ ] **Step 5: Run action tests to verify failure**

Run:

```bash
npx vitest run tests/whatsapp/actions.test.ts
```

Expected: FAIL because the action handler still contains only the compile-only no-op from Task 3.

- [ ] **Step 6: Implement action handler core helpers**

In `src/whatsapp/actions.ts`, keep the existing exported types and replace the compile-only no-op with real logic. Add imports:

```typescript
import { claimWhatsAppEvent, markWhatsAppEventVisible, releaseWhatsAppEventClaim } from '../state/whatsappEventDedupe.js';
import { createWhatsAppActionContext, getWhatsAppActionContext } from '../state/whatsappActionContext.js';
import { getResponseContext, recordFeedbackByResponseContextKey } from '../state/responseContext.js';
import { buildWhatsAppActionId, parseWhatsAppActionId, type WhatsAppActionKind } from './actionIds.js';
import { buildAnswerActionsList, buildProblemReasonPicker } from './interactive.js';
import {
  renderWhatsAppExpiredAction,
  renderWhatsAppFeedbackAck,
  renderWhatsAppReasoning,
  renderWhatsAppSql,
} from './renderer.js';
```

Add helpers:

```typescript
function isAllowed(userId: string, allowedWaIds: readonly string[]): boolean {
  return allowedWaIds.length === 0 || allowedWaIds.includes(userId);
}

async function createActionId(input: {
  kind: WhatsAppActionKind;
  responseContextKey: string;
  conversationId: string;
  userId: string;
}): Promise<string> {
  const contextId = await createWhatsAppActionContext(input);
  return buildWhatsAppActionId(input.kind, contextId);
}

async function loadAction(
  actionId: string,
  actionConversationId: string,
  actionUserId: string,
) {
  const parsed = parseWhatsAppActionId(actionId);
  if (!parsed) return null;
  const stored = await getWhatsAppActionContext(parsed.contextId);
  if (!stored) return null;
  if (stored.kind !== parsed.kind) return null;
  if (stored.conversationId !== actionConversationId) return null;
  if (stored.userId !== actionUserId) return null;
  return { kind: parsed.kind, context: stored };
}
```

- [ ] **Step 7: Implement feedback and detail dispatch**

Add:

```typescript
async function sendProblemPicker(
  action: WhatsAppInteractiveAction,
  deps: HandleWhatsAppActionsDeps,
  responseContextKey: string,
): Promise<void> {
  const base = {
    responseContextKey,
    conversationId: action.conversation.conversationId,
    userId: action.conversation.userId,
  };

  await deps.client.sendInteractive(action.conversation, buildProblemReasonPicker({
    wrongNumberId: await createActionId({ ...base, kind: 'reason_wrong_number' }),
    wrongDataId: await createActionId({ ...base, kind: 'reason_wrong_data' }),
    notAskedId: await createActionId({ ...base, kind: 'reason_not_asked' }),
    otherId: await createActionId({ ...base, kind: 'reason_other' }),
  }));
}

async function sendActionsList(
  action: WhatsAppInteractiveAction,
  deps: HandleWhatsAppActionsDeps,
  responseContextKey: string,
): Promise<void> {
  const ctx = await getResponseContext(responseContextKey);
  if (!ctx) {
    await deps.client.sendText(action.conversation, renderWhatsAppExpiredAction());
    return;
  }

  const base = {
    responseContextKey,
    conversationId: action.conversation.conversationId,
    userId: action.conversation.userId,
  };

  await deps.client.sendInteractive(action.conversation, buildAnswerActionsList({
    showReasoningId: await createActionId({ ...base, kind: 'show_reasoning' }),
    showSqlId: await createActionId({ ...base, kind: 'show_sql' }),
    tableId: await createActionId({ ...base, kind: 'override_table' }),
    summaryId: await createActionId({ ...base, kind: 'override_summary' }),
    rowCount: ctx.queryResults.rowCount,
    columnCount: ctx.queryResults.columnNames.length,
  }));
}
```

Implement `handleWhatsAppActions` branches for the tested actions:

```typescript
export async function handleWhatsAppActions(
  actions: WhatsAppInteractiveAction[],
  deps: HandleWhatsAppActionsDeps,
): Promise<void> {
  for (const action of actions) {
    if (!isAllowed(action.conversation.userId, deps.allowedWaIds)) continue;
    const claimed = await claimWhatsAppEvent(action.providerMessageId);
    if (!claimed) continue;

    let visibleResponse = false;
    try {
      const loaded = await loadAction(
        action.actionId,
        action.conversation.conversationId,
        action.conversation.userId,
      );
      if (!loaded) {
        await deps.client.sendText(action.conversation, renderWhatsAppExpiredAction());
        visibleResponse = true;
        await markWhatsAppEventVisible(action.providerMessageId).catch(() => {});
        continue;
      }

      const { kind, context } = loaded;
      const ctx = await getResponseContext(context.responseContextKey);

      if (kind === 'ok') {
        await recordFeedbackByResponseContextKey(context.responseContextKey, 'positive');
        await deps.client.sendText(action.conversation, renderWhatsAppFeedbackAck('positive'));
      } else if (kind === 'problem') {
        await sendProblemPicker(action, deps, context.responseContextKey);
      } else if (kind === 'actions') {
        await sendActionsList(action, deps, context.responseContextKey);
      } else if (kind === 'reason_wrong_number' || kind === 'reason_wrong_data') {
        await recordFeedbackByResponseContextKey(context.responseContextKey, 'negative');
        await deps.client.sendText(action.conversation, renderWhatsAppFeedbackAck('negative'));
      } else if (kind === 'reason_not_asked') {
        await recordFeedbackByResponseContextKey(context.responseContextKey, 'negative');
        await deps.client.sendText(
          action.conversation,
          'Got it. Reply with the question you meant to ask, and I will take another run at it.',
        );
      } else if (kind === 'show_sql') {
        if (!ctx) {
          await deps.client.sendText(action.conversation, renderWhatsAppExpiredAction());
        } else {
          await deps.client.sendText(action.conversation, renderWhatsAppSql(ctx.generatedSql, ctx.traceId));
        }
      } else if (kind === 'show_reasoning') {
        if (!ctx) {
          await deps.client.sendText(action.conversation, renderWhatsAppExpiredAction());
        } else {
          await deps.client.sendText(action.conversation, renderWhatsAppReasoning({
            explanation: ctx.explanation,
            assumptions: ctx.assumptions,
            reasoningChain: ctx.reasoningChain,
            supervisorNotes: ctx.supervisorNotes,
            groundingCitations: ctx.groundingCitations,
            traceId: ctx.traceId,
          }));
        }
      }

      visibleResponse = true;
      await markWhatsAppEventVisible(action.providerMessageId).catch(() => {});
    } catch (err) {
      if (!visibleResponse) {
        await releaseWhatsAppEventClaim(action.providerMessageId).catch(() => {});
      }
      throw err;
    }
  }
}
```

Task 6 adds the `reason_other` branch. Task 7 adds the `override_table` and `override_summary` branches.

- [ ] **Step 8: Verify Task 5 tests pass**

Run:

```bash
npx vitest run tests/whatsapp/renderer.test.ts tests/whatsapp/actions.test.ts
```

Expected: PASS.

- [ ] **Step 9: Commit Task 5**

```bash
git add src/whatsapp/actions.ts src/whatsapp/renderer.ts tests/whatsapp/actions.test.ts tests/whatsapp/renderer.test.ts
git commit -m "feat: handle whatsapp feedback and detail actions"
```

---

### Task 6: Capture `Problem -> Other` Free-Text Feedback

**Files:**
- Create: `src/state/whatsappPendingFeedback.ts`
- Modify: `src/whatsapp/actions.ts`
- Modify: `src/whatsapp/messages.ts`
- Modify: `infra/firestore.ttls.json`
- Test: `tests/state/whatsappPendingFeedback.test.ts`
- Test: `tests/whatsapp/actions.test.ts`
- Test: `tests/whatsapp/messages.test.ts`
- Test: `tests/infra/firestoreTtls.test.ts`

- [ ] **Step 1: Add failing pending feedback state tests**

Create `tests/state/whatsappPendingFeedback.test.ts`:

```typescript
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockSet = vi.fn();
const mockGet = vi.fn();
const mockDelete = vi.fn();
const mockDoc = vi.fn(() => ({ set: mockSet, get: mockGet, delete: mockDelete }));
const mockCollection = vi.fn(() => ({ doc: mockDoc }));

vi.mock('../../src/state/firestore.js', () => ({
  getDb: vi.fn(() => ({ collection: mockCollection })),
}));

import {
  deleteWhatsAppPendingFeedback,
  getWhatsAppPendingFeedback,
  saveWhatsAppPendingFeedback,
} from '../../src/state/whatsappPendingFeedback.js';

describe('whatsappPendingFeedback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSet.mockResolvedValue(undefined);
    mockDelete.mockResolvedValue(undefined);
  });

  it('saves pending feedback by conversation id', async () => {
    await saveWhatsAppPendingFeedback({
      conversationId: 'whatsapp:15551234567',
      userId: '15551234567',
      responseContextKey: 'response-key',
      traceId: 'trace-1',
      clarifiedQuestion: 'What was revenue?',
    });

    expect(mockCollection).toHaveBeenCalledWith('whatsapp_pending_feedback_notes');
    expect(mockDoc).toHaveBeenCalledWith('whatsapp:15551234567');
    expect(mockSet).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: 'whatsapp:15551234567',
      responseContextKey: 'response-key',
      traceId: 'trace-1',
      clarifiedQuestion: 'What was revenue?',
      createdAt: expect.any(Date),
      expiresAt: expect.any(Date),
    }));
  });

  it('loads null when no pending feedback exists', async () => {
    mockGet.mockResolvedValue({ exists: false });

    await expect(getWhatsAppPendingFeedback('whatsapp:15551234567')).resolves.toBeNull();
  });

  it('deletes pending feedback by conversation id', async () => {
    await deleteWhatsAppPendingFeedback('whatsapp:15551234567');

    expect(mockDoc).toHaveBeenCalledWith('whatsapp:15551234567');
    expect(mockDelete).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Run state tests to verify failure**

Run:

```bash
npx vitest run tests/state/whatsappPendingFeedback.test.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement pending feedback state**

Create `src/state/whatsappPendingFeedback.ts`:

```typescript
import { getDb } from './firestore.js';

const COLLECTION = 'whatsapp_pending_feedback_notes';
const RETENTION_MS = 30 * 60 * 1000;

type FirestoreTimestamp = { toDate: () => Date };

export interface SaveWhatsAppPendingFeedbackInput {
  conversationId: string;
  userId: string;
  responseContextKey: string;
  traceId: string;
  clarifiedQuestion?: string;
}

export interface WhatsAppPendingFeedback {
  conversationId: string;
  userId: string;
  responseContextKey: string;
  traceId: string;
  clarifiedQuestion?: string;
  createdAt: Date;
  expiresAt: Date;
}

function toDate(value: Date | FirestoreTimestamp | undefined): Date | undefined {
  if (value === undefined) return undefined;
  return value instanceof Date ? value : value.toDate();
}

export async function saveWhatsAppPendingFeedback(
  input: SaveWhatsAppPendingFeedbackInput,
): Promise<void> {
  const now = new Date();
  await getDb()
    .collection(COLLECTION)
    .doc(input.conversationId)
    .set({
      conversationId: input.conversationId,
      userId: input.userId,
      responseContextKey: input.responseContextKey,
      traceId: input.traceId,
      ...(input.clarifiedQuestion ? { clarifiedQuestion: input.clarifiedQuestion } : {}),
      createdAt: now,
      expiresAt: new Date(now.getTime() + RETENTION_MS),
    });
}

export async function getWhatsAppPendingFeedback(
  conversationId: string,
): Promise<WhatsAppPendingFeedback | null> {
  const doc = await getDb().collection(COLLECTION).doc(conversationId).get();
  if (!doc.exists) return null;
  const data = doc.data() as Record<string, unknown>;
  return {
    conversationId: String(data.conversationId),
    userId: String(data.userId),
    responseContextKey: String(data.responseContextKey),
    traceId: String(data.traceId),
    ...(typeof data.clarifiedQuestion === 'string'
      ? { clarifiedQuestion: data.clarifiedQuestion }
      : {}),
    createdAt: toDate(data.createdAt as Date | FirestoreTimestamp)!,
    expiresAt: toDate(data.expiresAt as Date | FirestoreTimestamp)!,
  };
}

export async function deleteWhatsAppPendingFeedback(conversationId: string): Promise<void> {
  await getDb().collection(COLLECTION).doc(conversationId).delete();
}
```

- [ ] **Step 4: Add TTL manifest entry**

Append to `infra/firestore.ttls.json`:

```json
{ "collectionGroup": "whatsapp_pending_feedback_notes", "field": "expiresAt" }
```

Add the same entry to `tests/infra/firestoreTtls.test.ts`.

- [ ] **Step 5: Add failing action test for `reason_other`**

In `tests/whatsapp/actions.test.ts`, mock:

```typescript
vi.mock('../../src/state/whatsappPendingFeedback.js', () => ({
  saveWhatsAppPendingFeedback: vi.fn(),
}));
```

Import `saveWhatsAppPendingFeedback` and add:

```typescript
it('starts pending free-text feedback on reason_other', async () => {
  vi.mocked(getWhatsAppActionContext).mockResolvedValue({
    id: 'ctx_other',
    kind: 'reason_other',
    responseContextKey: 'response-key',
    conversationId: 'whatsapp:15551234567',
    userId: '15551234567',
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 60_000),
  });
  const waClient = client();

  await handleWhatsAppActions([action('wa:v1:reason_other:ctx_other')], {
    client: waClient,
    tables: [],
    config: {} as any,
    rateLimitPerHour: 30,
    allowedWaIds: ['15551234567'],
  });

  expect(saveWhatsAppPendingFeedback).toHaveBeenCalledWith({
    conversationId: 'whatsapp:15551234567',
    userId: '15551234567',
    responseContextKey: 'response-key',
    traceId: 'trace-1',
    clarifiedQuestion: 'What was revenue?',
  });
  expect(waClient.sendText).toHaveBeenCalledWith(
    conversation,
    'Reply with what was wrong, and I will attach it to this answer.',
  );
});
```

- [ ] **Step 6: Implement `reason_other` branch**

In `src/whatsapp/actions.ts`, import:

```typescript
import { saveWhatsAppPendingFeedback } from '../state/whatsappPendingFeedback.js';
```

Add a branch:

```typescript
} else if (kind === 'reason_other') {
  if (!ctx) {
    await deps.client.sendText(action.conversation, renderWhatsAppExpiredAction());
  } else {
    await saveWhatsAppPendingFeedback({
      conversationId: action.conversation.conversationId,
      userId: action.conversation.userId,
      responseContextKey: context.responseContextKey,
      traceId: ctx.traceId,
      clarifiedQuestion: ctx.clarifiedQuestion,
    });
    await deps.client.sendText(
      action.conversation,
      'Reply with what was wrong, and I will attach it to this answer.',
    );
  }
```

- [ ] **Step 7: Add failing message-handler test for pending feedback capture**

In `tests/whatsapp/messages.test.ts`, mock:

```typescript
vi.mock('../../src/state/whatsappPendingFeedback.js', () => ({
  getWhatsAppPendingFeedback: vi.fn(),
  deleteWhatsAppPendingFeedback: vi.fn(),
}));
vi.mock('../../src/state/feedbackNotes.js', () => ({
  saveFeedbackNote: vi.fn(),
}));
```

Import the mocked functions and add `beforeEach` defaults:

```typescript
mockGetWhatsAppPendingFeedback.mockResolvedValue(null);
mockDeleteWhatsAppPendingFeedback.mockResolvedValue(undefined);
mockSaveFeedbackNote.mockResolvedValue(undefined);
```

Add test:

```typescript
it('captures pending WhatsApp free-text feedback before running the pipeline', async () => {
  const dependencies = deps();
  mockGetWhatsAppPendingFeedback.mockResolvedValue({
    conversationId: 'whatsapp:15551234567',
    userId: '15551234567',
    responseContextKey: 'response-key',
    traceId: 'trace-1',
    clarifiedQuestion: 'What was revenue?',
    createdAt: new Date('2026-06-23T00:00:00.000Z'),
    expiresAt: new Date('2026-06-23T00:30:00.000Z'),
  });

  await handleWhatsAppMessages([
    message({ text: 'It included refunded orders.' }),
  ], dependencies);

  expect(mockSaveFeedbackNote).toHaveBeenCalledWith({
    note: 'It included refunded orders.',
    userId: '15551234567',
    threadTs: 'whatsapp:15551234567',
    channel: 'whatsapp:15551234567',
    traceId: 'trace-1',
    clarifiedQuestion: 'What was revenue?',
  });
  expect(mockDeleteWhatsAppPendingFeedback).toHaveBeenCalledWith('whatsapp:15551234567');
  expect(dependencies.client.sendText).toHaveBeenCalledWith(
    conversation,
    'Got it. I logged this feedback for review.',
  );
  expect(mockRunWhatsAppPipeline).not.toHaveBeenCalled();
  expect(mockMarkWhatsAppEventVisible).toHaveBeenCalledWith('wamid.1');
});
```

- [ ] **Step 8: Implement pending feedback capture**

In `src/whatsapp/messages.ts`, import:

```typescript
import { saveFeedbackNote } from '../state/feedbackNotes.js';
import {
  deleteWhatsAppPendingFeedback,
  getWhatsAppPendingFeedback,
} from '../state/whatsappPendingFeedback.js';
import { renderWhatsAppFeedbackAck } from './renderer.js';
```

Inside the per-message `try` block, after the dedupe claim and before rate limiting:

```typescript
const pendingFeedback = await getWhatsAppPendingFeedback(inbound.conversation.conversationId);
if (pendingFeedback) {
  await saveFeedbackNote({
    note: inbound.text,
    userId: inbound.conversation.userId,
    threadTs: inbound.conversation.conversationId,
    channel: inbound.conversation.conversationId,
    traceId: pendingFeedback.traceId,
    ...(pendingFeedback.clarifiedQuestion
      ? { clarifiedQuestion: pendingFeedback.clarifiedQuestion }
      : {}),
  });
  await deleteWhatsAppPendingFeedback(inbound.conversation.conversationId);
  await deps.client.sendText(inbound.conversation, renderWhatsAppFeedbackAck('negative'));
  visibleResponse = true;
  await markWhatsAppEventVisible(inbound.providerMessageId).catch(() => {});
  continue;
}
```

This deliberately bypasses rate limiting for the free-text note that the bot just requested.

- [ ] **Step 9: Verify Task 6 tests pass**

Run:

```bash
npx vitest run tests/state/whatsappPendingFeedback.test.ts tests/whatsapp/actions.test.ts tests/whatsapp/messages.test.ts tests/infra/firestoreTtls.test.ts
```

Expected: PASS.

- [ ] **Step 10: Commit Task 6**

```bash
git add src/state/whatsappPendingFeedback.ts src/whatsapp/actions.ts src/whatsapp/messages.ts infra/firestore.ttls.json tests/state/whatsappPendingFeedback.test.ts tests/whatsapp/actions.test.ts tests/whatsapp/messages.test.ts tests/infra/firestoreTtls.test.ts
git commit -m "feat: capture whatsapp free-text feedback"
```

---

### Task 7: Table And Summary WhatsApp Action Follow-Ups

**Files:**
- Create: `src/execution/overrideTypes.ts`
- Modify: `src/handlers/responseOverrides.ts`
- Create: `src/whatsapp/overrides.ts`
- Modify: `src/whatsapp/actions.ts`
- Test: `tests/whatsapp/overrides.test.ts`
- Test: `tests/whatsapp/actions.test.ts`
- Test: `tests/handlers/responseOverrides.test.ts`

- [ ] **Step 1: Add failing override helper tests**

Create `tests/whatsapp/overrides.test.ts`:

```typescript
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResponseContext } from '../../src/types.js';

vi.mock('../../src/validation/pipeline.js', () => ({ validateSql: vi.fn() }));
vi.mock('../../src/execution/runner.js', () => ({ executeQuery: vi.fn() }));
vi.mock('@google/genai', () => ({ GoogleGenAI: class {} }));
vi.mock('../../src/agents/modelGateway.js', () => ({ generateForNode: vi.fn() }));

import { generateForNode } from '../../src/agents/modelGateway.js';
import { executeQuery } from '../../src/execution/runner.js';
import { validateSql } from '../../src/validation/pipeline.js';
import {
  renderWhatsAppSummaryOverride,
  renderWhatsAppTableOverride,
} from '../../src/whatsapp/overrides.js';

function ctx(overrides: Partial<ResponseContext> = {}): ResponseContext {
  return {
    surface: 'whatsapp',
    responseId: 'trace-1',
    threadTs: 'whatsapp:15551234567',
    statusMsgTs: 'wamid.outbound',
    clarifiedQuestion: 'What was revenue by channel?',
    assumptions: [],
    reasoningChain: '',
    generatedSql: 'SELECT channel, revenue FROM t',
    explanation: 'Revenue by channel.',
    tablesUsed: [],
    confidence: 'high',
    clarificationConfidence: 'high',
    primaryAgentConfidence: 'high',
    queryResults: { rowCount: 2, columnNames: ['channel', 'revenue'], bytesProcessed: 0 },
    pipelineDurationMs: 10,
    traceId: 'trace-1',
    createdAt: new Date('2026-06-23T00:00:00.000Z'),
    groundingCitations: [],
    teachingsUsed: [],
    ...overrides,
  };
}

describe('whatsapp overrides', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(validateSql).mockResolvedValue({ valid: true, bytesProcessed: 0 } as any);
    vi.mocked(executeQuery).mockResolvedValue({
      rows: [{ channel: 'paid', revenue: 100 }],
      columnNames: ['channel', 'revenue'],
      totalRows: 1,
      bytesProcessed: 10,
      truncated: false,
    } as any);
  });

  it('validates and re-executes SQL for table view', async () => {
    const text = await renderWhatsAppTableOverride(ctx(), {
      maxBytesProcessed: 1000,
      maxResultRows: 10,
      queryTimeoutMs: 30_000,
      geminiApiKey: 'key',
    });

    expect(validateSql).toHaveBeenCalledWith('SELECT channel, revenue FROM t', 1000);
    expect(executeQuery).toHaveBeenCalledWith('SELECT channel, revenue FROM t', {
      maxRows: 10,
      timeoutMs: 30_000,
      maxBytes: 1000,
    });
    expect(text).toContain('Revenue by channel.');
    expect(text).toContain('paid');
  });

  it('uses summary override text when Gemini returns one', async () => {
    vi.mocked(generateForNode).mockResolvedValue({ text: 'Paid drove most revenue.' } as any);

    const text = await renderWhatsAppSummaryOverride(ctx(), {
      maxBytesProcessed: 1000,
      maxResultRows: 10,
      queryTimeoutMs: 30_000,
      geminiApiKey: 'key',
    });

    expect(text).toContain('Paid drove most revenue.');
    expect(text).toContain('(trace: trace-1)');
  });
});
```

- [ ] **Step 2: Run override tests to verify failure**

Run:

```bash
npx vitest run tests/whatsapp/overrides.test.ts
```

Expected: FAIL because `src/whatsapp/overrides.ts` does not exist.

- [ ] **Step 3: Move the shared override config type out of the Slack handler**

Create `src/execution/overrideTypes.ts`:

```typescript
export interface OverrideConfig {
  maxBytesProcessed: number;
  queryTimeoutMs: number;
  maxResultRows: number;
  geminiApiKey: string;
}
```

In `src/handlers/responseOverrides.ts`, delete the local `OverrideConfig` interface and import the shared type:

```typescript
import type { OverrideConfig } from '../execution/overrideTypes.js';
```

- [ ] **Step 4: Implement WhatsApp override helpers**

Create `src/whatsapp/overrides.ts`:

```typescript
import { GoogleGenAI } from '@google/genai';
import { generateForNode } from '../agents/modelGateway.js';
import { executeQuery } from '../execution/runner.js';
import type { OverrideConfig } from '../execution/overrideTypes.js';
import type { ResponseContext } from '../types.js';
import { validateSql } from '../validation/pipeline.js';
import { renderWhatsAppQueryAnswer } from './renderer.js';

async function reExecute(ctx: ResponseContext, config: OverrideConfig) {
  const validation = await validateSql(ctx.generatedSql, config.maxBytesProcessed);
  if (!validation.valid) {
    throw Object.assign(
      new Error(validation.error || 'Validation failed'),
      { traceId: ctx.traceId },
    );
  }

  return executeQuery(ctx.generatedSql, {
    maxRows: config.maxResultRows,
    timeoutMs: config.queryTimeoutMs,
    maxBytes: config.maxBytesProcessed,
  });
}

export async function renderWhatsAppTableOverride(
  ctx: ResponseContext,
  config: OverrideConfig,
): Promise<string> {
  const result = await reExecute(ctx, config);
  return renderWhatsAppQueryAnswer({
    explanation: ctx.explanation,
    rows: result.rows,
    columnNames: result.columnNames,
    totalRows: result.totalRows,
    assumptions: ctx.assumptions,
    traceId: ctx.traceId,
  });
}

export async function renderWhatsAppSummaryOverride(
  ctx: ResponseContext,
  config: OverrideConfig,
): Promise<string> {
  const result = await reExecute(ctx, config);

  let summary = '';
  try {
    const ai = new GoogleGenAI({ apiKey: config.geminiApiKey });
    const sampleRows = result.rows.slice(0, 50);
    const response = await generateForNode('summaryOverride', ai, {
      contents: [{
        role: 'user',
        parts: [{
          text: `Summarize these query results in 2-3 sentences for a business user.\n\nQuestion: ${ctx.clarifiedQuestion}\nSQL: ${ctx.generatedSql}\n\nResults (${result.totalRows} total rows, showing first ${sampleRows.length}):\n${JSON.stringify(sampleRows, null, 2)}`,
        }],
      }],
    });
    summary = response.text || '';
  } catch {
    summary = '';
  }

  if (!summary.trim()) {
    return renderWhatsAppQueryAnswer({
      explanation: "I couldn't generate a summary. Here's the raw data:",
      rows: result.rows,
      columnNames: result.columnNames,
      totalRows: result.totalRows,
      assumptions: ctx.assumptions,
      traceId: ctx.traceId,
    });
  }

  return renderWhatsAppQueryAnswer({
    explanation: summary.trim(),
    rows: [],
    columnNames: result.columnNames,
    totalRows: 0,
    assumptions: ctx.assumptions,
    traceId: ctx.traceId,
  });
}
```

- [ ] **Step 5: Add failing action dispatch tests for overrides**

In `tests/whatsapp/actions.test.ts`, mock:

```typescript
vi.mock('../../src/whatsapp/overrides.js', () => ({
  renderWhatsAppTableOverride: vi.fn(),
  renderWhatsAppSummaryOverride: vi.fn(),
}));
```

Import both helpers and add:

```typescript
it('dispatches table override actions', async () => {
  vi.mocked(getWhatsAppActionContext).mockResolvedValue({
    id: 'ctx_table',
    kind: 'override_table',
    responseContextKey: 'response-key',
    conversationId: 'whatsapp:15551234567',
    userId: '15551234567',
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 60_000),
  });
  vi.mocked(renderWhatsAppTableOverride).mockResolvedValue('table text');
  const waClient = client();

  await handleWhatsAppActions([action('wa:v1:override_table:ctx_table')], {
    client: waClient,
    tables: [],
    config: {
      geminiApiKey: 'key',
      fileSearchStoreId: 'stores/test',
      maxBytesProcessed: 1000,
      maxResultRows: 10,
      queryTimeoutMs: 30_000,
    },
    rateLimitPerHour: 30,
    allowedWaIds: ['15551234567'],
  });

  expect(renderWhatsAppTableOverride).toHaveBeenCalledWith(expect.any(Object), {
    geminiApiKey: 'key',
    maxBytesProcessed: 1000,
    maxResultRows: 10,
    queryTimeoutMs: 30_000,
  });
  expect(waClient.sendText).toHaveBeenCalledWith(conversation, 'table text');
});

it('dispatches summary override actions', async () => {
  vi.mocked(getWhatsAppActionContext).mockResolvedValue({
    id: 'ctx_summary',
    kind: 'override_summary',
    responseContextKey: 'response-key',
    conversationId: 'whatsapp:15551234567',
    userId: '15551234567',
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 60_000),
  });
  vi.mocked(renderWhatsAppSummaryOverride).mockResolvedValue('summary text');
  const waClient = client();

  await handleWhatsAppActions([action('wa:v1:override_summary:ctx_summary')], {
    client: waClient,
    tables: [],
    config: {
      geminiApiKey: 'key',
      fileSearchStoreId: 'stores/test',
      maxBytesProcessed: 1000,
      maxResultRows: 10,
      queryTimeoutMs: 30_000,
    },
    rateLimitPerHour: 30,
    allowedWaIds: ['15551234567'],
  });

  expect(renderWhatsAppSummaryOverride).toHaveBeenCalledOnce();
  expect(waClient.sendText).toHaveBeenCalledWith(conversation, 'summary text');
});
```

- [ ] **Step 6: Implement override branches**

In `src/whatsapp/actions.ts`, import:

```typescript
import {
  renderWhatsAppSummaryOverride,
  renderWhatsAppTableOverride,
} from './overrides.js';
```

Add branches:

```typescript
} else if (kind === 'override_table') {
  if (!ctx) {
    await deps.client.sendText(action.conversation, renderWhatsAppExpiredAction());
  } else {
    await deps.client.sendText(action.conversation, await renderWhatsAppTableOverride(ctx, {
      geminiApiKey: deps.config.geminiApiKey,
      maxBytesProcessed: deps.config.maxBytesProcessed,
      maxResultRows: deps.config.maxResultRows,
      queryTimeoutMs: deps.config.queryTimeoutMs,
    }));
  }
} else if (kind === 'override_summary') {
  if (!ctx) {
    await deps.client.sendText(action.conversation, renderWhatsAppExpiredAction());
  } else {
    await deps.client.sendText(action.conversation, await renderWhatsAppSummaryOverride(ctx, {
      geminiApiKey: deps.config.geminiApiKey,
      maxBytesProcessed: deps.config.maxBytesProcessed,
      maxResultRows: deps.config.maxResultRows,
      queryTimeoutMs: deps.config.queryTimeoutMs,
    }));
  }
}
```

- [ ] **Step 7: Verify Task 7 tests pass**

Run:

```bash
npx vitest run tests/whatsapp/overrides.test.ts tests/whatsapp/actions.test.ts tests/handlers/responseOverrides.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit Task 7**

```bash
git add src/execution/overrideTypes.ts src/handlers/responseOverrides.ts src/whatsapp/overrides.ts src/whatsapp/actions.ts tests/whatsapp/overrides.test.ts tests/whatsapp/actions.test.ts tests/handlers/responseOverrides.test.ts
git commit -m "feat: add whatsapp table and summary actions"
```

---

### Task 8: Create And Send Answer Control Contexts

**Files:**
- Modify: `src/whatsapp/messages.ts`
- Test: `tests/whatsapp/messages.test.ts`

- [ ] **Step 1: Add failing message-handler test for answer controls**

In `tests/whatsapp/messages.test.ts`, update the test client helper so it can expose `sendInteractive`:

```typescript
function client(): WhatsAppClient {
  return {
    sendText: vi.fn().mockResolvedValue({ messageId: 'outbound.1' }),
    sendInteractive: vi.fn().mockResolvedValue({ messageId: 'interactive.1' }),
  };
}
```

Mock `createWhatsAppActionContext`:

```typescript
vi.mock('../../src/state/whatsappActionContext.js', () => ({
  createWhatsAppActionContext: vi.fn(),
}));
```

Import and seed:

```typescript
mockCreateWhatsAppActionContext
  .mockResolvedValueOnce('ctx_ok')
  .mockResolvedValueOnce('ctx_problem')
  .mockResolvedValueOnce('ctx_actions');
```

Add:

```typescript
it('sends answer control buttons after a visible answer', async () => {
  const dependencies = deps();

  await handleWhatsAppMessages([message()], dependencies);

  const runInput = mockRunWhatsAppPipeline.mock.calls[0][0];
  await runInput.sendAnswerControls(
    conversation,
    'response-key',
    {
      traceId: 'trace-1',
      queryResults: { rowCount: 1, columnNames: ['revenue'], bytesProcessed: 0 },
    } as any,
  );

  expect(mockCreateWhatsAppActionContext).toHaveBeenCalledWith({
    kind: 'ok',
    responseContextKey: 'response-key',
    conversationId: 'whatsapp:15551234567',
    userId: '15551234567',
  });
  expect(dependencies.client.sendInteractive).toHaveBeenCalledWith(
    conversation,
    expect.objectContaining({
      kind: 'reply_buttons',
      buttons: [
        { id: 'wa:v1:ok:ctx_ok', title: 'Looks right' },
        { id: 'wa:v1:problem:ctx_problem', title: 'Problem' },
        { id: 'wa:v1:actions:ctx_actions', title: 'Actions' },
      ],
    }),
  );
});
```

- [ ] **Step 2: Run messages test to verify failure**

Run:

```bash
npx vitest run tests/whatsapp/messages.test.ts
```

Expected: FAIL because `sendAnswerControls` is not passed to `runWhatsAppPipeline`.

- [ ] **Step 3: Implement answer-control sending helper**

In `src/whatsapp/messages.ts`, import:

```typescript
import type { WhatsAppClient } from './client.js';
import { buildWhatsAppActionId } from './actionIds.js';
import { buildAnswerFeedbackButtons } from './interactive.js';
import { createWhatsAppActionContext } from '../state/whatsappActionContext.js';
```

Change deps client type:

```typescript
client: WhatsAppClient;
```

Add helper:

```typescript
async function sendAnswerControls(input: {
  client: WhatsAppClient;
  conversation: ChannelMessage['conversation'];
  responseContextKey: string;
}): Promise<void> {
  const base = {
    responseContextKey: input.responseContextKey,
    conversationId: input.conversation.conversationId,
    userId: input.conversation.userId,
  };

  const okId = buildWhatsAppActionId('ok', await createWhatsAppActionContext({ ...base, kind: 'ok' }));
  const problemId = buildWhatsAppActionId('problem', await createWhatsAppActionContext({ ...base, kind: 'problem' }));
  const actionsId = buildWhatsAppActionId('actions', await createWhatsAppActionContext({ ...base, kind: 'actions' }));

  await input.client.sendInteractive(input.conversation, buildAnswerFeedbackButtons({
    okId,
    problemId,
    actionsId,
  }));
}
```

Pass it into `runWhatsAppPipeline`:

```typescript
sendAnswerControls: (conversation, responseContextKey) => sendAnswerControls({
  client: deps.client,
  conversation,
  responseContextKey,
}),
```

- [ ] **Step 4: Verify Task 8 tests pass**

Run:

```bash
npx vitest run tests/whatsapp/messages.test.ts tests/whatsapp/pipeline.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit Task 8**

```bash
git add src/whatsapp/messages.ts tests/whatsapp/messages.test.ts tests/whatsapp/pipeline.test.ts
git commit -m "feat: send whatsapp answer control buttons"
```

---

### Task 9: Final Integration And Regression Verification

**Files:**
- Modify only files required by failures found in this task.
- Test: multiple existing suites.

- [ ] **Step 1: Run targeted WhatsApp suite**

Run:

```bash
npx vitest run tests/whatsapp tests/state/whatsappActionContext.test.ts tests/state/whatsappPendingFeedback.test.ts tests/infra/firestoreTtls.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run Slack interactivity regression tests**

Run:

```bash
npx vitest run tests/slack/blocks.test.ts tests/slack/reasoningBlocks.test.ts tests/handlers/feedbackEscalation.test.ts tests/handlers/responseOverrides.test.ts
```

Expected: PASS. These prove the WhatsApp work did not weaken existing Slack buttons, reasoning, feedback, or override behavior.

- [ ] **Step 3: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 4: Run full suite**

Run:

```bash
npm test
```

Expected: PASS.

- [ ] **Step 5: Inspect final diff**

Run:

```bash
git diff --check
git status --short
git diff --stat main
```

Expected:

- `git diff --check` prints no whitespace errors.
- `git status --short` shows only intended files before the final commit.
- Diff is limited to WhatsApp/state/infra/tests and does not modify Slack behavior except shared pure helper imports if Task 7 moved `OverrideConfig`.

- [ ] **Step 6: Commit final fixes if needed**

If Step 1-5 required additional fixes, commit them:

```bash
git add <changed-files>
git commit -m "test: verify whatsapp interactive responses"
```

If no files changed after Task 8, skip this commit.

---

## Manual Deployment Smoke Plan

Do not run this as part of implementation unless explicitly authorized.

After merge and deploy to the WhatsApp demo service:

1. Send an allowlisted WhatsApp text question that returns a single value.
2. Verify the answer arrives, followed by `Was this answer useful?` buttons.
3. Tap `Looks right`; verify acknowledgement and `response_context.negativeFeedback === false`.
4. Ask a table-shaped question.
5. Tap `Actions`; verify a list with `Show reasoning`, `Show SQL`, `Table view`, and `Summary view`.
6. Tap `Show SQL`; verify SQL is sent as a follow-up and no query re-executes.
7. Tap `Show reasoning`; verify reasoning is sent as a follow-up and no Gemini call occurs.
8. Tap `Problem`, then `Wrong number`; verify negative feedback is recorded and no Slack escalation is created.
9. Tap `Problem`, then `Other`; send free text; verify a `feedback_notes` pending note is created.
10. Replay one captured interactive webhook payload; verify dedupe prevents duplicate action effects.

Record evidence outside the reusable template repo.

## Self-Review Checklist

- Spec coverage:
  - Reply buttons and list messages: Tasks 2, 5, 8.
  - Action webhook parsing: Task 3.
  - Response-context-backed actions: Tasks 1, 5, 7.
  - Record-only negative feedback: Tasks 5, 6.
  - Free-text `Other`: Task 6.
  - Table/Summary views: Task 7.
  - TTL manifests: Tasks 1, 6.
  - Slack regression: Task 9.

- No OpenWA, templates, group chat, CSV/document export, or WhatsApp-origin analyst escalation are implemented.
- New Firestore state lives under `state/` and imports only Firestore/runtime-safe modules.
- WhatsApp builders live under `src/whatsapp/` and do not import Slack Block Kit.
- Direct action IDs are short because they reference `whatsapp_action_context`, not raw provider IDs.
