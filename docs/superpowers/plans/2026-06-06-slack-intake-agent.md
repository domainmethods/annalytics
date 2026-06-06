# Slack Intake Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the hardcoded Slack greeting/help phrase helper with a Gemini Flash intake agent that can generate immediate Slack responses for conversational messages while preserving the normal analytics pipeline for data questions.

**Architecture:** Add a focused `slackIntakeAgent` under `src/agents/` that returns structured JSON with `immediate_response` or `analytics_pipeline`. Add a small shared handler helper so DMs, app mentions, and slash commands use one implementation for intake routing, lock release, event visibility, and fallback behavior. Remove the exact phrase allowlist from `src/handlers/messages.ts`.

**Tech Stack:** TypeScript, `@google/genai`, Zod JSON Schema, Bolt Slack handlers, Vitest mocks.

---

## File Structure

- Create `src/agents/slackIntakeAgent.ts`
  - Owns Gemini Flash structured-output call, prompt, response parsing, safety validation, timeout, and fallback result.
- Create `tests/agents/slackIntakeAgent.test.ts`
  - Unit tests all model outcomes and fallback behavior with mocked `@google/genai`.
- Create `src/handlers/slackIntake.ts`
  - Shared helper for Slack handlers: call intake agent, post immediate response, mark event visible, release lock when needed.
- Create `tests/handlers/slackIntake.test.ts`
  - Tests immediate response path and analytics fallback without importing `src/app.ts`.
- Modify `src/handlers/messages.ts`
  - Remove `getImmediateHelpResponse` and keep only message-surface/clarification helpers.
- Modify `tests/handlers/messages.test.ts`
  - Remove phrase allowlist tests.
- Modify `src/app.ts`
  - Use `maybeHandleSlackIntake()` in the message handler before posting `Understanding your question...`.
- Modify `src/handlers/mentions.ts`
  - Use `maybeHandleSlackIntake()` in app mention handler after preflight, before posting status.
- Modify `src/handlers/commands.ts`
  - Use `maybeHandleSlashCommandIntake()` before posting status.

## Task 1: Add The Flash Slack Intake Agent

**Files:**
- Create: `src/agents/slackIntakeAgent.ts`
- Test: `tests/agents/slackIntakeAgent.test.ts`

- [ ] **Step 1: Write the failing agent tests**

