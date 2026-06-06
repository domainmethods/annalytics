# Negative-Feedback Escalation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the 👎 button from a write-only Firestore record into a reason-routed path that reaches a human analyst for genuine data-correctness doubts — without flooding analysts with low-signal clicks.

**Spec:** [docs/superpowers/specs/2026-06-06-negative-feedback-escalation-design.md](../specs/2026-06-06-negative-feedback-escalation-design.md). Design approved 2026-06-06: ephemeral intake, reason required, on-by-default when an escalation target is configured.

**Architecture:** Reuse the existing escalation state machine end-to-end. The 👎 handler keeps recording feedback, then posts an *ephemeral* 4-reason prompt. A new `handlers/feedbackEscalation.ts` routes the chosen reason: the two data-correctness reasons create an `escalation_state` doc (distinct id `esc_fb_${traceId}`, `trigger: 'user_negative_feedback'`, `behavior: 'best_effort_verify'`) and post the standard escalation card to the configured target; "Not what I asked" reuses the refine prompt; "Other" acknowledges only. The analyst reply path (`checkEscalationResponse` → `resumeFromEscalation`) is **unchanged** — `best_effort_verify` already relays the human's review to the user thread and spawns a human-reviewed teaching candidate.

**Tech Stack:** TypeScript, Bolt.js action handlers (`respond` via `response_url`), `@slack/types` Block Kit, Firestore, Vitest mocks.

**Governance:** This is trust infrastructure (guardrail #1) and human-reviewed escalation (guardrail #3) — the *allowed* side of the deferred "automatic correction harvesting from binary feedback" line. Per the maintenance protocol in `docs/trajectory-governance.md`, the governance doc is updated in this same change set (Task 5).

---

## File Structure

- Modify `src/types.ts`
  - Widen `EscalationState['trigger']` with `'user_negative_feedback'`; add optional `context.feedbackReason` and `context.feedbackUserId`.
- Modify `src/config.ts`
  - Add `escalation.onNegativeFeedback: boolean` to `AppConfig` + loader (env `ESCALATION_ON_NEGATIVE_FEEDBACK`, default `true`); add a `parseEnvBool` helper.
- Modify `src/pipeline.ts`
  - Add `escalation.onNegativeFeedback?: boolean` to `PipelineConfig`; pass it through in `toPipelineConfig`; `export` the currently-private `resolveEscalationTarget`.
- Modify `.env.example`
  - Add an Escalation section documenting the existing escalation vars (currently undocumented) plus the new `ESCALATION_ON_NEGATIVE_FEEDBACK`.
- Create `src/slack/feedbackBlocks.ts`
  - Pure Block Kit builders: `buildFeedbackReasonBlocks`, `buildFeedbackAckBlocks`; the `FEEDBACK_REASONS` table and `feedbackReasonById` lookup.
- Create `tests/slack/feedbackBlocks.test.ts`
  - Pure unit tests for the builders (no mocks).
- Create `src/handlers/feedbackEscalation.ts`
  - `promptFeedbackReason` (post ephemeral prompt) and `handleFeedbackReason` (route the chosen reason). All business logic lives here, not in the coverage-excluded `app.ts`.
- Create `tests/handlers/feedbackEscalation.test.ts`
  - Slack + Firestore + escalation-state mocked; covers escalate / dedup / missing-context / refine / other / no-target.
- Modify `src/app.ts`
  - 👎 path calls `promptFeedbackReason` when enabled; register one `/fb_reason_.*/` action handler delegating to `handleFeedbackReason`.
- Modify `docs/trajectory-governance.md`
  - One rationale line recording the boundary (human-reviewed escalation only; teaching outputs stay candidates).

---

## Task 1: Types + Config Plumbing

**Files:**
- Modify: `src/types.ts`
- Modify: `src/config.ts`
- Modify: `src/pipeline.ts`
- Modify: `.env.example`
- Test: `tests/config.test.ts`

- [ ] **Step 1: Write the failing config test**

Add to `tests/config.test.ts` (create the file if it does not exist — see note below). Append these cases inside a `describe('loadConfig escalation.onNegativeFeedback', ...)`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { loadConfig } from '../src/config.js';

// Minimal env so loadConfig() does not throw on requireEnv().
function baseEnv() {
  vi.stubEnv('SLACK_BOT_TOKEN', 'xoxb-test');
  vi.stubEnv('SLACK_SIGNING_SECRET', 'secret');
  vi.stubEnv('GEMINI_API_KEY', 'key');
  vi.stubEnv('GCP_PROJECT_ID', 'proj');
}

describe('loadConfig escalation.onNegativeFeedback', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    baseEnv();
  });

  it('defaults to true when ESCALATION_ON_NEGATIVE_FEEDBACK is unset', () => {
    expect(loadConfig().escalation.onNegativeFeedback).toBe(true);
  });

  it('is false when ESCALATION_ON_NEGATIVE_FEEDBACK="false"', () => {
    vi.stubEnv('ESCALATION_ON_NEGATIVE_FEEDBACK', 'false');
    expect(loadConfig().escalation.onNegativeFeedback).toBe(false);
  });

  it('is true when ESCALATION_ON_NEGATIVE_FEEDBACK="true"', () => {
    vi.stubEnv('ESCALATION_ON_NEGATIVE_FEEDBACK', 'true');
    expect(loadConfig().escalation.onNegativeFeedback).toBe(true);
  });

  it('throws fail-fast on an invalid ESCALATION_ON_NEGATIVE_FEEDBACK value', () => {
    vi.stubEnv('ESCALATION_ON_NEGATIVE_FEEDBACK', 'invalid-value');
    expect(() => loadConfig()).toThrow(/must be "true" or "false"/);
  });
});
```

> Note: if `tests/config.test.ts` already exists, add only the `describe` block and reuse the file's existing imports/helpers rather than redeclaring them.

- [ ] **Step 2: Run the test, verify it fails**

```bash
npx vitest run tests/config.test.ts
```

Expected: fails because `escalation.onNegativeFeedback` is `undefined` (property does not exist yet).

- [ ] **Step 3: Add the config field and parser**

In `src/config.ts`, add `onNegativeFeedback` to the `AppConfig` escalation type:

```ts
  escalation: {
    mode: 'channel' | 'dm';
    channelId?: string;
    analystUserId?: string;
    reminderIntervalMinutes: number;
    timeoutHours: number;
    onNegativeFeedback: boolean;
  };