Create `tests/agents/slackIntakeAgent.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGenerateContent = vi.fn();

vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    models = { generateContent: mockGenerateContent };
  },
}));

import { classifySlackIntake } from '../../src/agents/slackIntakeAgent.js';

function modelText(text: string) {
  return { text };
}

describe('classifySlackIntake', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it('returns a model-generated immediate response for a greeting', async () => {
    mockGenerateContent.mockResolvedValue(modelText(JSON.stringify({
      route: 'immediate_response',
      responseText: 'Hi. Ask me an analytics question with a metric and timeframe.',
      reasoning: 'Greeting without analytics request.',
    })));

    const result = await classifySlackIntake('hi', 'api-key');

    expect(result.route).toBe('immediate_response');
    expect(result.responseText).toBe('Hi. Ask me an analytics question with a metric and timeframe.');
    expect(mockGenerateContent).toHaveBeenCalledTimes(1);
    expect(mockGenerateContent.mock.calls[0][0].model).toBe('gemini-flash-latest');
    expect(mockGenerateContent.mock.calls[0][0].config.responseMimeType).toBe('application/json');
    expect(mockGenerateContent.mock.calls[0][0].config.responseJsonSchema).toBeDefined();
  });

  it('returns a model-generated immediate response for a capability question', async () => {
    mockGenerateContent.mockResolvedValue(modelText(JSON.stringify({
      route: 'immediate_response',
      responseText: 'I can help with analytics questions from your modeled data. Include a metric, timeframe, and grouping if needed.',
      reasoning: 'Capability question.',
    })));

    const result = await classifySlackIntake('what can you do?', 'api-key');

    expect(result.route).toBe('immediate_response');
    expect(result.responseText).toContain('modeled data');
  });

  it('routes substantive analytics questions to the analytics pipeline', async () => {
    mockGenerateContent.mockResolvedValue(modelText(JSON.stringify({
      route: 'analytics_pipeline',
      responseText: null,
      reasoning: 'Asks for metric over a time period.',
    })));

    const result = await classifySlackIntake('show leads last month by channel', 'api-key');

    expect(result).toEqual({
      route: 'analytics_pipeline',
      responseText: null,
      reasoning: 'Asks for metric over a time period.',
    });
  });

  it('routes vague analytics prompts to the analytics pipeline', async () => {
    mockGenerateContent.mockResolvedValue(modelText(JSON.stringify({
      route: 'analytics_pipeline',
      responseText: null,
      reasoning: 'Traffic and month imply an analytics request.',
    })));

    const result = await classifySlackIntake('traffic last month?', 'api-key');

    expect(result.route).toBe('analytics_pipeline');
  });

  it('falls back to the analytics pipeline on invalid JSON', async () => {
    mockGenerateContent.mockResolvedValue(modelText('not json'));

    const result = await classifySlackIntake('hi', 'api-key');

    expect(result.route).toBe('analytics_pipeline');
    expect(result.responseText).toBeNull();
    expect(result.reasoning).toContain('fallback');
  });

  it('falls back when immediate response text is empty', async () => {
    mockGenerateContent.mockResolvedValue(modelText(JSON.stringify({
      route: 'immediate_response',
      responseText: '',
      reasoning: 'Greeting.',
    })));

    const result = await classifySlackIntake('hello', 'api-key');

    expect(result.route).toBe('analytics_pipeline');
  });

  it('falls back when immediate response text contains unsafe implementation details', async () => {
    mockGenerateContent.mockResolvedValue(modelText(JSON.stringify({
      route: 'immediate_response',
      responseText: 'I will use dbt and File Search to inspect project.dataset.table.',
      reasoning: 'Unsafe implementation details.',
    })));

    const result = await classifySlackIntake('help', 'api-key');

    expect(result.route).toBe('analytics_pipeline');
  });

  it('falls back on rejected model calls', async () => {
    mockGenerateContent.mockRejectedValue(new Error('Gemini unavailable'));

    const result = await classifySlackIntake('hi', 'api-key');

    expect(result.route).toBe('analytics_pipeline');
    expect(result.responseText).toBeNull();
  });

  it('uses GEMINI_FLASH_MODEL when configured', async () => {
    vi.stubEnv('GEMINI_FLASH_MODEL', 'gemini-custom-flash');
    mockGenerateContent.mockResolvedValue(modelText(JSON.stringify({
      route: 'analytics_pipeline',
      responseText: null,
      reasoning: 'Data question.',
    })));

    await classifySlackIntake('show revenue', 'api-key');

    expect(mockGenerateContent.mock.calls[0][0].model).toBe('gemini-custom-flash');
  });
});
```

- [ ] **Step 2: Run the agent tests and verify they fail**

Run:

```bash
npx vitest run tests/agents/slackIntakeAgent.test.ts
```

Expected: FAIL because `../../src/agents/slackIntakeAgent.js` does not exist.

- [ ] **Step 3: Implement the Slack intake agent**

Create `src/agents/slackIntakeAgent.ts`:

```ts
import { GoogleGenAI } from '@google/genai';
import { z } from 'zod';
import { toJSONSchema } from 'zod/v4/core';
import { getFlashModel } from './modelConfig.js';

const SlackIntakeSchema = z.object({
  route: z.enum(['immediate_response', 'analytics_pipeline']),
  responseText: z.string().nullable(),
  reasoning: z.string(),
});

export type SlackIntakeRoute = 'immediate_response' | 'analytics_pipeline';

export interface SlackIntakeResult {
  route: SlackIntakeRoute;
  responseText: string | null;
  reasoning: string;
}

const FALLBACK_RESULT: SlackIntakeResult = {
  route: 'analytics_pipeline',
  responseText: null,
  reasoning: 'fallback: intake unavailable or unsafe',
};

const MAX_RESPONSE_CHARS = 320;
const INTAKE_TIMEOUT_MS = 2_000;

export async function classifySlackIntake(
  text: string,
  apiKey: string,
  options: { timeoutMs?: number } = {},
): Promise<SlackIntakeResult> {
  try {
    const ai = new GoogleGenAI({ apiKey });
    const response = await withTimeout(
      ai.models.generateContent({
        model: getFlashModel(),
        contents: [{ role: 'user', parts: [{ text: buildPrompt(text) }] }],
        config: {
          responseMimeType: 'application/json',
          responseJsonSchema: toJSONSchema(SlackIntakeSchema),
        },
      }),
      options.timeoutMs ?? INTAKE_TIMEOUT_MS,
    );

    const parsed = SlackIntakeSchema.parse(JSON.parse(response.text || '{}'));
    return sanitizeResult(parsed);
  } catch {
    return FALLBACK_RESULT;
  }
}

function buildPrompt(text: string): string {
  return `Classify this Slack message for an analytics assistant.

MESSAGE:
${text}

Routes:
- immediate_response: greetings, help/capability questions, thanks, or obvious small talk.
- analytics_pipeline: any request about data, metrics, dimensions, time periods, trends, counts, performance, causes, comparisons, or business questions.

If unsure, choose analytics_pipeline.

For immediate_response:
- Write responseText yourself.
- Use at most 2 short sentences.
- Do not include SQL, table names, project/client names, dbt, File Search, or internal implementation details.
- Do not claim available metrics unless the user named them.
- Keep it generic and template-safe.

For analytics_pipeline:
- Set responseText to null.

Return only JSON matching the schema.`;
}

function sanitizeResult(result: SlackIntakeResult): SlackIntakeResult {
  if (result.route === 'analytics_pipeline') {
    return {
      route: 'analytics_pipeline',
      responseText: null,
      reasoning: result.reasoning,
    };
  }

  const responseText = result.responseText?.trim() ?? '';
  if (!responseText || responseText.length > MAX_RESPONSE_CHARS || isUnsafeResponse(responseText)) {
    return FALLBACK_RESULT;
  }

  return {
    route: 'immediate_response',
    responseText,
    reasoning: result.reasoning,
  };
}

function isUnsafeResponse(text: string): boolean {
  const lower = text.toLowerCase();
  if (lower.includes('dbt') || lower.includes('file search')) return true;
  if (text.includes('```') || /\bselect\b.+\bfrom\b/is.test(text)) return true;
  if (/\b[a-z][\w-]+\.[a-z][\w-]+\.[a-z][\w-]+\b/i.test(text)) return true;
  if (/\b[a-z][\w-]+\.[a-z][\w-]+\b/i.test(text) && lower.includes('table')) return true;
  return false;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('Slack intake timeout')), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
```

- [ ] **Step 4: Run the agent tests and verify they pass**

Run:

```bash
npx vitest run tests/agents/slackIntakeAgent.test.ts
```

Expected: PASS, 9 tests.

- [ ] **Step 5: Commit the agent**

Run:

```bash
git add src/agents/slackIntakeAgent.ts tests/agents/slackIntakeAgent.test.ts
git commit -m "feat: add slack intake agent"
```

## Task 2: Add A Shared Slack Intake Handler Helper

**Files:**
- Create: `src/handlers/slackIntake.ts`
- Test: `tests/handlers/slackIntake.test.ts`

- [ ] **Step 1: Write failing handler helper tests**

Create `tests/handlers/slackIntake.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockClassifySlackIntake = vi.fn();

vi.mock('../../src/agents/slackIntakeAgent.js', () => ({
  classifySlackIntake: mockClassifySlackIntake,
}));

import { maybeHandleSlackIntake } from '../../src/handlers/slackIntake.js';