```

Add a `parseEnvBool` helper next to `parseEnvInt`:

```ts
function parseEnvBool(name: string, defaultVal: boolean): boolean {
  const val = process.env[name];
  if (val === undefined || val === '') return defaultVal;
  // Tolerate trailing whitespace / casing from the OS env so a stray
  // ESCALATION_ON_NEGATIVE_FEEDBACK="true " doesn't fail boot.
  const clean = val.trim().toLowerCase();
  if (clean === 'true') return true;
  if (clean === 'false') return false;
  throw new Error(`Invalid config: ${name} must be "true" or "false", got "${val}"`);
}
```

In the `loadConfig()` escalation block, add the field:

```ts
    escalation: {
      mode: parseEscalationMode(process.env.ESCALATION_MODE),
      channelId: process.env.ESCALATION_CHANNEL_ID || undefined,
      analystUserId: process.env.ESCALATION_ANALYST_USER_ID || undefined,
      reminderIntervalMinutes: parseEnvInt('ESCALATION_REMINDER_MINUTES', 30),
      timeoutHours: parseEnvInt('ESCALATION_TIMEOUT_HOURS', 4),
      onNegativeFeedback: parseEnvBool('ESCALATION_ON_NEGATIVE_FEEDBACK', true),
    },
```

- [ ] **Step 4: Run the test, verify it passes**

```bash
npx vitest run tests/config.test.ts
```

Expected: all three cases pass.

- [ ] **Step 5: Widen the EscalationState type**

In `src/types.ts`, widen the `trigger` union and add the two optional context fields:

```ts
  trigger: 'supervisor_exhausted' | 'mid_pipeline_ambiguity' | 'quality_loop_exhausted' | 'user_negative_feedback';
  behavior: 'best_effort_verify' | 'park_wait';
  stageToResume: 'sql_generation' | 'supervisor_review';
  context: {
    clarifiedQuestion: string;
    userQuestion: string;
    groundingCitations: GroundingCitation[];
    previousSql?: string;
    supervisorNotes?: string;
    ambiguityDescription?: string;
    feedbackReason?: string;
    feedbackUserId?: string;
  };
```

- [ ] **Step 6: Plumb the flag through PipelineConfig and export the target resolver**

In `src/pipeline.ts`, add `onNegativeFeedback` to the `PipelineConfig` escalation type:

```ts
  escalation?: {
    mode: 'channel' | 'dm';
    channelId?: string;
    analystUserId?: string;
    timeoutHours: number;
    onNegativeFeedback?: boolean;
  };
```

Pass it through in `toPipelineConfig`:

```ts
    escalation: {
      mode: config.escalation.mode,
      channelId: config.escalation.channelId,
      analystUserId: config.escalation.analystUserId,
      timeoutHours: config.escalation.timeoutHours,
      onNegativeFeedback: config.escalation.onNegativeFeedback,
    },