describe('maybeHandleSlackIntake', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('posts model-generated immediate responses and releases the lock', async () => {
    mockClassifySlackIntake.mockResolvedValue({
      route: 'immediate_response',
      responseText: 'Hi. Ask me an analytics question with a metric and timeframe.',
      reasoning: 'Greeting.',
    });
    const client = { chat: { postMessage: vi.fn().mockResolvedValue({ ts: 'reply-1' }) } } as any;
    const markVisible = vi.fn().mockResolvedValue(undefined);
    const releaseLock = vi.fn().mockResolvedValue(undefined);

    const result = await maybeHandleSlackIntake({
      text: 'hi',
      channel: 'C1',
      threadTs: 'T1',
      apiKey: 'api-key',
      client,
      markVisible,
      releaseLock,
    });

    expect(result).toBe(true);
    expect(client.chat.postMessage).toHaveBeenCalledWith({
      channel: 'C1',
      thread_ts: 'T1',
      text: 'Hi. Ask me an analytics question with a metric and timeframe.',
    });
    expect(markVisible).toHaveBeenCalledTimes(1);
    expect(releaseLock).toHaveBeenCalledTimes(1);
  });

  it('returns false without posting when the agent chooses the analytics pipeline', async () => {
    mockClassifySlackIntake.mockResolvedValue({
      route: 'analytics_pipeline',
      responseText: null,
      reasoning: 'Data question.',
    });
    const client = { chat: { postMessage: vi.fn() } } as any;

    const result = await maybeHandleSlackIntake({
      text: 'show leads last month',
      channel: 'C1',
      threadTs: 'T1',
      apiKey: 'api-key',
      client,
    });

    expect(result).toBe(false);
    expect(client.chat.postMessage).not.toHaveBeenCalled();
  });

  it('returns false when an immediate response has no text', async () => {
    mockClassifySlackIntake.mockResolvedValue({
      route: 'immediate_response',
      responseText: null,
      reasoning: 'Bad model output.',
    });
    const client = { chat: { postMessage: vi.fn() } } as any;

    const result = await maybeHandleSlackIntake({
      text: 'hi',
      channel: 'C1',
      threadTs: 'T1',
      apiKey: 'api-key',
      client,
    });

    expect(result).toBe(false);
    expect(client.chat.postMessage).not.toHaveBeenCalled();
  });

  it('omits thread_ts for slash command top-level responses', async () => {
    mockClassifySlackIntake.mockResolvedValue({
      route: 'immediate_response',
      responseText: 'Hi. Ask me an analytics question.',
      reasoning: 'Greeting.',
    });
    const client = { chat: { postMessage: vi.fn().mockResolvedValue({ ts: 'reply-1' }) } } as any;

    const result = await maybeHandleSlackIntake({
      text: 'help',
      channel: 'C1',
      apiKey: 'api-key',
      client,
    });

    expect(result).toBe(true);
    expect(client.chat.postMessage).toHaveBeenCalledWith({
      channel: 'C1',
      text: 'Hi. Ask me an analytics question.',
    });
  });
});
```

- [ ] **Step 2: Run handler helper tests and verify they fail**

Run:

```bash
npx vitest run tests/handlers/slackIntake.test.ts
```

Expected: FAIL because `../../src/handlers/slackIntake.js` does not exist.

- [ ] **Step 3: Implement the shared handler helper**

Create `src/handlers/slackIntake.ts`:

```ts
import type { WebClient } from '@slack/web-api';
import { classifySlackIntake } from '../agents/slackIntakeAgent.js';

interface MaybeHandleSlackIntakeOptions {
  text: string;
  channel: string;
  threadTs?: string;
  apiKey: string;
  client: WebClient;
  markVisible?: () => Promise<void>;
  releaseLock?: () => Promise<void>;
}

export async function maybeHandleSlackIntake(options: MaybeHandleSlackIntakeOptions): Promise<boolean> {
  const result = await classifySlackIntake(options.text, options.apiKey);
  if (result.route !== 'immediate_response' || !result.responseText) return false;

  await options.client.chat.postMessage({
    channel: options.channel,
    ...(options.threadTs ? { thread_ts: options.threadTs } : {}),
    text: result.responseText,
  });

  await options.markVisible?.();
  await options.releaseLock?.();
  return true;
}
```

- [ ] **Step 4: Run handler helper tests and verify they pass**

Run:

```bash
npx vitest run tests/handlers/slackIntake.test.ts
```

Expected: PASS, 4 tests.

- [ ] **Step 5: Commit the handler helper**

Run:

```bash
git add src/handlers/slackIntake.ts tests/handlers/slackIntake.test.ts
git commit -m "feat: add slack intake handler helper"
```

## Task 3: Replace Hardcoded Greeting Helper In Slack Handlers

**Files:**
- Modify: `src/handlers/messages.ts`
- Modify: `tests/handlers/messages.test.ts`
- Modify: `src/app.ts`
- Modify: `src/handlers/mentions.ts`
- Modify: `src/handlers/commands.ts`

- [ ] **Step 1: Remove phrase helper tests from message tests**

Edit `tests/handlers/messages.test.ts`:

```ts
import {
  canMessageEventReachPipeline,
  shouldRespond,
  checkClarificationReply,
} from '../../src/handlers/messages.js';
```

Remove the entire `describe('getImmediateHelpResponse', ...)` block. Keep the `canMessageEventReachPipeline`, `shouldRespond`, and `checkClarificationReply` tests unchanged.

- [ ] **Step 2: Remove hardcoded helper from message handler utilities**

Edit `src/handlers/messages.ts` so it no longer exports `getImmediateHelpResponse` or the `IMMEDIATE_HELP_RESPONSE` constant. The file should keep:

```ts
export function canMessageEventReachPipeline(event: MessageEvent): boolean {
  return isDirectMessageSurface(event) || Boolean(event.thread_ts);
}