```

Export the currently-private resolver (change the declaration only — body unchanged):

```ts
export function resolveEscalationTarget(
  escalation?: PipelineConfig['escalation'],
): string | null {
```

- [ ] **Step 7: Document the escalation env vars**

In `.env.example`, add an Escalation section (the existing escalation vars are currently undocumented — this closes that gap). Place it near the other app config, template-safe (no real channel/user IDs):

```bash
# Escalation (human-in-the-loop). mode=channel posts to ESCALATION_CHANNEL_ID;
# mode=dm DMs ESCALATION_ANALYST_USER_ID. Escalation is skipped if no target resolves.
ESCALATION_MODE=channel
ESCALATION_CHANNEL_ID=
ESCALATION_ANALYST_USER_ID=
ESCALATION_REMINDER_MINUTES=30
ESCALATION_TIMEOUT_HOURS=4
# Route 👎 "wrong number" / "wrong data" feedback to the analyst (default true).
ESCALATION_ON_NEGATIVE_FEEDBACK=true
```

- [ ] **Step 8: Typecheck and commit**

```bash
npm run typecheck
npx vitest run tests/config.test.ts
git add -A && git commit -m "feat: add escalation.onNegativeFeedback config + user_negative_feedback trigger"
```

Expected: typecheck clean, config tests pass.

## Task 2: Feedback Reason Block Builders

**Files:**
- Create: `src/slack/feedbackBlocks.ts`
- Test: `tests/slack/feedbackBlocks.test.ts`

- [ ] **Step 1: Write the failing block tests**

Create `tests/slack/feedbackBlocks.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  buildFeedbackReasonBlocks,
  buildFeedbackAckBlocks,
  feedbackReasonById,
  FEEDBACK_REASONS,
  FEEDBACK_REASON_PREFIX,
} from '../../src/slack/feedbackBlocks.js';

describe('buildFeedbackReasonBlocks', () => {
  const compoundKey = '1700000000.000100_1700000000.000200';

  it('renders one button per reason with prefixed action_id and the compound key as value', () => {
    const blocks = buildFeedbackReasonBlocks(compoundKey);
    const actions = blocks.find(b => b.type === 'actions') as any;
    expect(actions).toBeDefined();
    expect(actions.elements).toHaveLength(FEEDBACK_REASONS.length);

    for (const el of actions.elements) {
      expect(el.type).toBe('button');
      expect(el.action_id).toMatch(new RegExp(`^${FEEDBACK_REASON_PREFIX}`));
      expect(el.value).toBe(compoundKey);
    }
  });

  it('encodes each reason id in its action_id', () => {
    const blocks = buildFeedbackReasonBlocks(compoundKey);
    const actions = blocks.find(b => b.type === 'actions') as any;
    const ids = actions.elements.map((e: any) => e.action_id);
    expect(ids).toEqual(FEEDBACK_REASONS.map(r => `${FEEDBACK_REASON_PREFIX}${r.id}`));
  });

  it('includes a prompt section', () => {
    const blocks = buildFeedbackReasonBlocks(compoundKey);
    expect(blocks.some(b => b.type === 'section')).toBe(true);
  });
});

describe('feedbackReasonById', () => {
  it('maps the two data-correctness reasons to escalate', () => {
    expect(feedbackReasonById('wrong_number')?.route).toBe('escalate');
    expect(feedbackReasonById('wrong_data')?.route).toBe('escalate');
  });

  it('maps not_asked to refine and other to record', () => {
    expect(feedbackReasonById('not_asked')?.route).toBe('refine');
    expect(feedbackReasonById('other')?.route).toBe('record');
  });

  it('returns undefined for an unknown id', () => {
    expect(feedbackReasonById('nope')).toBeUndefined();
  });
});