export async function shouldRespond(event: MessageEvent): Promise<boolean> {
  if (isDirectMessageSurface(event)) return true;

  if (event.thread_ts) {
    return botHasRepliedInThread(event.thread_ts);
  }

  return false;
}
```

- [ ] **Step 3: Wire `maybeHandleSlackIntake` into the message handler**

Edit `src/app.ts` imports:

```ts
import {
  canMessageEventReachPipeline,
  shouldRespond,
  checkClarificationReply,
} from './handlers/messages.js';
import { maybeHandleSlackIntake } from './handlers/slackIntake.js';
```

Replace the current `getImmediateHelpResponse(msg.text)` block with:

```ts
    const handledByIntake = await maybeHandleSlackIntake({
      text: msg.text || '',
      channel: msg.channel,
      threadTs,
      apiKey: config.gemini.apiKey,
      client,
      markVisible: () => markSlackEventVisible(eventId),
      releaseLock: () => releaseThreadLock(threadTs),
    });
    if (handledByIntake) {
      visibleResponse = true;
      lockHeld = false;
      return;
    }
```

- [ ] **Step 4: Wire `maybeHandleSlackIntake` into app mentions**

Edit `src/handlers/mentions.ts` imports:

```ts
import { maybeHandleSlackIntake } from './slackIntake.js';
```

Remove:

```ts
import { getImmediateHelpResponse } from './messages.js';
```

Replace the current `getImmediateHelpResponse(question)` block with:

```ts
      const handledByIntake = await maybeHandleSlackIntake({
        text: question,
        channel: event.channel,
        threadTs,
        apiKey: config.gemini.apiKey,
        client,
        markVisible: () => markSlackEventVisible(eventId),
        releaseLock: () => releaseThreadLock(threadTs),
      });
      if (handledByIntake) {
        visibleResponse = true;
        lockHeld = false;
        return;
      }
```

- [ ] **Step 5: Wire `maybeHandleSlackIntake` into slash commands**

Edit `src/handlers/commands.ts` imports:

```ts
import { maybeHandleSlackIntake } from './slackIntake.js';
```

Remove:

```ts
import { getImmediateHelpResponse } from './messages.js';
```

Replace the current `getImmediateHelpResponse(command.text)` block with:

```ts
    const handledByIntake = await maybeHandleSlackIntake({
      text: command.text,
      channel: command.channel_id,
      apiKey: config.gemini.apiKey,
      client,
    });
    if (handledByIntake) return;
```

- [ ] **Step 6: Run focused handler and agent tests**

Run:

```bash
npx vitest run tests/agents/slackIntakeAgent.test.ts tests/handlers/slackIntake.test.ts tests/handlers/messages.test.ts tests/state/slackEventDedupe.test.ts tests/state/threadLock.test.ts tests/handlers/preflightChecks.test.ts
```

Expected: PASS. Message tests should no longer reference `getImmediateHelpResponse`.

- [ ] **Step 7: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 8: Commit handler integration**

Run:

```bash
git add src/app.ts src/handlers/commands.ts src/handlers/mentions.ts src/handlers/messages.ts tests/handlers/messages.test.ts
git commit -m "fix: route slack intake through flash"
```

## Task 4: Full Verification, PR Update, And Local Trial Deploy

**Files:**
- No source file edits unless verification exposes a bug in the prior tasks.

- [ ] **Step 1: Run full test suite**

Run:

```bash
npm test
```

Expected: PASS with all Vitest files passing.

- [ ] **Step 2: Run whitespace check**

Run:

```bash
git diff --check
```

Expected: no output and exit code 0.

- [ ] **Step 3: Push PR branch**

Run:

```bash
git push
```

Expected: branch `codex/slack-setup-docs` updates PR #11. If the pre-push hook runs `npm test`, wait for it to pass.

- [ ] **Step 4: Confirm PR checks**

Run:

```bash
gh pr checks 11
```

Expected: `test` passes. `deploy` may be skipped in PR context. If `claude-review` is pending, record that it is pending rather than treating pending as approval.

- [ ] **Step 5: Build and push the local trial image**

Run:

```bash
set -euo pipefail
set -a; . ./.env; set +a
PROJECT_ID="$GCP_PROJECT_ID"
REGION=us-west1
SERVICE_NAME=anna-lytics
SHORT_SHA="$(git rev-parse --short HEAD)"
IMAGE_BASE="$REGION-docker.pkg.dev/$PROJECT_ID/anna-lytics/anna-lytics"
IMAGE_SHA="${IMAGE_BASE}:${SHORT_SHA}"
IMAGE_LATEST="${IMAGE_BASE}:latest"