describe('buildFeedbackAckBlocks', () => {
  it('wraps the message in a single section block', () => {
    const blocks = buildFeedbackAckBlocks('✅ Flagged for the data team.');
    expect(blocks).toHaveLength(1);
    expect((blocks[0] as any).text.text).toBe('✅ Flagged for the data team.');
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

```bash
npx vitest run tests/slack/feedbackBlocks.test.ts
```

Expected: fails — module does not exist yet.

- [ ] **Step 3: Implement the block builders**

Create `src/slack/feedbackBlocks.ts`:

```ts
import type { KnownBlock, SectionBlock, ActionsBlock } from '@slack/types';

export const FEEDBACK_REASON_PREFIX = 'fb_reason_';

export type FeedbackRoute = 'escalate' | 'refine' | 'record';

export interface FeedbackReason {
  id: string;
  label: string;
  route: FeedbackRoute;
}

// Order here is the button order in the prompt.
export const FEEDBACK_REASONS: FeedbackReason[] = [
  { id: 'wrong_number', label: 'Wrong number', route: 'escalate' },
  { id: 'wrong_data', label: 'Wrong data / tables', route: 'escalate' },
  { id: 'not_asked', label: 'Not what I asked', route: 'refine' },
  { id: 'other', label: 'Other', route: 'record' },
];

export function feedbackReasonById(id: string): FeedbackReason | undefined {
  return FEEDBACK_REASONS.find(r => r.id === id);
}

/**
 * Ephemeral prompt shown after a 👎. Each button carries the compound key
 * (`${threadTs}_${statusMsgTs}`) as its value so the reason handler can load the
 * persisted ResponseContext; the reason id is encoded in the action_id.
 */
export function buildFeedbackReasonBlocks(compoundKey: string): KnownBlock[] {
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: 'Thanks for the flag — what was off? This routes it to the right fix.',
      },
    } as SectionBlock,
    {
      type: 'actions',
      block_id: `${FEEDBACK_REASON_PREFIX}actions`,
      elements: FEEDBACK_REASONS.map(reason => ({
        type: 'button',
        action_id: `${FEEDBACK_REASON_PREFIX}${reason.id}`,
        text: { type: 'plain_text', text: reason.label },
        value: compoundKey,
      })),
    } as ActionsBlock,
  ];
}

export function buildFeedbackAckBlocks(message: string): KnownBlock[] {
  return [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: message },
    } as SectionBlock,
  ];
}
```

- [ ] **Step 4: Run the test, verify it passes**

```bash
npx vitest run tests/slack/feedbackBlocks.test.ts
npm run typecheck
```

Expected: all cases pass; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: add feedback reason block builders"
```

## Task 3: Feedback Escalation Handler

**Files:**
- Create: `src/handlers/feedbackEscalation.ts`
- Test: `tests/handlers/feedbackEscalation.test.ts`

This is the core routing logic. It mirrors `handlers/escalationResponse.ts`: pure-ish orchestration that depends only on injected `client`/`config` and the state modules, so it is fully testable without `app.ts`.

- [ ] **Step 1: Write the failing handler tests**

Create `tests/handlers/feedbackEscalation.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the state modules the way the sibling handler test does
// (tests/handlers/escalationResponse.test.ts): auto-mock the module, then grab
// typed handles via vi.mocked() after import. This is the repo convention for
// handler tests and avoids any hoisting/TDZ ambiguity around the factory.
vi.mock('../../src/state/responseContext.js');
vi.mock('../../src/state/escalationState.js');

import { getResponseContext } from '../../src/state/responseContext.js';
import { hasPendingEscalation, saveEscalationState } from '../../src/state/escalationState.js';
import { promptFeedbackReason, handleFeedbackReason } from '../../src/handlers/feedbackEscalation.js';
import type { PipelineConfig } from '../../src/pipeline.js';
import type { ResponseContext } from '../../src/types.js';

const mockGetResponseContext = vi.mocked(getResponseContext);
const mockHasPendingEscalation = vi.mocked(hasPendingEscalation);
const mockSaveEscalationState = vi.mocked(saveEscalationState);

const compoundKey = '1700000000.000100_1700000000.000200';

function makeConfig(over: Partial<NonNullable<PipelineConfig['escalation']>> = {}): PipelineConfig {
  return {
    geminiApiKey: 'k',
    maxBytesProcessed: 1,
    queryTimeoutMs: 1,
    maxResultRows: 1,
    escalation: {
      mode: 'channel',
      channelId: 'C_ESC',
      timeoutHours: 4,
      onNegativeFeedback: true,
      ...over,
    },
  };
}

function makeCtx() {
  return {
    traceId: 'trace-1',
    clarifiedQuestion: 'unique visitors last month',
    generatedSql: 'SELECT 1',
    groundingCitations: [],
    supervisorNotes: 'n',
    queryResults: { rowCount: 1, columnNames: ['x'], bytesProcessed: 1 },
  };
}

function makeClient() {
  return {
    chat: {
      postEphemeral: vi.fn().mockResolvedValue({ ok: true }),
      postMessage: vi.fn().mockResolvedValue({ ok: true, ts: '1700000000.000300' }),
    },
  } as any;
}

describe('promptFeedbackReason', () => {
  beforeEach(() => vi.clearAllMocks());

  it('posts an ephemeral reason prompt to the clicking user', async () => {
    const client = makeClient();
    await promptFeedbackReason({
      client,
      channel: 'C1',
      userId: 'U1',
      threadTs: '1700000000.000100',
      statusMsgTs: '1700000000.000200',
    });
    expect(client.chat.postEphemeral).toHaveBeenCalledTimes(1);
    const arg = client.chat.postEphemeral.mock.calls[0][0];
    expect(arg.channel).toBe('C1');
    expect(arg.user).toBe('U1');
    expect(arg.blocks).toBeDefined();
  });
});

describe('handleFeedbackReason', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // makeCtx() returns only the fields the handler reads; cast to satisfy the
    // mocked getResponseContext return type (Promise<ResponseContext | null>).
    mockGetResponseContext.mockResolvedValue(makeCtx() as unknown as ResponseContext);
    mockHasPendingEscalation.mockResolvedValue(false);
    mockSaveEscalationState.mockResolvedValue(undefined);
  });

  it('escalates a "wrong_number" reason: posts the card and saves esc_fb_ state', async () => {
    const client = makeClient();
    const respond = vi.fn().mockResolvedValue(undefined);
    await handleFeedbackReason({
      reasonId: 'wrong_number',
      compoundKey,
      userId: 'U1',
      channel: 'C1',
      client,
      respond,
      config: makeConfig(),
    });

    expect(client.chat.postMessage).toHaveBeenCalledTimes(1);
    expect(client.chat.postMessage.mock.calls[0][0].channel).toBe('C_ESC');

    expect(mockSaveEscalationState).toHaveBeenCalledTimes(1);
    const [state, timeoutHours] = mockSaveEscalationState.mock.calls[0];
    expect(state.escalationId).toBe('esc_fb_trace-1');
    expect(state.trigger).toBe('user_negative_feedback');
    expect(state.behavior).toBe('best_effort_verify');
    expect(state.originalThreadTs).toBe('1700000000.000100');
    expect(state.originalChannel).toBe('C1');
    expect(state.statusMsgTs).toBe('1700000000.000200');
    expect(state.context.feedbackReason).toBe('Wrong number');
    expect(state.context.feedbackUserId).toBe('U1');
    expect(state.context.previousSql).toBe('SELECT 1');
    expect(timeoutHours).toBe(4);

    expect(respond).toHaveBeenCalledTimes(1);
    expect(respond.mock.calls[0][0].replace_original).toBe(true);
  });

  it('does not double-escalate when one is already pending', async () => {
    mockHasPendingEscalation.mockResolvedValue(true);
    const client = makeClient();
    const respond = vi.fn();
    await handleFeedbackReason({
      reasonId: 'wrong_data', compoundKey, userId: 'U1', channel: 'C1', client, respond, config: makeConfig(),
    });
    expect(mockSaveEscalationState).not.toHaveBeenCalled();
    expect(client.chat.postMessage).not.toHaveBeenCalled();
    expect(respond.mock.calls[0][0].text).toMatch(/already flagged/i);
  });

  it('degrades gracefully when the response context is gone', async () => {
    mockGetResponseContext.mockResolvedValue(null);
    const client = makeClient();
    const respond = vi.fn();
    await handleFeedbackReason({
      reasonId: 'wrong_number', compoundKey, userId: 'U1', channel: 'C1', client, respond, config: makeConfig(),
    });
    expect(mockSaveEscalationState).not.toHaveBeenCalled();
    expect(respond.mock.calls[0][0].text).toMatch(/re-ask/i);
  });

  it('routes "not_asked" to the refine prompt, no escalation', async () => {
    const client = makeClient();
    const respond = vi.fn();
    await handleFeedbackReason({
      reasonId: 'not_asked', compoundKey, userId: 'U1', channel: 'C1', client, respond, config: makeConfig(),
    });
    expect(mockSaveEscalationState).not.toHaveBeenCalled();
    // Refine prompt posted publicly in-thread.
    expect(client.chat.postMessage).toHaveBeenCalledTimes(1);
    expect(client.chat.postMessage.mock.calls[0][0].thread_ts).toBe('1700000000.000100');
  });

  it('records "other" with an ack only — no escalation, no public post', async () => {
    const client = makeClient();
    const respond = vi.fn();
    await handleFeedbackReason({
      reasonId: 'other', compoundKey, userId: 'U1', channel: 'C1', client, respond, config: makeConfig(),
    });
    expect(mockSaveEscalationState).not.toHaveBeenCalled();
    expect(client.chat.postMessage).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledTimes(1);
  });

  it('record-only degrade when no escalation target is configured', async () => {
    const client = makeClient();
    const respond = vi.fn();
    await handleFeedbackReason({
      reasonId: 'wrong_number', compoundKey, userId: 'U1', channel: 'C1', client, respond,
      config: makeConfig({ channelId: undefined }),
    });
    expect(mockSaveEscalationState).not.toHaveBeenCalled();
    expect(client.chat.postMessage).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledTimes(1);
  });

  it.each(['malformedkey', 'threadts_', '_statusts', 'a_b_c'])(
    'degrades on a malformed compound key (%s) without writing state',
    async (badKey) => {
      const client = makeClient();
      const respond = vi.fn();
      await handleFeedbackReason({
        reasonId: 'wrong_number', compoundKey: badKey, userId: 'U1', channel: 'C1', client, respond, config: makeConfig(),
      });
      expect(mockSaveEscalationState).not.toHaveBeenCalled();
      expect(client.chat.postMessage).not.toHaveBeenCalled();
      expect(respond).toHaveBeenCalledTimes(1);
    },
  );
});
```

- [ ] **Step 2: Run the test, verify it fails**

```bash
npx vitest run tests/handlers/feedbackEscalation.test.ts
```

Expected: fails — module does not exist yet.

- [ ] **Step 3: Implement the handler**

Create `src/handlers/feedbackEscalation.ts`:

```ts
import type { WebClient } from '@slack/web-api';
import type { KnownBlock } from '@slack/types';
import type { PipelineConfig } from '../pipeline.js';
import { resolveEscalationTarget } from '../pipeline.js';
import { getResponseContext } from '../state/responseContext.js';
import { hasPendingEscalation, saveEscalationState } from '../state/escalationState.js';
import { buildEscalationBlocks } from '../slack/escalationBlocks.js';
import {
  buildFeedbackReasonBlocks,
  buildFeedbackAckBlocks,
  feedbackReasonById,
} from '../slack/feedbackBlocks.js';

/** Bolt's `respond` updates the ephemeral message via its response_url. */
export type RespondFn = (message: {
  text?: string;
  blocks?: KnownBlock[];
  replace_original?: boolean;
  response_type?: 'ephemeral' | 'in_channel';
}) => Promise<unknown>;

export interface PromptFeedbackReasonParams {
  client: WebClient;
  channel: string;
  userId: string;
  threadTs: string;
  statusMsgTs: string;
}

/**
 * Posts the ephemeral 4-reason prompt to the user who clicked 👎. The public
 * thread stays clean; only the resolution (if any) posts publicly later.
 */
export async function promptFeedbackReason(params: PromptFeedbackReasonParams): Promise<void> {
  const compoundKey = `${params.threadTs}_${params.statusMsgTs}`;
  await params.client.chat.postEphemeral({
    channel: params.channel,
    user: params.userId,
    thread_ts: params.threadTs,
    text: 'What was off about this answer?',
    blocks: buildFeedbackReasonBlocks(compoundKey) as unknown as KnownBlock[],
  });
}

export interface HandleFeedbackReasonParams {
  reasonId: string;
  compoundKey: string;
  userId: string;
  channel: string;
  client: WebClient;
  respond: RespondFn;
  config: PipelineConfig;
}

/**
 * Routes a chosen 👎 reason:
 *  - escalate (wrong_number / wrong_data) → create esc_fb_ escalation + post card
 *  - refine (not_asked)                   → public refine prompt in-thread
 *  - record (other / unknown)             → ephemeral ack only
 */
export async function handleFeedbackReason(params: HandleFeedbackReasonParams): Promise<void> {
  const { reasonId, compoundKey, userId, channel, client, respond, config } = params;
  const reason = feedbackReasonById(reasonId);

  // Unknown reason id → treat as record-only.
  if (!reason || reason.route === 'record') {
    await respond({ replace_original: true, text: 'Thanks — noted. I logged this for review.' });
    return;
  }

  // Slack ts values use '.', never '_', so a well-formed compound key splits
  // into exactly two non-empty parts. Validate before use — statusMsgTs is a
  // required field in the EscalationState write contract, so an undefined part
  // would corrupt the Firestore doc.
  const parts = compoundKey.split('_');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    await respond({
      replace_original: true,
      text: "I can't pull this answer's details anymore — please re-ask and I'll take another run at it.",
    });
    return;
  }
  const [threadTs, statusMsgTs] = parts;

  if (reason.route === 'refine') {
    // Reuse the exact wording of the existing `refine_assumptions` handler in
    // app.ts so the refine UX is consistent regardless of entry point.
    await client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text: "What should I change about my assumptions? Reply with your corrections and I'll re-run the query.",
    });
    await respond({ replace_original: true, text: 'Got it — let me know what to change in the thread.' });
    return;
  }

  // route === 'escalate'
  const target = resolveEscalationTarget(config.escalation);
  if (!target) {
    // No analyst target configured → record-only degrade.
    await respond({ replace_original: true, text: 'Thanks — noted. (No data-team channel is configured.)' });
    return;
  }

  const ctx = await getResponseContext(compoundKey);
  if (!ctx) {
    await respond({
      replace_original: true,
      text: "I can't pull this answer's details anymore — please re-ask and I'll take another run at it.",
    });
    return;
  }

  if (await hasPendingEscalation(threadTs)) {
    await respond({ replace_original: true, text: "✅ This thread is already flagged for the data team." });
    return;
  }

  const escalationMsg = await client.chat.postMessage({
    channel: target,
    text: `Anna Lytics flagged answer: "${ctx.clarifiedQuestion}"`,
    blocks: buildEscalationBlocks({
      userQuestion: ctx.clarifiedQuestion,
      channelName: `<#${channel}>`,
      threadLink: `slack://channel?id=${channel}&message=${threadTs}`,
      stuckDescription: `User flagged this answer as "${reason.label}". Please verify and reply with a correction.`,
      bestGuessSql: ctx.generatedSql,
    }) as unknown as KnownBlock[],
  });

  await saveEscalationState({
    escalationId: `esc_fb_${ctx.traceId}`,
    originalThreadTs: threadTs,
    originalChannel: channel,
    trigger: 'user_negative_feedback',
    behavior: 'best_effort_verify',
    stageToResume: 'supervisor_review',
    context: {
      clarifiedQuestion: ctx.clarifiedQuestion,
      userQuestion: ctx.clarifiedQuestion,
      groundingCitations: ctx.groundingCitations,
      previousSql: ctx.generatedSql,
      supervisorNotes: ctx.supervisorNotes,
      feedbackReason: reason.label,
      feedbackUserId: userId,
    },
    escalationChannel: target,
    escalationTs: escalationMsg.ts!,
    statusMsgTs,
    bestEffortSql: ctx.generatedSql,
    traceId: ctx.traceId,
  }, config.escalation?.timeoutHours ?? 4);

  await respond({
    replace_original: true,
    blocks: buildFeedbackAckBlocks("✅ Flagged for the data team — I'll reply here when they weigh in.") as unknown as KnownBlock[],
    text: 'Flagged for the data team.',
  });
}
```

- [ ] **Step 4: Run the test, verify it passes**

```bash
npx vitest run tests/handlers/feedbackEscalation.test.ts
npm run typecheck
```

Expected: all cases pass; typecheck clean.

> If typecheck flags `buildFeedbackAckBlocks(...) as unknown as KnownBlock[]` or the `escalationMsg.ts` access, mirror the exact cast style already used in `handlers/escalationResponse.ts` and `pipeline.ts` (they use `as unknown as KnownBlock[]` and `escalationMsg.ts!`).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: add feedback escalation handler (reason routing)"
```

## Task 4: Wire Into app.ts

**Files:**
- Modify: `src/app.ts`

`app.ts` is the coverage-excluded entry point — no new business logic here, only wiring. Verification for this task is typecheck + full suite + manual Slack check (the logic itself is covered by Task 3).

- [ ] **Step 1: Import the handler and converter**

In `src/app.ts`, add imports alongside the existing handler imports:

```ts
import { promptFeedbackReason, handleFeedbackReason } from './handlers/feedbackEscalation.js';
import { toPipelineConfig, resolveEscalationTarget } from './pipeline.js';
import { FEEDBACK_REASON_PREFIX } from './slack/feedbackBlocks.js';
```

> If `toPipelineConfig` is already imported in `app.ts`, merge the named imports rather than duplicating the line.

- [ ] **Step 2: Extend the 👎 handler to prompt for a reason**

Replace the body of the existing `app.action(/thumbs_(up|down)_.*/, ...)` handler so that, after recording feedback, a negative click triggers the reason prompt when the feature is enabled and a target is configured:

```ts
app.action(/thumbs_(up|down)_.*/, async ({ action, ack, body, client }) => {
  await ack();
  const btn = action as { value?: string; action_id: string };
  const traceId = btn.value;
  const feedbackType = btn.action_id.startsWith('thumbs_up') ? 'positive' : 'negative';
  rootLogger.info({ traceId, feedbackType, userId: body.user.id }, 'feedback.received');

  const threadTs = (body as any).message?.thread_ts || (body as any).message?.ts;
  const messageTs = (body as any).message?.ts;
  if (threadTs && messageTs) {
    await recordFeedback(threadTs, messageTs, feedbackType as 'positive' | 'negative');
  }

  // On 👎, offer the reason prompt only when negative-feedback escalation is
  // enabled AND an escalation target actually resolves — using the same resolver
  // the handler uses, so we never prompt when escalation couldn't fire (e.g.
  // mode=channel with only an analyst DM id set). No target ⇒ record-only, per
  // the design's on-by-default decision.
  const feedbackEscalationTarget = config.escalation.onNegativeFeedback
    ? resolveEscalationTarget(toPipelineConfig(config).escalation)
    : null;
  if (feedbackType === 'negative' && threadTs && messageTs && feedbackEscalationTarget) {
    const channel = (body as any).channel?.id;
    if (channel) {
      await promptFeedbackReason({
        client,
        channel,
        userId: body.user.id,
        threadTs,
        statusMsgTs: messageTs,
      });
    }
  }
});
```