gcloud config set project "$PROJECT_ID" >/dev/null
gcloud auth configure-docker "$REGION-docker.pkg.dev" --quiet

docker build -t "$IMAGE_SHA" -t "$IMAGE_LATEST" .
docker push "$IMAGE_SHA"
docker push "$IMAGE_LATEST"
```

Expected: Docker build completes, TypeScript compiles inside the image, and both tags push to Artifact Registry.

- [ ] **Step 6: Deploy to Cloud Run**

Run:

```bash
set -euo pipefail
set -a; . ./.env; set +a
PROJECT_ID="$GCP_PROJECT_ID"
REGION=us-west1
SERVICE_NAME=anna-lytics
SHORT_SHA="$(git rev-parse --short HEAD)"
IMAGE_BASE="$REGION-docker.pkg.dev/$PROJECT_ID/anna-lytics/anna-lytics"
IMAGE_SHA="${IMAGE_BASE}:${SHORT_SHA}"

gcloud run deploy "$SERVICE_NAME" \
  --project "$PROJECT_ID" \
  --image "$IMAGE_SHA" \
  --region "$REGION" \
  --service-account "$SERVICE_NAME@$PROJECT_ID.iam.gserviceaccount.com" \
  --set-env-vars "GCP_PROJECT_ID=${PROJECT_ID},FILE_SEARCH_STORE_ID=${FILE_SEARCH_STORE_ID},GEMINI_MODEL=gemini-pro-latest,GEMINI_FLASH_MODEL=gemini-flash-latest,GEMINI_JUDGE_MODEL=gemini-pro-latest" \
  --set-secrets "SLACK_BOT_TOKEN=slack-bot-token:latest,SLACK_SIGNING_SECRET=slack-signing-secret:latest,GEMINI_API_KEY=gemini-api-key:latest" \
  --port 3000 \
  --allow-unauthenticated \
  --quiet
```

Expected: Cloud Run creates a new `anna-lytics` revision and routes 100% traffic to it.

- [ ] **Step 7: Smoke-test health**

Run:

```bash
SERVICE_URL="$(set -a; . ./.env; set +a; gcloud run services describe anna-lytics --project "$GCP_PROJECT_ID" --region us-west1 --format='value(status.url)')"
curl -sS -o /tmp/annalytics-health.out -w 'health_status=%{http_code}\n' "$SERVICE_URL/health"
cat /tmp/annalytics-health.out
```

Expected:

```text
health_status=200
OK
```

- [ ] **Step 8: Manual Slack verification**

In Slack:

1. Send `hi` as a DM to Anna Lytics.
2. Confirm the response is fast and generated by the intake agent.
3. Confirm no `Understanding your question...` message appears for `hi`.
4. Send a real analytics question.
5. Confirm it still enters the normal analytics pipeline and posts `Understanding your question...`.

- [ ] **Step 9: Final status**

Run:

```bash
git status --short --branch
gcloud run services describe anna-lytics --project "$GCP_PROJECT_ID" --region us-west1 --format='table(status.latestReadyRevisionName,status.traffic[0].percent,status.url)'
```

Expected: clean branch except intentional local-only ignored artifacts, and Cloud Run serving 100% traffic from the new revision.

## Self-Review Notes

- Spec coverage: Tasks cover the agent, prompt contract, runtime guardrails, Slack handler flow, tests, PR update, and Cloud Run rollout.
- Placeholder scan: no placeholder steps are intentionally left; each code-writing step includes concrete code.
- Type consistency: `SlackIntakeResult`, `classifySlackIntake`, and `maybeHandleSlackIntake` signatures are consistent across tasks.