> Note: `client` is destructured from the Bolt action middleware args (a `WebClient`), matching the adjacent `show_sql`/`hide_reasoning` handlers — no need for `app.client`.

- [ ] **Step 3: Register the reason action handler**

Add a new action handler (place it near the other feedback/SQL handlers):

```ts
// Reason selected on the ephemeral 👎 prompt — route to escalate/refine/record.
app.action(new RegExp(`^${FEEDBACK_REASON_PREFIX}.*`), async ({ action, ack, body, client, respond }) => {
  await ack();
  const btn = action as { value?: string; action_id: string };
  const compoundKey = btn.value;
  if (!compoundKey) return;

  const reasonId = btn.action_id.slice(FEEDBACK_REASON_PREFIX.length);
  const channel = (body as any).channel?.id;
  if (!channel) return;

  await handleFeedbackReason({
    reasonId,
    compoundKey,
    userId: body.user.id,
    channel,
    client,
    respond,
    config: toPipelineConfig(config),
  });
});
```

> `respond` is provided by Bolt for actions originating from messages with a `response_url` — buttons inside an ephemeral message qualify, so `replace_original: true` updates the ephemeral prompt in place.

- [ ] **Step 4: Typecheck and run the full suite**

```bash
npm run typecheck
npm test
```

Expected: typecheck clean; entire suite green (including the new config/blocks/handler tests).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: wire negative-feedback reason prompt into Slack handlers"
```

## Task 5: Governance Update + Final Verification

**Files:**
- Modify: `docs/trajectory-governance.md`

- [ ] **Step 1: Record the governance boundary**

In `docs/trajectory-governance.md`, add one rationale line (in the appropriate maintenance/decision-log section — match the document's existing structure) stating the boundary this feature respects:

```text
- 2026-06-06 — Negative-feedback escalation (👎 → reason prompt → analyst) shipped as trust
  infrastructure (guardrail #1) and human-reviewed escalation (guardrail #3). Boundary: it
  routes a human's correction to a human analyst and reuses the existing teaching-CANDIDATE
  flow only. It does NOT auto-promote feedback into retrieval and does NOT lower the pipeline
  escalation threshold — both remain on the deferred "automatic correction harvesting from
  binary feedback" line. Spec: docs/superpowers/specs/2026-06-06-negative-feedback-escalation-design.md.
```

- [ ] **Step 2: Full verification**

```bash
npm run typecheck
npm test
```

Expected: typecheck clean; full suite green.

- [ ] **Step 3: Manual Slack verification (after deploy, separate authorization)**

> Deploy is a separate, explicitly-authorized step — do not deploy as part of executing this plan unless the user asks. When deployed, verify in Slack:

1. Ask a data question and let it answer.
2. Click 👎 → confirm an **ephemeral** reason prompt appears (only you see it) with four buttons.
3. Click **Wrong number** → confirm the ephemeral updates to "Flagged for the data team" and an escalation card lands in the configured channel/DM.
4. In the escalation thread, reply with a correction → confirm it is relayed back into the original user thread (existing `resumeFromEscalation` path).
5. Click 👎 on another answer → **Not what I asked** → confirm a refine prompt posts in-thread and no escalation is created.
6. Click 👎 → **Other** → confirm only an ephemeral ack, nothing public, no escalation.
7. With `ESCALATION_ON_NEGATIVE_FEEDBACK=false` (or no target configured), confirm 👎 records silently with no reason prompt.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "docs: record negative-feedback escalation governance boundary"
```

## Self-Review Notes

- **Spec coverage:** Tasks cover every "New / changed" item in the spec — types widening (Task 1), `feedbackBlocks.ts` (Task 2), `feedbackEscalation.ts` with `promptFeedbackReason`/`handleFeedbackReason` (Task 3), `app.ts` wiring + `resolveEscalationTarget` export + config flag (Tasks 1, 4), and the governance update (Task 5). The reuse map's "Unchanged" modules (`resumeFromEscalation`, `checkOverdueEscalations`, teaching flow) are deliberately untouched.
- **Phasing vs spec:** This plan delivers the spec's Phase 1 **and** Phase 2 in one change. The spec's Sequencing section originally split "Not what I asked" → refine into Phase 2, but it is folded in here because the route is near-free (post the existing refine prompt; no human, no state). The spec's Sequencing section was updated to record this. Phase 3 (low-confidence spot-check) remains explicitly out of scope.
- **Spec guards covered by tests:** de-dup via `hasPendingEscalation` (Task 3 test), missing-context degrade, no-target degrade, malformed-compound-key degrade, refine route, record route, escalate-state shape (`esc_fb_` id, `user_negative_feedback` trigger, `best_effort_verify`).
- **Mocking convention:** Task 3's test uses `vi.mock('...js')` + `vi.mocked()`, matching the nearest sibling handler test (`tests/handlers/escalationResponse.test.ts`) rather than the external-lib factory style used in `tests/execution/runner.test.ts`.
- **Placeholder scan:** every code-writing step contains complete, concrete code; no `TODO`/`...` placeholders. The only judgement call flagged inline is matching the existing `as unknown as KnownBlock[]` cast style (Task 3 Step 4 note).
- **Type consistency:** `FeedbackReason`/`FeedbackRoute`, `RespondFn`, `PromptFeedbackReasonParams`, `HandleFeedbackReasonParams`, and the `EscalationState` fields used in `saveEscalationState(...)` match the interfaces in `src/types.ts` and `src/pipeline.ts`. The escalation `context.userQuestion` is populated from `ctx.clarifiedQuestion` because `ResponseContext` does not persist the raw user question — acceptable for the teaching-candidate input and noted here intentionally.
- **Template safety:** no client-specific IDs, project IDs, store IDs, or secrets are introduced; `.env.example` additions use empty placeholders.

## Execution Handoff

Two ways to execute this plan:

- **Subagent-Driven (recommended):** I dispatch a fresh implementer subagent per task, followed by a spec-compliance review then a code-quality review, looping fixes until each passes — all in this session. Best quality, no context pollution between tasks.
- **Inline:** I implement the tasks directly in this conversation, task by task.

Tell me which you'd like, and whether to start now.
