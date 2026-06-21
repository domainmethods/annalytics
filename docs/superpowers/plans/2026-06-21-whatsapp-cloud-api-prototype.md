# WhatsApp Cloud API Prototype Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a feature-flagged WhatsApp Cloud API prototype that accepts one-to-one text questions and returns compact Annalytics answers without changing Slack behavior.

**Architecture:** Add pure WhatsApp modules for config, signature verification, payload parsing, outbound sending, rendering, and dedupe before wiring the route. Add a narrow `runWhatsAppPipeline` that reuses existing pipeline stage helpers and emits plain text, leaving Slack `runPipeline` intact. Slack remains the analyst surface; this prototype does not create or resolve WhatsApp-origin async escalations.

**Tech Stack:** TypeScript, Express router from Slack Bolt `ExpressReceiver`, Vitest, Firestore, BigQuery, Gemini, Meta WhatsApp Cloud API over `fetch`, existing Annalytics pipeline modules.

---

## File Structure

- Create `src/channels/types.ts`
  - Shared channel contracts for WhatsApp prototype code.
- Create `src/whatsapp/keys.ts`
  - Surface-qualified key helpers for dedupe, conversation, clarification, and response context ids.
- Create `src/whatsapp/signature.ts`
  - HMAC-SHA256 verification for Meta webhook POST bodies.
- Create `src/whatsapp/payload.ts`
  - Parse WhatsApp webhook payloads into normalized channel messages and unsupported-message notices.
- Create `src/whatsapp/client.ts`
  - Minimal Cloud API text sender with injectable `fetch`.
- Create `src/whatsapp/renderer.ts`
  - Plain-text renderer for Annalytics query results and control messages.
- Create `src/whatsapp/pipeline.ts`
  - Narrow WhatsApp runner that produces outbound WhatsApp text.
- Create `src/handlers/whatsappMessages.ts`
  - Inbound orchestration: allowlist, dedupe, rate limit, clarification resume, pending escalation guard, pipeline call.
- Create `src/whatsapp/webhook.ts`
  - Express route registration for Meta GET verification and POST webhook events.
- Modify `src/config.ts`
  - Add optional WhatsApp config and require secrets only when enabled.
- Modify `src/types.ts`
  - Add optional surface metadata to response contexts.
- Modify `src/app.ts`
  - Register WhatsApp webhook only when enabled and expose doctor configuration state.
- Modify `src/state/responseContext.ts`
  - Keep current API intact; encode WhatsApp status message ids in doc ids without importing channel modules.
- Modify `infra/firestore.ttls.json`
  - Add TTL coverage for WhatsApp inbound dedupe docs.
- Modify `docs/trajectory-governance.md`
  - Record WhatsApp as a gated channel prototype before treating it as active product surface.
- Modify `.env.example`
  - Document WhatsApp env var names with empty example values only.
- Test files:
  - `tests/whatsapp/keys.test.ts`
  - `tests/whatsapp/signature.test.ts`
  - `tests/whatsapp/payload.test.ts`
  - `tests/whatsapp/client.test.ts`
  - `tests/whatsapp/renderer.test.ts`
  - `tests/whatsapp/webhook.test.ts`
  - `tests/handlers/whatsappMessages.test.ts`
  - `tests/config.test.ts`
  - `tests/whatsapp/pipeline.test.ts`
  - `tests/infra/firestoreTtls.test.ts`
  - `tests/state/responseContext.test.ts`

## Implementation Notes

- Do not add OpenWA dependencies.
- Do not commit live WhatsApp phone numbers, WABA ids, tokens, or pilot transcripts.
- Keep `WHATSAPP_ENABLED=false` as the default.
- Preserve all current Slack handler tests.
- Do not implement WhatsApp-origin async escalation creation, analyst resolution routing, or lifecycle notifications in this prototype.
- Preserve the repo dependency boundary: `state/` remains a leaf dependency and must not import from `src/whatsapp/*`.
- Use the repo's existing ESM import pattern: source imports end in `.js`.
- Use TDD for each task: write failing tests first, run the target test, implement, rerun.

---

### Task 1: Config, Types, And Surface Keys

**Files:**
- Create: `src/channels/types.ts`
- Create: `src/whatsapp/keys.ts`
- Create: `tests/whatsapp/keys.test.ts`
- Modify: `src/config.ts`
- Modify: `tests/config.test.ts`
- Modify: `tests/health/doctor.test.ts`
- Modify: `tests/handlers/escalationReaction.test.ts`
- Modify: `.env.example`

- [ ] **Step 1: Write failing key-helper tests**

Create `tests/whatsapp/keys.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import {
  whatsappConversationId,
  whatsappDedupeId,
  whatsappClarificationId,
  whatsappResponseContextId,
} from '../../src/whatsapp/keys.js';

describe('whatsapp key helpers', () => {
  it('prefixes conversation ids with the WhatsApp surface', () => {
    expect(whatsappConversationId('15551234567')).toBe('whatsapp:15551234567');
  });

  it('encodes provider message ids for dedupe docs', () => {
    expect(whatsappDedupeId('wamid.A/B+C=')).toBe('whatsapp:wamid.A%2FB%2BC%3D');
  });

  it('uses a surface-qualified clarification id', () => {
    expect(whatsappClarificationId('15551234567')).toBe('clarify_whatsapp:15551234567');
  });

  it('uses outbound message id for response context when available', () => {
    expect(whatsappResponseContextId({
      waId: '15551234567',
      inboundProviderMessageId: 'inbound-1',
      outboundMessageId: 'outbound/A+B=',
    })).toBe('whatsapp:15551234567_outbound%2FA%2BB%3D');
  });

  it('falls back to inbound provider message id for response context', () => {
    expect(whatsappResponseContextId({
      waId: '15551234567',
      inboundProviderMessageId: 'inbound/A+B=',
    })).toBe('whatsapp:15551234567_inbound%2FA%2BB%3D');
  });

  it('matches the state-layer WhatsApp response context document id format', () => {
    const waId = '15551234567';
    const outboundMessageId = 'outbound/A+B=';

    expect(whatsappResponseContextId({
      waId,
      inboundProviderMessageId: 'inbound-1',
      outboundMessageId,
    })).toBe(`whatsapp:${waId}_${encodeURIComponent(outboundMessageId)}`);
  });
});
```

- [ ] **Step 2: Run key tests and verify failure**

Run:

```bash
npx vitest run tests/whatsapp/keys.test.ts
```

Expected: FAIL with an import error for `src/whatsapp/keys.js`.

- [ ] **Step 3: Add shared channel types and WhatsApp key helpers**

Create `src/channels/types.ts`:

```typescript
export type ConversationSurface = 'slack' | 'whatsapp';

export interface ConversationRef {
  surface: ConversationSurface;
  conversationId: string;
  userId: string;
}

export interface ChannelMessage {
  surface: ConversationSurface;
  providerMessageId: string;
  conversation: ConversationRef;
  text: string;
  receivedAt: Date;
}

export interface ChannelClient {
  sendText(conversation: ConversationRef, text: string): Promise<{ messageId: string }>;
  updateText?(messageId: string, text: string): Promise<void>;
  fetchContext?(conversation: ConversationRef, limit: number): Promise<ChannelMessage[]>;
}
```

Create `src/whatsapp/keys.ts`:

```typescript
export function whatsappConversationId(waId: string): string {
  return `whatsapp:${waId}`;
}

export function whatsappDedupeId(providerMessageId: string): string {
  return `whatsapp:${encodeURIComponent(providerMessageId)}`;
}

export function whatsappClarificationId(waId: string): string {
  return `clarify_whatsapp:${waId}`;
}

export function whatsappResponseContextId(input: {
  waId: string;
  inboundProviderMessageId: string;
  outboundMessageId?: string;
}): string {
  const messageId = input.outboundMessageId ?? input.inboundProviderMessageId;
  return `whatsapp:${input.waId}_${encodeURIComponent(messageId)}`;
}
```

- [ ] **Step 4: Run key tests and verify pass**

Run:

```bash
npx vitest run tests/whatsapp/keys.test.ts
```

Expected: PASS.

- [ ] **Step 5: Write failing WhatsApp config tests**

Extend `tests/config.test.ts` with these tests. Use the file's existing env reset helpers if present; if the file has no helper, wrap each test with `vi.stubEnv` and `vi.unstubAllEnvs()`.

```typescript
it('leaves WhatsApp disabled by default without requiring WhatsApp secrets', async () => {
  vi.stubEnv('SLACK_BOT_TOKEN', 'xoxb-test');
  vi.stubEnv('SLACK_SIGNING_SECRET', 'slack-secret');
  vi.stubEnv('GEMINI_API_KEY', 'gemini-key');
  vi.stubEnv('GCP_PROJECT_ID', 'gcp-project');
  vi.stubEnv('WHATSAPP_ENABLED', '');
  vi.resetModules();

  const { loadConfig } = await import('../src/config.js');
  const config = loadConfig();

  expect(config.whatsapp.enabled).toBe(false);
  expect(config.whatsapp.allowedWaIds).toEqual([]);
  vi.unstubAllEnvs();
});

it('requires WhatsApp secrets only when WhatsApp is enabled', async () => {
  vi.stubEnv('SLACK_BOT_TOKEN', 'xoxb-test');
  vi.stubEnv('SLACK_SIGNING_SECRET', 'slack-secret');
  vi.stubEnv('GEMINI_API_KEY', 'gemini-key');
  vi.stubEnv('GCP_PROJECT_ID', 'gcp-project');
  vi.stubEnv('WHATSAPP_ENABLED', 'true');
  vi.resetModules();

  const { loadConfig } = await import('../src/config.js');

  expect(() => loadConfig()).toThrow('Missing required env var: WHATSAPP_VERIFY_TOKEN');
  vi.unstubAllEnvs();
});

it('parses enabled WhatsApp config and allowlist', async () => {
  vi.stubEnv('SLACK_BOT_TOKEN', 'xoxb-test');
  vi.stubEnv('SLACK_SIGNING_SECRET', 'slack-secret');
  vi.stubEnv('GEMINI_API_KEY', 'gemini-key');
  vi.stubEnv('GCP_PROJECT_ID', 'gcp-project');
  vi.stubEnv('WHATSAPP_ENABLED', 'true');
  vi.stubEnv('WHATSAPP_VERIFY_TOKEN', 'verify-token');
  vi.stubEnv('WHATSAPP_APP_SECRET', 'app-secret');
  vi.stubEnv('WHATSAPP_ACCESS_TOKEN', 'access-token');
  vi.stubEnv('WHATSAPP_PHONE_NUMBER_ID', 'phone-number-id');
  vi.stubEnv('WHATSAPP_GRAPH_API_VERSION', 'v23.0');
  vi.stubEnv('WHATSAPP_ALLOWED_WA_IDS', '15551234567, 15557654321');
  vi.resetModules();

  const { loadConfig } = await import('../src/config.js');
  const config = loadConfig();

  expect(config.whatsapp).toEqual({
    enabled: true,
    verifyToken: 'verify-token',
    appSecret: 'app-secret',
    accessToken: 'access-token',
    phoneNumberId: 'phone-number-id',
    graphApiVersion: 'v23.0',
    allowedWaIds: ['15551234567', '15557654321'],
  });
  vi.unstubAllEnvs();
});
```

- [ ] **Step 6: Run config tests and verify failure**

Run:

```bash
npx vitest run tests/config.test.ts
```

Expected: FAIL because `AppConfig` has no `whatsapp` property.

- [ ] **Step 7: Implement WhatsApp config**

Modify `src/config.ts`:

```typescript
export type WhatsAppConfig =
  | {
      enabled: false;
      graphApiVersion: string;
      allowedWaIds: string[];
    }
  | {
      enabled: true;
      verifyToken: string;
      appSecret: string;
      accessToken: string;
      phoneNumberId: string;
      graphApiVersion: string;
      allowedWaIds: string[];
    };

export interface AppConfig {
  slack: {
    botToken: string;
    signingSecret: string;
  };
  gemini: {
    apiKey: string;
    model: string;
    fileSearchStoreId?: string;
  };
  gcp: {
    projectId: string;
  };
  dbt: {
    manifestPath: string;
    catalogPath: string;
    webhookSecret?: string;
  };
  limits: {
    costGateMaxBytes: number;
    queryTimeoutMs: number;
    maxResultRows: number;
    rateLimitPerHour: number;
  };
  escalation: {
    mode: 'channel' | 'dm';
    channelId?: string;
    analystUserId?: string;
    reminderIntervalMinutes: number;
    timeoutHours: number;
    onNegativeFeedback: boolean;
  };
  fastPath: {
    enabled: boolean;
    maxBytesProcessed: number;
    requireSupervisor: boolean;
  };
  whatsapp: WhatsAppConfig;
  port: number;
  lifecycleSweepSecret?: string;
}
```

Add helper:

```typescript
function parseEnvList(name: string): string[] {
  const value = process.env[name];
  if (!value) return [];
  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function loadWhatsAppConfig(): AppConfig['whatsapp'] {
  const enabled = parseEnvBool('WHATSAPP_ENABLED', false);
  if (!enabled) {
    return {
      enabled: false,
      graphApiVersion: process.env.WHATSAPP_GRAPH_API_VERSION || 'v23.0',
      allowedWaIds: parseEnvList('WHATSAPP_ALLOWED_WA_IDS'),
    };
  }

  return {
    enabled: true,
    verifyToken: requireEnv('WHATSAPP_VERIFY_TOKEN'),
    appSecret: requireEnv('WHATSAPP_APP_SECRET'),
    accessToken: requireEnv('WHATSAPP_ACCESS_TOKEN'),
    phoneNumberId: requireEnv('WHATSAPP_PHONE_NUMBER_ID'),
    graphApiVersion: process.env.WHATSAPP_GRAPH_API_VERSION || 'v23.0',
    allowedWaIds: parseEnvList('WHATSAPP_ALLOWED_WA_IDS'),
  };
}
```

Add `whatsapp: loadWhatsAppConfig(),` in the object returned by `loadConfig()`.

Update existing typed `AppConfig` test fixtures so Task 1 typecheck still passes before doctor feature assertions are added later:

```typescript
whatsapp: {
  enabled: false,
  graphApiVersion: 'v23.0',
  allowedWaIds: [],
},
```

Add that disabled WhatsApp config to:

- `tests/health/doctor.test.ts` inside `makeConfig()`
- `tests/handlers/escalationReaction.test.ts` inside `baseConfig`

- [ ] **Step 8: Document env vars with empty examples**

Modify `.env.example` by adding:

```dotenv
# WhatsApp Cloud API prototype (disabled by default)
WHATSAPP_ENABLED=false
WHATSAPP_VERIFY_TOKEN=
WHATSAPP_APP_SECRET=
WHATSAPP_ACCESS_TOKEN=
WHATSAPP_PHONE_NUMBER_ID=
WHATSAPP_GRAPH_API_VERSION=v23.0
WHATSAPP_ALLOWED_WA_IDS=
```

- [ ] **Step 9: Run task tests and typecheck**

Run:

```bash
npx vitest run tests/whatsapp/keys.test.ts tests/config.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 10: Commit Task 1**

```bash
git add src/channels/types.ts src/whatsapp/keys.ts tests/whatsapp/keys.test.ts src/config.ts tests/config.test.ts tests/health/doctor.test.ts tests/handlers/escalationReaction.test.ts .env.example
git commit -m "feat: add WhatsApp prototype config and keys"
```

---

### Task 2: Signature Verification And Payload Parsing

**Files:**
- Create: `src/whatsapp/signature.ts`
- Create: `src/whatsapp/payload.ts`
- Create: `tests/whatsapp/signature.test.ts`
- Create: `tests/whatsapp/payload.test.ts`

- [ ] **Step 1: Write failing signature tests**

Create `tests/whatsapp/signature.test.ts`:

```typescript
import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyWhatsAppSignature } from '../../src/whatsapp/signature.js';

function sign(secret: string, body: Buffer): string {
  return `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;
}

describe('verifyWhatsAppSignature', () => {
  it('accepts a valid Meta signature', () => {
    const body = Buffer.from('{"object":"whatsapp_business_account"}');
    expect(verifyWhatsAppSignature({
      appSecret: 'app-secret',
      rawBody: body,
      signatureHeader: sign('app-secret', body),
    })).toBe(true);
  });

  it('rejects a missing signature', () => {
    expect(verifyWhatsAppSignature({
      appSecret: 'app-secret',
      rawBody: Buffer.from('{}'),
      signatureHeader: undefined,
    })).toBe(false);
  });

  it('rejects a signature with the wrong secret', () => {
    const body = Buffer.from('{"a":1}');
    expect(verifyWhatsAppSignature({
      appSecret: 'app-secret',
      rawBody: body,
      signatureHeader: sign('other-secret', body),
    })).toBe(false);
  });

  it('rejects a malformed signature without throwing', () => {
    expect(verifyWhatsAppSignature({
      appSecret: 'app-secret',
      rawBody: Buffer.from('{}'),
      signatureHeader: 'sha256=not-hex',
    })).toBe(false);
  });
});
```

- [ ] **Step 2: Run signature tests and verify failure**

Run:

```bash
npx vitest run tests/whatsapp/signature.test.ts
```

Expected: FAIL with an import error for `src/whatsapp/signature.js`.

- [ ] **Step 3: Implement signature verification**

Create `src/whatsapp/signature.ts`:

```typescript
import crypto from 'node:crypto';

export interface VerifyWhatsAppSignatureInput {
  appSecret: string;
  rawBody: Buffer;
  signatureHeader?: string;
}

export function verifyWhatsAppSignature(input: VerifyWhatsAppSignatureInput): boolean {
  if (!input.signatureHeader?.startsWith('sha256=')) return false;
  const providedHex = input.signatureHeader.slice('sha256='.length);
  if (!/^[a-f0-9]{64}$/i.test(providedHex)) return false;

  const expected = crypto
    .createHmac('sha256', input.appSecret)
    .update(input.rawBody)
    .digest('hex');

  const provided = Buffer.from(providedHex, 'hex');
  const expectedBuffer = Buffer.from(expected, 'hex');
  if (provided.length !== expectedBuffer.length) return false;

  return crypto.timingSafeEqual(provided, expectedBuffer);
}
```

- [ ] **Step 4: Run signature tests and verify pass**

Run:

```bash
npx vitest run tests/whatsapp/signature.test.ts
```

Expected: PASS.

- [ ] **Step 5: Write failing payload parser tests**

Create `tests/whatsapp/payload.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { parseWhatsAppWebhookPayload } from '../../src/whatsapp/payload.js';

const textPayload = {
  object: 'whatsapp_business_account',
  entry: [{
    id: 'waba-1',
    changes: [{
      field: 'messages',
      value: {
        messaging_product: 'whatsapp',
        metadata: {
          display_phone_number: '15550000000',
          phone_number_id: 'phone-1',
        },
        contacts: [{
          profile: { name: 'Ada' },
          wa_id: '15551234567',
        }],
        messages: [{
          from: '15551234567',
          id: 'wamid.1',
          timestamp: '1780000000',
          type: 'text',
          text: { body: 'Show revenue yesterday' },
        }],
      },
    }],
  }],
};

describe('parseWhatsAppWebhookPayload', () => {
  it('normalizes text messages for the configured phone number', () => {
    const result = parseWhatsAppWebhookPayload(textPayload, 'phone-1');

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toMatchObject({
      surface: 'whatsapp',
      providerMessageId: 'wamid.1',
      text: 'Show revenue yesterday',
      conversation: {
        surface: 'whatsapp',
        conversationId: 'whatsapp:15551234567',
        userId: '15551234567',
      },
    });
    expect(result.messages[0].receivedAt.toISOString()).toBe('2026-05-29T04:26:40.000Z');
    expect(result.unsupported).toEqual([]);
  });

  it('ignores status-only payloads', () => {
    const result = parseWhatsAppWebhookPayload({
      object: 'whatsapp_business_account',
      entry: [{
        changes: [{
          field: 'messages',
          value: {
            metadata: { phone_number_id: 'phone-1' },
            statuses: [{ id: 'wamid.status', status: 'delivered' }],
          },
        }],
      }],
    }, 'phone-1');

    expect(result.messages).toEqual([]);
    expect(result.unsupported).toEqual([]);
  });

  it('ignores payloads for another phone number id', () => {
    const result = parseWhatsAppWebhookPayload(textPayload, 'phone-2');
    expect(result.messages).toEqual([]);
    expect(result.unsupported).toEqual([]);
  });

  it('preserves numeric timestamps when providers send numbers', () => {
    const payload = structuredClone(textPayload);
    payload.entry[0].changes[0].value.messages[0].timestamp = 1780000000 as any;

    const result = parseWhatsAppWebhookPayload(payload, 'phone-1');

    expect(result.messages[0].receivedAt).toEqual(new Date(1780000000 * 1000));
  });

  it('returns unsupported notices for non-text inbound messages', () => {
    const payload = structuredClone(textPayload);
    payload.entry[0].changes[0].value.messages[0] = {
      from: '15551234567',
      id: 'wamid.image',
      timestamp: '1780000000',
      type: 'image',
      image: { id: 'media-1' },
    } as any;

    const result = parseWhatsAppWebhookPayload(payload, 'phone-1');

    expect(result.messages).toEqual([]);
    expect(result.unsupported).toEqual([{
      providerMessageId: 'wamid.image',
      conversation: {
        surface: 'whatsapp',
        conversationId: 'whatsapp:15551234567',
        userId: '15551234567',
      },
      receivedAt: new Date(1780000000 * 1000),
      type: 'image',
    }]);
  });
});
```

- [ ] **Step 6: Run payload tests and verify failure**

Run:

```bash
npx vitest run tests/whatsapp/payload.test.ts
```

Expected: FAIL with an import error for `src/whatsapp/payload.js`.

- [ ] **Step 7: Implement payload parser**

Create `src/whatsapp/payload.ts`:

```typescript
import type { ChannelMessage, ConversationRef } from '../channels/types.js';
import { whatsappConversationId } from './keys.js';

export interface UnsupportedWhatsAppMessage {
  providerMessageId: string;
  conversation: ConversationRef;
  receivedAt: Date;
  type: string;
}

export interface ParsedWhatsAppWebhook {
  messages: ChannelMessage[];
  unsupported: UnsupportedWhatsAppMessage[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : null;
}

function getEntries(payload: unknown): unknown[] {
  const root = asRecord(payload);
  return Array.isArray(root?.entry) ? root.entry : [];
}

function getChanges(entry: unknown): unknown[] {
  const record = asRecord(entry);
  return Array.isArray(record?.changes) ? record.changes : [];
}

function toReceivedAt(timestamp: unknown): Date {
  const seconds = typeof timestamp === 'number'
    ? timestamp
    : typeof timestamp === 'string'
      ? Number(timestamp)
      : NaN;
  return Number.isFinite(seconds) ? new Date(seconds * 1000) : new Date();
}

function conversationForWaId(waId: string): ConversationRef {
  return {
    surface: 'whatsapp',
    conversationId: whatsappConversationId(waId),
    userId: waId,
  };
}

export function parseWhatsAppWebhookPayload(
  payload: unknown,
  configuredPhoneNumberId: string,
): ParsedWhatsAppWebhook {
  const parsed: ParsedWhatsAppWebhook = { messages: [], unsupported: [] };

  for (const entry of getEntries(payload)) {
    for (const change of getChanges(entry)) {
      const changeRecord = asRecord(change);
      const value = asRecord(changeRecord?.value);
      const metadata = asRecord(value?.metadata);
      if (metadata?.phone_number_id !== configuredPhoneNumberId) continue;

      const messages = Array.isArray(value?.messages) ? value.messages : [];
      for (const rawMessage of messages) {
        const message = asRecord(rawMessage);
        const from = typeof message?.from === 'string' ? message.from : '';
        const id = typeof message?.id === 'string' ? message.id : '';
        const type = typeof message?.type === 'string' ? message.type : '';
        if (!from || !id || !type) continue;

        const conversation = conversationForWaId(from);
        const receivedAt = toReceivedAt(message.timestamp);
        if (type !== 'text') {
          parsed.unsupported.push({ providerMessageId: id, conversation, receivedAt, type });
          continue;
        }

        const text = asRecord(message.text);
        const body = typeof text?.body === 'string' ? text.body.trim() : '';
        if (!body) continue;

        parsed.messages.push({
          surface: 'whatsapp',
          providerMessageId: id,
          conversation,
          text: body,
          receivedAt,
        });
      }
    }
  }

  return parsed;
}
```

- [ ] **Step 8: Run task tests and typecheck**

Run:

```bash
npx vitest run tests/whatsapp/signature.test.ts tests/whatsapp/payload.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 9: Commit Task 2**

```bash
git add src/whatsapp/signature.ts src/whatsapp/payload.ts tests/whatsapp/signature.test.ts tests/whatsapp/payload.test.ts
git commit -m "feat: parse and verify WhatsApp webhooks"
```

---

### Task 3: WhatsApp Client And Text Renderer

**Files:**
- Create: `src/whatsapp/client.ts`
- Create: `src/whatsapp/renderer.ts`
- Create: `tests/whatsapp/client.test.ts`
- Create: `tests/whatsapp/renderer.test.ts`

- [ ] **Step 1: Write failing WhatsApp client tests**

Create `tests/whatsapp/client.test.ts`:

```typescript
import { describe, expect, it, vi } from 'vitest';
import { createWhatsAppClient } from '../../src/whatsapp/client.js';

describe('createWhatsAppClient', () => {
  it('sends a Cloud API text message and returns the provider message id', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ messages: [{ id: 'wamid.outbound' }] }),
    });
    const client = createWhatsAppClient({
      accessToken: 'access-token',
      phoneNumberId: 'phone-1',
      graphApiVersion: 'v23.0',
      fetchImpl,
    });

    const result = await client.sendText({
      surface: 'whatsapp',
      conversationId: 'whatsapp:15551234567',
      userId: '15551234567',
    }, 'Hello');

    expect(result).toEqual({ messageId: 'wamid.outbound' });
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://graph.facebook.com/v23.0/phone-1/messages',
      expect.objectContaining({
        method: 'POST',
        headers: {
          Authorization: 'Bearer access-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: '15551234567',
          type: 'text',
          text: { body: 'Hello' },
        }),
      }),
    );
  });

  it('throws a safe error when Graph API returns a provider failure', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: { message: 'real provider detail' } }),
    });
    const client = createWhatsAppClient({
      accessToken: 'access-token',
      phoneNumberId: 'phone-1',
      graphApiVersion: 'v23.0',
      fetchImpl,
    });

    await expect(client.sendText({
      surface: 'whatsapp',
      conversationId: 'whatsapp:15551234567',
      userId: '15551234567',
    }, 'Hello')).rejects.toThrow('WhatsApp send failed with status 400');
  });
});
```

- [ ] **Step 2: Run client tests and verify failure**

Run:

```bash
npx vitest run tests/whatsapp/client.test.ts
```

Expected: FAIL with an import error for `src/whatsapp/client.js`.

- [ ] **Step 3: Implement WhatsApp text client**

Create `src/whatsapp/client.ts`:

```typescript
import type { ChannelClient, ConversationRef } from '../channels/types.js';

export type FetchImpl = typeof fetch;

export interface WhatsAppClientConfig {
  accessToken: string;
  phoneNumberId: string;
  graphApiVersion: string;
  fetchImpl?: FetchImpl;
}

export function createWhatsAppClient(config: WhatsAppClientConfig): ChannelClient {
  const fetchImpl = config.fetchImpl ?? fetch;
  const baseUrl = `https://graph.facebook.com/${config.graphApiVersion}/${config.phoneNumberId}`;

  return {
    async sendText(conversation: ConversationRef, text: string): Promise<{ messageId: string }> {
      const response = await fetchImpl(`${baseUrl}/messages`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: conversation.userId,
          type: 'text',
          text: { body: text },
        }),
      });

      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(`WhatsApp send failed with status ${response.status}`);
      }

      const messageId = (payload as { messages?: { id?: string }[] }).messages?.[0]?.id;
      if (!messageId) {
        throw new Error('WhatsApp send succeeded without a message id');
      }
      return { messageId };
    },
  };
}
```

- [ ] **Step 4: Run client tests and verify pass**

Run:

```bash
npx vitest run tests/whatsapp/client.test.ts
```

Expected: PASS.

- [ ] **Step 5: Write failing renderer tests**

Create `tests/whatsapp/renderer.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import {
  renderWhatsAppQueryAnswer,
  renderWhatsAppClarification,
  renderWhatsAppUnsupported,
  renderWhatsAppSafeError,
} from '../../src/whatsapp/renderer.js';

describe('WhatsApp renderer', () => {
  it('renders a compact single-value answer with trace id', () => {
    const text = renderWhatsAppQueryAnswer({
      explanation: 'Revenue was $12,345 yesterday.',
      rows: [{ revenue: 12345 }],
      columnNames: ['revenue'],
      totalRows: 1,
      assumptions: ['Timezone: UTC'],
      traceId: 'trace-1',
    });

    expect(text).toContain('Revenue was $12,345 yesterday.');
    expect(text).toContain('revenue: 12345');
    expect(text).toContain('Assumptions:');
    expect(text).toContain('- Timezone: UTC');
    expect(text).toContain('trace: trace-1');
  });

  it('renders and truncates table answers', () => {
    const text = renderWhatsAppQueryAnswer({
      explanation: 'Top rows.',
      rows: Array.from({ length: 8 }, (_, i) => ({ source: `source-${i}`, sessions: i })),
      columnNames: ['source', 'sessions'],
      totalRows: 8,
      assumptions: [],
      traceId: 'trace-2',
    });

    expect(text).toContain('source | sessions');
    expect(text).toContain('source-4 | 4');
    expect(text).toContain('Showing 5 of 8 rows.');
    expect(text).not.toContain('source-5 | 5');
  });

  it('sanitizes multiline cells and caps truncated cell width', () => {
    const longCell = 'x'.repeat(80);
    const text = renderWhatsAppQueryAnswer({
      explanation: 'Top rows.',
      rows: [{ source: 'email\npaid', campaign: longCell }],
      columnNames: ['source', 'campaign'],
      totalRows: 1,
      assumptions: [],
      traceId: 'trace-3',
    });

    expect(text).toContain('email paid');
    expect(text).toContain(`${'x'.repeat(57)}...`);
    expect(text).not.toContain('email\npaid');
  });

  it('renders clarification text', () => {
    expect(renderWhatsAppClarification(['Which date range should I use?'], 'trace-3'))
      .toBe('I need one clarification before I query the warehouse:\n1. Which date range should I use?\n\nReply here with the answer. (trace: trace-3)');
  });

  it('renders unsupported and safe error text', () => {
    expect(renderWhatsAppUnsupported()).toBe('I can only answer text questions in this WhatsApp prototype.');
    expect(renderWhatsAppSafeError('trace-4')).toBe("I couldn't complete that request safely. Please try again or ask in Slack. (trace: trace-4)");
  });
});
```

- [ ] **Step 6: Run renderer tests and verify failure**

Run:

```bash
npx vitest run tests/whatsapp/renderer.test.ts
```

Expected: FAIL with an import error for `src/whatsapp/renderer.js`.

- [ ] **Step 7: Implement WhatsApp renderer**

Create `src/whatsapp/renderer.ts`:

```typescript
const MAX_ROWS = 5;
const MAX_CELL_CHARS = 60;
const MAX_MESSAGE_CHARS = 3500;

export interface RenderWhatsAppQueryAnswerInput {
  explanation: string;
  rows: Record<string, unknown>[];
  columnNames: string[];
  totalRows: number;
  assumptions: string[];
  traceId: string;
}

function cell(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value).replace(/\r?\n/g, ' ');
  return text.length > MAX_CELL_CHARS ? `${text.slice(0, MAX_CELL_CHARS - 3)}...` : text;
}

function trimMessage(text: string): string {
  return text.length > MAX_MESSAGE_CHARS ? `${text.slice(0, MAX_MESSAGE_CHARS - 30)}\n\n[truncated]` : text;
}

function renderRows(input: RenderWhatsAppQueryAnswerInput): string[] {
  if (input.rows.length === 0) return ['No rows returned.'];
  if (input.rows.length === 1 && input.columnNames.length === 1) {
    const column = input.columnNames[0];
    return [`${column}: ${cell(input.rows[0][column])}`];
  }

  const rows = input.rows.slice(0, MAX_ROWS);
  const lines = [
    input.columnNames.join(' | '),
    input.columnNames.map(() => '---').join(' | '),
    ...rows.map((row) => input.columnNames.map((column) => cell(row[column])).join(' | ')),
  ];
  if (input.totalRows > rows.length) {
    lines.push(`Showing ${rows.length} of ${input.totalRows} rows.`);
  }
  return lines;
}

export function renderWhatsAppQueryAnswer(input: RenderWhatsAppQueryAnswerInput): string {
  const parts = [
    input.explanation,
    '',
    ...renderRows(input),
  ];

  if (input.assumptions.length > 0) {
    parts.push('', 'Assumptions:', ...input.assumptions.map((assumption) => `- ${assumption}`));
  }

  parts.push('', `Reply with a follow-up if you want to refine this. (trace: ${input.traceId})`);
  return trimMessage(parts.join('\n'));
}

export function renderWhatsAppClarification(questions: string[], traceId: string): string {
  return [
    'I need one clarification before I query the warehouse:',
    ...questions.map((question, index) => `${index + 1}. ${question}`),
    '',
    `Reply here with the answer. (trace: ${traceId})`,
  ].join('\n');
}

export function renderWhatsAppUnsupported(): string {
  return 'I can only answer text questions in this WhatsApp prototype.';
}

export function renderWhatsAppSafeError(traceId: string): string {
  return `I couldn't complete that request safely. Please try again or ask in Slack. (trace: ${traceId})`;
}
```

- [ ] **Step 8: Run task tests and typecheck**

Run:

```bash
npx vitest run tests/whatsapp/client.test.ts tests/whatsapp/renderer.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 9: Commit Task 3**

```bash
git add src/whatsapp/client.ts src/whatsapp/renderer.ts tests/whatsapp/client.test.ts tests/whatsapp/renderer.test.ts
git commit -m "feat: add WhatsApp text client and renderer"
```

---

### Task 4: WhatsApp Dedupe State

**Files:**
- Create: `src/state/whatsappEventDedupe.ts`
- Create: `tests/state/whatsappEventDedupe.test.ts`
- Modify: `infra/firestore.ttls.json`
- Modify: `tests/infra/firestoreTtls.test.ts`

- [ ] **Step 1: Write failing dedupe state and TTL tests**

Create `tests/state/whatsappEventDedupe.test.ts` using the Firestore mock shape from `tests/state/responseContext.test.ts`:

```typescript
import { describe, expect, it, vi, beforeEach } from 'vitest';

const mockCreate = vi.fn();
const mockGet = vi.fn();
const mockDelete = vi.fn();
const mockDoc = vi.fn(() => ({ create: mockCreate, get: mockGet, delete: mockDelete }));
const mockCollection = vi.fn(() => ({ doc: mockDoc }));

vi.mock('../../src/state/firestore.js', () => ({
  FieldValue: { serverTimestamp: () => 'server-ts' },
  getDb: () => ({ collection: mockCollection }),
}));

import { claimWhatsAppEvent, releaseWhatsAppEventClaim } from '../../src/state/whatsappEventDedupe.js';

describe('whatsappEventDedupe', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('claims a new WhatsApp message id with a surface-qualified doc id', async () => {
    mockCreate.mockResolvedValue(undefined);

    await expect(claimWhatsAppEvent('wamid.A/B+C=')).resolves.toBe(true);

    expect(mockCollection).toHaveBeenCalledWith('whatsapp_event_dedupe');
    expect(mockDoc).toHaveBeenCalledWith('whatsapp:wamid.A%2FB%2BC%3D');
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({
      eventId: 'wamid.A/B+C=',
      state: 'pending',
      seenAt: 'server-ts',
      expiresAt: expect.any(Date),
    }));
  });

  it('returns false for an existing non-expired claim', async () => {
    mockCreate.mockRejectedValueOnce({ code: 6 });
    mockGet.mockResolvedValueOnce({
      exists: true,
      data: () => ({ expiresAt: new Date(Date.now() + 60_000) }),
    });

    await expect(claimWhatsAppEvent('wamid.1')).resolves.toBe(false);
  });

  it('reclaims an expired claim', async () => {
    mockCreate
      .mockRejectedValueOnce({ code: 6 })
      .mockResolvedValueOnce(undefined);
    mockGet.mockResolvedValueOnce({
      exists: true,
      data: () => ({ expiresAt: new Date(Date.now() - 60_000) }),
    });
    mockDelete.mockResolvedValueOnce(undefined);

    await expect(claimWhatsAppEvent('wamid.1')).resolves.toBe(true);
    expect(mockDelete).toHaveBeenCalledTimes(1);
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });

  it('releases a pending claim', async () => {
    mockDelete.mockResolvedValue(undefined);
    await releaseWhatsAppEventClaim('wamid.1');
    expect(mockDelete).toHaveBeenCalledTimes(1);
  });
});
```

Modify the exact expected array in `tests/infra/firestoreTtls.test.ts` to include:

```typescript
{ collectionGroup: 'whatsapp_event_dedupe', field: 'expiresAt' },
```

Place it immediately after `slack_event_dedupe` so the manifest order remains intentional.

- [ ] **Step 2: Run dedupe and TTL tests and verify failure**

Run:

```bash
npx vitest run tests/state/whatsappEventDedupe.test.ts tests/infra/firestoreTtls.test.ts
```

Expected: FAIL with an import error for `src/state/whatsappEventDedupe.js` and a TTL manifest mismatch for `whatsapp_event_dedupe`.

- [ ] **Step 3: Implement WhatsApp dedupe state and TTL manifest**

Create `src/state/whatsappEventDedupe.ts`:

```typescript
import { getDb, FieldValue } from './firestore.js';

const PENDING_WHATSAPP_EVENT_TTL_MS = 30_000;
const ALREADY_EXISTS = 6;

function eventDocId(eventId: string): string {
  return `whatsapp:${encodeURIComponent(eventId)}`;
}

function eventRef(eventId: string) {
  return getDb().collection('whatsapp_event_dedupe').doc(eventDocId(eventId));
}

function toDate(value: unknown): Date | undefined {
  if (value instanceof Date) return value;
  if (
    typeof value === 'object'
    && value !== null
    && typeof (value as { toDate?: unknown }).toDate === 'function'
  ) {
    return (value as { toDate: () => Date }).toDate();
  }
  return undefined;
}

export async function claimWhatsAppEvent(eventId: string): Promise<boolean> {
  const ref = eventRef(eventId);
  try {
    await ref.create({
      eventId,
      state: 'pending',
      seenAt: FieldValue.serverTimestamp(),
      expiresAt: new Date(Date.now() + PENDING_WHATSAPP_EVENT_TTL_MS),
    });
    return true;
  } catch (error: any) {
    if (error.code === ALREADY_EXISTS) {
      const doc = await ref.get();
      const expiresAt = doc.exists ? toDate(doc.data()?.expiresAt) : undefined;
      if (!doc.exists || (expiresAt && expiresAt < new Date())) {
        if (doc.exists) await ref.delete();
        return claimWhatsAppEvent(eventId);
      }
      return false;
    }
    throw error;
  }
}

export async function releaseWhatsAppEventClaim(eventId: string): Promise<void> {
  await eventRef(eventId).delete();
}
```

Modify `infra/firestore.ttls.json` by inserting the new object inside the existing `ttls` array:

```json
{ "collectionGroup": "whatsapp_event_dedupe", "field": "expiresAt" }
```

Insert the object immediately after the existing `slack_event_dedupe` TTL policy.

- [ ] **Step 4: Run task tests and typecheck**

Run:

```bash
npx vitest run tests/state/whatsappEventDedupe.test.ts tests/infra/firestoreTtls.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit Task 4**

```bash
git add src/state/whatsappEventDedupe.ts tests/state/whatsappEventDedupe.test.ts infra/firestore.ttls.json tests/infra/firestoreTtls.test.ts
git commit -m "feat: add WhatsApp inbound dedupe state"
```

---

### Task 5: Narrow WhatsApp Pipeline Runner

**Files:**
- Create: `src/whatsapp/pipeline.ts`
- Create: `tests/whatsapp/pipeline.test.ts`
- Modify: `src/types.ts`
- Modify: `src/state/responseContext.ts`
- Modify: `tests/state/responseContext.test.ts`

- [ ] **Step 1: Write failing pipeline runner tests**

Create `tests/whatsapp/pipeline.test.ts` with dependency injection so the first implementation can prove the runner behavior before connecting every real stage:

```typescript
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/state/clarificationState.js', () => ({
  saveClarificationState: vi.fn(),
}));

import { runWhatsAppPipeline } from '../../src/whatsapp/pipeline.js';
import { saveClarificationState } from '../../src/state/clarificationState.js';

const conversation = {
  surface: 'whatsapp' as const,
  conversationId: 'whatsapp:15551234567',
  userId: '15551234567',
};

describe('runWhatsAppPipeline', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sends acknowledgement, runs the answerer, renders the answer, and saves context', async () => {
    const client = { sendText: vi.fn()
      .mockResolvedValueOnce({ messageId: 'ack-1' })
      .mockResolvedValueOnce({ messageId: 'answer-1' }) };
    const answerQuestion = vi.fn().mockResolvedValue({
      kind: 'answer',
      explanation: 'Revenue was $12,345.',
      rows: [{ revenue: 12345 }],
      columnNames: ['revenue'],
      totalRows: 1,
      assumptions: [],
      traceId: 'trace-1',
      responseContext: {
        responseId: 'trace-1',
        threadTs: 'whatsapp:15551234567',
        statusMsgTs: 'answer-1',
        clarifiedQuestion: 'Show revenue',
        assumptions: [],
        reasoningChain: 'reasoning',
        generatedSql: 'SELECT 1',
        explanation: 'Revenue was $12,345.',
        tablesUsed: [],
        confidence: 'high',
        primaryAgentConfidence: 'high',
        queryResults: { rowCount: 1, columnNames: ['revenue'], bytesProcessed: 0 },
        pipelineDurationMs: 10,
        traceId: 'trace-1',
        createdAt: new Date(),
        groundingCitations: [],
        teachingsUsed: [],
        supervisorVerdict: 'pass',
        supervisorNotes: '',
        surface: 'whatsapp',
      },
    });
    const saveResponseContext = vi.fn().mockResolvedValue(undefined);

    await runWhatsAppPipeline({
      message: {
        surface: 'whatsapp',
        providerMessageId: 'inbound-1',
        conversation,
        text: 'Show revenue',
        receivedAt: new Date(),
      },
      client,
      answerQuestion,
      saveResponseContext,
    });

    expect(client.sendText).toHaveBeenNthCalledWith(1, conversation, 'Got it. I am checking that now.');
    expect(answerQuestion).toHaveBeenCalledWith(expect.objectContaining({ question: 'Show revenue' }));
    expect(client.sendText.mock.calls[1][1]).toContain('Revenue was $12,345.');
    expect(saveResponseContext).toHaveBeenCalledWith(expect.objectContaining({
      threadTs: 'whatsapp:15551234567',
      statusMsgTs: 'answer-1',
      surface: 'whatsapp',
    }));
  });

  it('sends clarification text without saving an answer context', async () => {
    const client = { sendText: vi.fn().mockResolvedValue({ messageId: 'msg-1' }) };
    const answerQuestion = vi.fn().mockResolvedValue({
      kind: 'clarification',
      questions: ['Which date range should I use?'],
      ambiguities: ['date range'],
      traceId: 'trace-2',
    });
    const saveResponseContext = vi.fn();

    await runWhatsAppPipeline({
      message: {
        surface: 'whatsapp',
        providerMessageId: 'inbound-2',
        conversation,
        text: 'Show revenue',
        receivedAt: new Date(),
      },
      client,
      answerQuestion,
      saveResponseContext,
    });

    expect(client.sendText.mock.calls.at(-1)?.[1]).toContain('Which date range should I use?');
    expect(saveClarificationState).toHaveBeenCalledWith({
      clarificationId: 'clarify_whatsapp:15551234567',
      threadTs: 'whatsapp:15551234567',
      channel: 'whatsapp:15551234567',
      originalQuestion: 'Show revenue',
      ambiguities: ['date range'],
      clarifyingMessageTs: 'msg-1',
    });
    expect(saveResponseContext).not.toHaveBeenCalled();
  });

  it('sends a safe error and resolves when the answerer throws', async () => {
    const client = { sendText: vi.fn().mockResolvedValue({ messageId: 'msg-1' }) };
    const answerQuestion = vi.fn().mockRejectedValue(new Error('warehouse unavailable'));
    const saveResponseContext = vi.fn();

    await expect(runWhatsAppPipeline({
      message: {
        surface: 'whatsapp',
        providerMessageId: 'inbound-3',
        conversation,
        text: 'Show revenue',
        receivedAt: new Date(),
      },
      client,
      answerQuestion,
      saveResponseContext,
    })).resolves.toBeUndefined();

    expect(client.sendText.mock.calls.at(-1)?.[1]).toContain("I couldn't complete that request safely.");
    expect(saveResponseContext).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run pipeline runner tests and verify failure**

Run:

```bash
npx vitest run tests/whatsapp/pipeline.test.ts
```

Expected: FAIL with an import error for `src/whatsapp/pipeline.js`.

- [ ] **Step 3: Add optional surface metadata to response context**

Modify `src/types.ts`:

```typescript
export interface ResponseContext {
  responseId: string;
  threadTs: string;
  statusMsgTs: string;
  surface?: 'slack' | 'whatsapp';
  clarifiedQuestion: string;
  assumptions: string[];
  reasoningChain: string;
  generatedSql: string;
  explanation: string;
  tablesUsed: string[];
  confidence: 'high' | 'medium' | 'low';
  clarificationConfidence?: 'high' | 'medium' | 'low';
  primaryAgentConfidence: 'high' | 'medium' | 'low';
  supervisorConfidence?: 'high' | 'medium' | 'low';
  queryResults: {
    rowCount: number;
    columnNames: string[];
    bytesProcessed: number;
  };
  pipelineDurationMs: number;
  traceId: string;
  createdAt: Date;
  groundingCitations: GroundingCitation[];
  teachingsUsed: string[];
  supervisorVerdict: 'pass' | 'fail_then_pass' | 'exhausted';
  supervisorNotes: string;
  pipelineMode?: 'full_quality_loop' | 'routine_fast_path';
  supervisorDecision?: 'skipped' | 'required';
  supervisorTriggers?: string[];
  fastPathIneligibleReasons?: string[];
  failureHistory?: FailureRecord[];
  negativeFeedback?: boolean;
  retrievedSchema?: {
    name: string;
    description: string;
    columns: { name: string; description: string; dataType: string }[];
  }[];
}
```

Extend `tests/state/responseContext.test.ts` with a WhatsApp doc-id regression. Keep the existing Slack test unchanged.

```typescript
it('URL-encodes WhatsApp status message ids in Firestore doc ids', async () => {
  mockSet.mockResolvedValue(undefined);
  await saveResponseContext({
    ...sampleContext(),
    threadTs: 'whatsapp:15551234567',
    statusMsgTs: 'outbound/A+B=',
    surface: 'whatsapp',
  });

  expect(mockDoc).toHaveBeenCalledWith('whatsapp:15551234567_outbound%2FA%2BB%3D');
  expect(mockSet).toHaveBeenCalled();
});
```

Modify `src/state/responseContext.ts` with a local helper. Do not import from `src/whatsapp/*` here; `state/` is a leaf dependency.

```typescript
function responseContextDocId(ctx: ResponseContext): string {
  if (ctx.surface === 'whatsapp') {
    return `${ctx.threadTs}_${encodeURIComponent(ctx.statusMsgTs)}`;
  }
  return `${ctx.threadTs}_${ctx.statusMsgTs}`;
}
```

Then update `saveResponseContext`:

```typescript
export async function saveResponseContext(ctx: ResponseContext): Promise<void> {
  const now = new Date();
  await getDb()
    .collection('response_context')
    .doc(responseContextDocId(ctx))
    .set({
      ...ctx,
      createdAt: now,
      expiresAt: new Date(now.getTime() + RETENTION_DAYS * 86_400_000),
    });
}
```

- [ ] **Step 4: Implement injected runner**

Create `src/whatsapp/pipeline.ts`:

```typescript
import type { ChannelClient, ChannelMessage } from '../channels/types.js';
import type { ResponseContext } from '../types.js';
import { rootLogger } from '../logging.js';
import { saveClarificationState } from '../state/clarificationState.js';
import {
  renderWhatsAppClarification,
  renderWhatsAppQueryAnswer,
  renderWhatsAppSafeError,
} from './renderer.js';
import { whatsappClarificationId } from './keys.js';

export type WhatsAppPipelineOutcome =
  | {
      kind: 'answer';
      explanation: string;
      rows: Record<string, unknown>[];
      columnNames: string[];
      totalRows: number;
      assumptions: string[];
      traceId: string;
      responseContext: ResponseContext;
    }
  | {
      kind: 'clarification';
      questions: string[];
      ambiguities?: string[];
      traceId: string;
    };

export interface AnswerWhatsAppQuestionInput {
  question: string;
  conversationId: string;
  providerMessageId: string;
}

export interface RunWhatsAppPipelineInput {
  message: ChannelMessage;
  client: ChannelClient;
  answerQuestion: (input: AnswerWhatsAppQuestionInput) => Promise<WhatsAppPipelineOutcome>;
  saveResponseContext: (ctx: ResponseContext) => Promise<void>;
}

export async function runWhatsAppPipeline(input: RunWhatsAppPipelineInput): Promise<void> {
  let traceId = 'unknown';
  try {
    await input.client.sendText(input.message.conversation, 'Got it. I am checking that now.');
    const outcome = await input.answerQuestion({
      question: input.message.text,
      conversationId: input.message.conversation.conversationId,
      providerMessageId: input.message.providerMessageId,
    });
    traceId = outcome.traceId;

    if (outcome.kind === 'clarification') {
      const sent = await input.client.sendText(
        input.message.conversation,
        renderWhatsAppClarification(outcome.questions, outcome.traceId),
      );
      await saveClarificationState({
        clarificationId: whatsappClarificationId(input.message.conversation.userId),
        threadTs: input.message.conversation.conversationId,
        channel: input.message.conversation.conversationId,
        originalQuestion: input.message.text,
        ambiguities: outcome.ambiguities || [],
        clarifyingMessageTs: sent.messageId,
      });
      return;
    }

    const sent = await input.client.sendText(
      input.message.conversation,
      renderWhatsAppQueryAnswer({
        explanation: outcome.explanation,
        rows: outcome.rows,
        columnNames: outcome.columnNames,
        totalRows: outcome.totalRows,
        assumptions: outcome.assumptions,
        traceId: outcome.traceId,
      }),
    );

    await input.saveResponseContext({
      ...outcome.responseContext,
      threadTs: input.message.conversation.conversationId,
      statusMsgTs: sent.messageId,
      surface: 'whatsapp',
    });
  } catch (error) {
    rootLogger.error({ err: error, traceId }, 'whatsapp.pipeline_error');
    await input.client.sendText(input.message.conversation, renderWhatsAppSafeError(traceId));
  }
}
```

- [ ] **Step 5: Run injected runner tests and verify pass**

Run:

```bash
npx vitest run tests/whatsapp/pipeline.test.ts tests/state/responseContext.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 6: Add real answerer tests**

Extend `tests/whatsapp/pipeline.test.ts` with a real-answerer test that mocks agent and execution dependencies. Use `vi.mock` for:

```typescript
vi.mock('../../src/agents/clarificationAgent.js', () => ({ classifyQuestion: vi.fn() }));
vi.mock('../../src/qualityLoop.js', () => ({ qualityLoop: vi.fn() }));
vi.mock('../../src/execution/runner.js', () => ({ executeQuery: vi.fn() }));
vi.mock('../../src/teachings/summaryMap.js', () => ({ getTeachingSummaries: vi.fn(() => []) }));
vi.mock('../../src/dbt/sampleRowCache.js', () => ({ getSampleRows: vi.fn(() => null) }));
vi.mock('../../src/state/responseContext.js', () => ({
  getLatestNegativeFeedback: vi.fn(() => null),
  saveResponseContext: vi.fn(),
}));
vi.mock('../../src/logging.js', () => ({
  createTraceId: () => 'trace-real',
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  logStage: vi.fn(),
  rootLogger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));
```

Add the test:

```typescript
it('real answerer returns a query answer from existing pipeline stages', async () => {
  const { classifyQuestion } = await import('../../src/agents/clarificationAgent.js');
  const { qualityLoop } = await import('../../src/qualityLoop.js');
  const { executeQuery } = await import('../../src/execution/runner.js');
  const { answerWhatsAppQuestion } = await import('../../src/whatsapp/pipeline.js');

  vi.mocked(classifyQuestion).mockResolvedValue({
    confidence: 'high',
    resolved_question: 'Show revenue',
    assumptions: ['UTC timezone'],
    ambiguities: [],
    clarifying_questions: [],
  } as any);
  vi.mocked(qualityLoop).mockResolvedValue({
    verdict: 'pass',
    sqlResult: {
      sql: 'SELECT 1',
      explanation: 'Revenue was $12,345.',
      headline: 'Revenue',
      tablesUsed: ['analytics.fct_revenue'],
      confidence: 'high',
      assumptions: [],
      reasoningChain: 'reasoning',
      groundingCitations: [],
    },
    finalConfidence: 'high',
    failureHistory: [],
    supervisorNotes: '',
    bytesProcessed: 0,
  } as any);
  vi.mocked(executeQuery).mockResolvedValue({
    rows: [{ revenue: 12345 }],
    columnNames: ['revenue'],
    totalRows: 1,
    bytesProcessed: 0,
    truncated: false,
  });

  const outcome = await answerWhatsAppQuestion({
    question: 'Show revenue',
    conversationId: 'whatsapp:15551234567',
    providerMessageId: 'inbound-1',
    tables: [],
    config: {
      geminiApiKey: 'gemini-key',
      maxBytesProcessed: 1000,
      queryTimeoutMs: 1000,
      maxResultRows: 10,
    },
  });

  expect(outcome.kind).toBe('answer');
  if (outcome.kind === 'answer') {
    expect(outcome.explanation).toBe('Revenue was $12,345.');
    expect(outcome.responseContext.surface).toBe('whatsapp');
  }
});

it('real answerer returns a safe answer without executing when supervisor is exhausted', async () => {
  const { classifyQuestion } = await import('../../src/agents/clarificationAgent.js');
  const { qualityLoop } = await import('../../src/qualityLoop.js');
  const { executeQuery } = await import('../../src/execution/runner.js');
  const { answerWhatsAppQuestion } = await import('../../src/whatsapp/pipeline.js');

  vi.mocked(classifyQuestion).mockResolvedValueOnce({
    confidence: 'high',
    resolved_question: 'Show revenue',
    assumptions: [],
    ambiguities: [],
    clarifying_questions: [],
  } as any);
  vi.mocked(qualityLoop).mockResolvedValueOnce({
    verdict: 'exhausted',
    sqlResult: {
      sql: '',
      explanation: 'No valid SQL could be generated.',
      headline: 'No answer',
      tablesUsed: [],
      confidence: 'low',
      assumptions: [],
      reasoningChain: 'supervisor exhausted',
      groundingCitations: [],
    },
    finalConfidence: 'low',
    failureHistory: [],
    supervisorNotes: 'No validated candidate.',
    bytesProcessed: 0,
  } as any);
  vi.mocked(executeQuery).mockClear();

  const outcome = await answerWhatsAppQuestion({
    question: 'Show revenue',
    conversationId: 'whatsapp:15551234567',
    providerMessageId: 'inbound-1',
    tables: [],
    config: {
      geminiApiKey: 'gemini-key',
      maxBytesProcessed: 1000,
      queryTimeoutMs: 1000,
      maxResultRows: 10,
    },
  });

  expect(executeQuery).not.toHaveBeenCalled();
  expect(outcome.kind).toBe('answer');
  if (outcome.kind === 'answer') {
    expect(outcome.explanation).toBe("I wasn't able to generate a valid query for that question.");
    expect(outcome.responseContext.supervisorVerdict).toBe('exhausted');
  }
});

it('real answerer returns cost gate text without executing when cost is exceeded', async () => {
  const { classifyQuestion } = await import('../../src/agents/clarificationAgent.js');
  const { qualityLoop } = await import('../../src/qualityLoop.js');
  const { executeQuery } = await import('../../src/execution/runner.js');
  const { answerWhatsAppQuestion } = await import('../../src/whatsapp/pipeline.js');

  vi.mocked(classifyQuestion).mockResolvedValueOnce({
    confidence: 'high',
    resolved_question: 'Show revenue',
    assumptions: [],
    ambiguities: [],
    clarifying_questions: [],
  } as any);
  vi.mocked(qualityLoop).mockResolvedValueOnce({
    verdict: 'cost_exceeded',
    sqlResult: {
      sql: 'SELECT * FROM huge_table',
      explanation: 'Cost gate exceeded.',
      headline: 'Cost gate',
      tablesUsed: ['huge_table'],
      confidence: 'medium',
      assumptions: [],
      reasoningChain: 'cost gate exceeded',
      groundingCitations: [],
    },
    finalConfidence: 'medium',
    failureHistory: [],
    supervisorNotes: '',
    bytesProcessed: 10_737_418_240,
  } as any);
  vi.mocked(executeQuery).mockClear();

  const outcome = await answerWhatsAppQuestion({
    question: 'Show revenue',
    conversationId: 'whatsapp:15551234567',
    providerMessageId: 'inbound-1',
    tables: [],
    config: {
      geminiApiKey: 'gemini-key',
      maxBytesProcessed: 1_073_741_824,
      queryTimeoutMs: 1000,
      maxResultRows: 10,
    },
  });

  expect(executeQuery).not.toHaveBeenCalled();
  expect(outcome.kind).toBe('answer');
  if (outcome.kind === 'answer') {
    expect(outcome.explanation).toContain('limit');
  }
});
```

- [ ] **Step 7: Implement real answerer in `src/whatsapp/pipeline.ts`**

Add these imports, replacing the earlier `rootLogger`-only logging import with the combined logging import:

```typescript
import type { TableContext } from '../dbt/types.js';
import type { PipelineConfig } from '../pipeline.js';
import { classifyQuestion } from '../agents/clarificationAgent.js';
import { qualityLoop } from '../qualityLoop.js';
import { executeQuery } from '../execution/runner.js';
import { reconcileConfidence } from '../agents/confidence.js';
import { getTeachingSummaries } from '../teachings/summaryMap.js';
import { getSampleRows } from '../dbt/sampleRowCache.js';
import { getLatestNegativeFeedback } from '../state/responseContext.js';
import { createTraceId, createLogger, logStage, rootLogger } from '../logging.js';
```

Add:

```typescript
export interface RealAnswerWhatsAppQuestionInput extends AnswerWhatsAppQuestionInput {
  tables: TableContext[];
  config: PipelineConfig;
}

export async function answerWhatsAppQuestion(
  input: RealAnswerWhatsAppQuestionInput,
): Promise<WhatsAppPipelineOutcome> {
  const traceId = createTraceId();
  const logger = createLogger(traceId);
  const startTime = Date.now();

  const teachingSummaries = await getTeachingSummaries().catch(() => []);
  const threadContext: { role: 'user' | 'assistant'; content: string }[] = [];
  const clarification = await classifyQuestion(
    input.question,
    threadContext,
    teachingSummaries,
    input.config.geminiApiKey,
  );

  if (clarification.confidence === 'low') {
    return {
      kind: 'clarification',
      questions: clarification.clarifying_questions,
      ambiguities: clarification.ambiguities || [],
      traceId,
    };
  }

  const resolvedQuestion = clarification.resolved_question || input.question;
  const sampleRowsMap = new Map<string, { rows: Record<string, unknown>[]; stale: boolean }>();
  const sampleResults = await Promise.all(
    input.tables.map(async (table) => {
      const cached = await getSampleRows(table.name);
      return cached ? { name: table.name, data: cached } : null;
    }),
  );
  for (const result of sampleResults) {
    if (result) sampleRowsMap.set(result.name, result.data);
  }

  const negativeExample = await getLatestNegativeFeedback(input.conversationId);
  const qualityResult = await qualityLoop(
    {
      question: resolvedQuestion,
      tables: input.tables,
      threadContext,
      apiKey: input.config.geminiApiKey,
      fileSearchStoreId: input.config.fileSearchStoreId,
      sampleRows: sampleRowsMap.size > 0 ? sampleRowsMap : undefined,
      negativeExample: negativeExample
        ? {
            sql: negativeExample.sql,
            explanation: negativeExample.explanation,
            userFeedback: '',
          }
        : undefined,
      bqml_hint: clarification.bqml_hint,
    },
    input.config.geminiApiKey,
    resolvedQuestion,
    input.config.maxBytesProcessed,
    {},
  );

  if (qualityResult.verdict === 'exhausted') {
    return {
      kind: 'answer',
      explanation: "I wasn't able to generate a valid query for that question.",
      rows: [],
      columnNames: [],
      totalRows: 0,
      assumptions: clarification.assumptions || [],
      traceId,
      responseContext: {
        responseId: traceId,
        threadTs: input.conversationId,
        statusMsgTs: input.providerMessageId,
        surface: 'whatsapp',
        clarifiedQuestion: resolvedQuestion,
        assumptions: clarification.assumptions || [],
        reasoningChain: 'supervisor exhausted',
        generatedSql: qualityResult.sqlResult.sql,
        explanation: 'supervisor exhausted',
        tablesUsed: qualityResult.sqlResult.tablesUsed,
        confidence: 'low',
        clarificationConfidence: clarification.confidence,
        primaryAgentConfidence: qualityResult.sqlResult.confidence,
        supervisorConfidence: qualityResult.finalConfidence,
        queryResults: { rowCount: 0, columnNames: [], bytesProcessed: 0 },
        pipelineDurationMs: Date.now() - startTime,
        traceId,
        createdAt: new Date(),
        groundingCitations: qualityResult.sqlResult.groundingCitations,
        teachingsUsed: qualityResult.sqlResult.groundingCitations.map((citation) => citation.sourceFile),
        supervisorVerdict: 'exhausted',
        supervisorNotes: qualityResult.supervisorNotes,
        failureHistory: qualityResult.failureHistory,
      },
    };
  }

  if (qualityResult.verdict === 'cost_exceeded') {
    const gb = (qualityResult.bytesProcessed ?? 0) / (1024 * 1024 * 1024);
    const limitGb = input.config.maxBytesProcessed / (1024 * 1024 * 1024);
    return {
      kind: 'answer',
      explanation: `This query would scan ${gb.toFixed(1)} GB (limit: ${limitGb.toFixed(1)} GB). Try narrowing with a date range or specific filter.`,
      rows: [],
      columnNames: [],
      totalRows: 0,
      assumptions: clarification.assumptions || [],
      traceId,
      responseContext: {
        responseId: traceId,
        threadTs: input.conversationId,
        statusMsgTs: input.providerMessageId,
        surface: 'whatsapp',
        clarifiedQuestion: resolvedQuestion,
        assumptions: clarification.assumptions || [],
        reasoningChain: 'cost gate exceeded',
        generatedSql: qualityResult.sqlResult.sql,
        explanation: 'cost gate exceeded',
        tablesUsed: qualityResult.sqlResult.tablesUsed,
        confidence: 'low',
        clarificationConfidence: clarification.confidence,
        primaryAgentConfidence: qualityResult.sqlResult.confidence,
        queryResults: { rowCount: 0, columnNames: [], bytesProcessed: qualityResult.bytesProcessed ?? 0 },
        pipelineDurationMs: Date.now() - startTime,
        traceId,
        createdAt: new Date(),
        groundingCitations: qualityResult.sqlResult.groundingCitations,
        teachingsUsed: qualityResult.sqlResult.groundingCitations.map((citation) => citation.sourceFile),
        supervisorVerdict: 'exhausted',
        supervisorNotes: qualityResult.supervisorNotes,
        failureHistory: qualityResult.failureHistory,
      },
    };
  }

  const queryResult = await executeQuery(qualityResult.sqlResult.sql, {
    maxRows: input.config.maxResultRows,
    timeoutMs: input.config.queryTimeoutMs,
    maxBytes: input.config.maxBytesProcessed,
  });
  const confidence = reconcileConfidence(qualityResult.sqlResult.confidence, qualityResult.finalConfidence);
  logStage(logger, { traceId, stage: 'format', durationMs: Date.now() - startTime });

  return {
    kind: 'answer',
    explanation: qualityResult.sqlResult.explanation,
    rows: queryResult.rows,
    columnNames: queryResult.columnNames,
    totalRows: queryResult.totalRows,
    assumptions: clarification.assumptions || [],
    traceId,
    responseContext: {
      responseId: traceId,
      threadTs: input.conversationId,
      statusMsgTs: input.providerMessageId,
      surface: 'whatsapp',
      clarifiedQuestion: resolvedQuestion,
      assumptions: clarification.assumptions || [],
      reasoningChain: qualityResult.sqlResult.reasoningChain,
      generatedSql: qualityResult.sqlResult.sql,
      explanation: qualityResult.sqlResult.explanation,
      tablesUsed: qualityResult.sqlResult.tablesUsed,
      confidence,
      clarificationConfidence: clarification.confidence,
      primaryAgentConfidence: qualityResult.sqlResult.confidence,
      supervisorConfidence: qualityResult.finalConfidence,
      queryResults: {
        rowCount: queryResult.totalRows,
        columnNames: queryResult.columnNames,
        bytesProcessed: queryResult.bytesProcessed,
      },
      pipelineDurationMs: Date.now() - startTime,
      traceId,
      createdAt: new Date(),
      groundingCitations: qualityResult.sqlResult.groundingCitations,
      teachingsUsed: qualityResult.sqlResult.groundingCitations.map((citation) => citation.sourceFile),
      supervisorVerdict: qualityResult.verdict as 'pass' | 'fail_then_pass' | 'exhausted',
      supervisorNotes: qualityResult.supervisorNotes,
      failureHistory: qualityResult.failureHistory,
    },
  };
}
```

- [ ] **Step 8: Run task tests and typecheck**

Run:

```bash
npx vitest run tests/whatsapp/pipeline.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 9: Commit Task 5**

```bash
git add src/whatsapp/pipeline.ts tests/whatsapp/pipeline.test.ts src/types.ts src/state/responseContext.ts tests/state/responseContext.test.ts
git commit -m "feat: add WhatsApp pipeline runner"
```

---

### Task 6: Inbound WhatsApp Message Handler

**Files:**
- Create: `src/handlers/whatsappMessages.ts`
- Create: `tests/handlers/whatsappMessages.test.ts`

- [ ] **Step 1: Write failing handler tests**

Create `tests/handlers/whatsappMessages.test.ts`:

```typescript
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../../src/state/whatsappEventDedupe.js', () => ({
  claimWhatsAppEvent: vi.fn(),
  releaseWhatsAppEventClaim: vi.fn(),
}));
vi.mock('../../src/state/rateLimiter.js', () => ({ checkRateLimit: vi.fn() }));
vi.mock('../../src/state/clarificationState.js', () => ({
  getClarificationState: vi.fn(),
  deleteClarificationState: vi.fn(),
}));
vi.mock('../../src/state/escalationState.js', () => ({ getEscalationByThread: vi.fn() }));
vi.mock('../../src/state/responseContext.js', () => ({ saveResponseContext: vi.fn() }));
vi.mock('../../src/whatsapp/pipeline.js', () => ({
  runWhatsAppPipeline: vi.fn(),
  answerWhatsAppQuestion: vi.fn(),
}));

import { claimWhatsAppEvent, releaseWhatsAppEventClaim } from '../../src/state/whatsappEventDedupe.js';
import { checkRateLimit } from '../../src/state/rateLimiter.js';
import { getClarificationState, deleteClarificationState } from '../../src/state/clarificationState.js';
import { getEscalationByThread } from '../../src/state/escalationState.js';
import { runWhatsAppPipeline } from '../../src/whatsapp/pipeline.js';
import { handleWhatsAppMessages } from '../../src/handlers/whatsappMessages.js';

const message = {
  surface: 'whatsapp' as const,
  providerMessageId: 'wamid.1',
  conversation: {
    surface: 'whatsapp' as const,
    conversationId: 'whatsapp:15551234567',
    userId: '15551234567',
  },
  text: 'Show revenue',
  receivedAt: new Date(),
};

const deps = {
  client: { sendText: vi.fn().mockResolvedValue({ messageId: 'msg-1' }) },
  tables: [],
  config: {
    geminiApiKey: 'gemini-key',
    maxBytesProcessed: 1000,
    queryTimeoutMs: 1000,
    maxResultRows: 10,
  },
  rateLimitPerHour: 30,
  allowedWaIds: ['15551234567'],
};

describe('handleWhatsAppMessages', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(claimWhatsAppEvent).mockResolvedValue(true);
    vi.mocked(checkRateLimit).mockResolvedValue({ allowed: true } as any);
    vi.mocked(getClarificationState).mockResolvedValue(null);
    vi.mocked(getEscalationByThread).mockResolvedValue(null);
    vi.mocked(runWhatsAppPipeline).mockResolvedValue(undefined);
  });

  it('runs the WhatsApp pipeline for an allowed text message', async () => {
    await handleWhatsAppMessages([message], deps);

    expect(claimWhatsAppEvent).toHaveBeenCalledWith('wamid.1');
    expect(checkRateLimit).toHaveBeenCalledWith('whatsapp:15551234567', 30);
    expect(runWhatsAppPipeline).toHaveBeenCalledTimes(1);
  });

  it('skips unknown users when allowlist is configured', async () => {
    await handleWhatsAppMessages([{ ...message, conversation: { ...message.conversation, userId: '15550000000' } }], deps);

    expect(claimWhatsAppEvent).not.toHaveBeenCalled();
    expect(runWhatsAppPipeline).not.toHaveBeenCalled();
  });

  it('does not run duplicate messages', async () => {
    vi.mocked(claimWhatsAppEvent).mockResolvedValue(false);

    await handleWhatsAppMessages([message], deps);

    expect(runWhatsAppPipeline).not.toHaveBeenCalled();
  });

  it('sends rate-limit text when user is over limit', async () => {
    vi.mocked(checkRateLimit).mockResolvedValue({ allowed: false, retryAfterMinutes: 12 } as any);

    await handleWhatsAppMessages([message], deps);

    expect(deps.client.sendText).toHaveBeenCalledWith(message.conversation, "You've hit the query limit (30/hour). Resets in 12 minutes.");
    expect(runWhatsAppPipeline).not.toHaveBeenCalled();
  });

  it('resumes a pending clarification and deletes clarification state after the pipeline resolves', async () => {
    vi.mocked(getClarificationState).mockResolvedValue({
      clarificationId: 'clarify_whatsapp:15551234567',
      threadTs: 'whatsapp:15551234567',
      channel: 'whatsapp:15551234567',
      originalQuestion: 'Show revenue',
      ambiguities: ['time period'],
      clarifyingMessageTs: 'wamid.clarify',
      state: 'awaiting_reply',
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 1000),
    } as any);

    await handleWhatsAppMessages([message], deps);

    expect(deleteClarificationState).toHaveBeenCalledWith('clarify_whatsapp:15551234567');
    expect(runWhatsAppPipeline).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.objectContaining({
        text: 'Show revenue (Clarification: Show revenue)',
      }),
    }));
    expect(vi.mocked(runWhatsAppPipeline).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(deleteClarificationState).mock.invocationCallOrder[0]);
  });

  it('releases the dedupe claim when pipeline throws before visible response', async () => {
    vi.mocked(runWhatsAppPipeline).mockRejectedValue(new Error('boom'));

    await expect(handleWhatsAppMessages([message], deps)).rejects.toThrow('boom');

    expect(releaseWhatsAppEventClaim).toHaveBeenCalledWith('wamid.1');
  });

  it('preserves pending clarification state when resumed pipeline throws', async () => {
    vi.mocked(getClarificationState).mockResolvedValue({
      clarificationId: 'clarify_whatsapp:15551234567',
      threadTs: 'whatsapp:15551234567',
      channel: 'whatsapp:15551234567',
      originalQuestion: 'Show revenue',
      ambiguities: ['time period'],
      clarifyingMessageTs: 'wamid.clarify',
      state: 'awaiting_reply',
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 1000),
    } as any);
    vi.mocked(runWhatsAppPipeline).mockRejectedValue(new Error('boom'));

    await expect(handleWhatsAppMessages([message], deps)).rejects.toThrow('boom');

    expect(deleteClarificationState).not.toHaveBeenCalled();
    expect(releaseWhatsAppEventClaim).toHaveBeenCalledWith('wamid.1');
  });
});
```

- [ ] **Step 2: Run handler tests and verify failure**

Run:

```bash
npx vitest run tests/handlers/whatsappMessages.test.ts
```

Expected: FAIL with an import error for `src/handlers/whatsappMessages.js`.

- [ ] **Step 3: Implement inbound handler**

Create `src/handlers/whatsappMessages.ts`:

```typescript
import type { ChannelClient, ChannelMessage } from '../channels/types.js';
import type { TableContext } from '../dbt/types.js';
import type { PipelineConfig } from '../pipeline.js';
import { checkRateLimit } from '../state/rateLimiter.js';
import { getClarificationState, deleteClarificationState } from '../state/clarificationState.js';
import { getEscalationByThread } from '../state/escalationState.js';
import { saveResponseContext } from '../state/responseContext.js';
import { claimWhatsAppEvent, releaseWhatsAppEventClaim } from '../state/whatsappEventDedupe.js';
import { answerWhatsAppQuestion, runWhatsAppPipeline } from '../whatsapp/pipeline.js';

export interface HandleWhatsAppMessagesDeps {
  client: ChannelClient;
  tables: TableContext[];
  config: PipelineConfig;
  rateLimitPerHour: number;
  allowedWaIds: string[];
}

function isAllowed(userId: string, allowedWaIds: string[]): boolean {
  return allowedWaIds.length === 0 || allowedWaIds.includes(userId);
}

export async function handleWhatsAppMessages(
  messages: ChannelMessage[],
  deps: HandleWhatsAppMessagesDeps,
): Promise<void> {
  for (const inbound of messages) {
    if (!isAllowed(inbound.conversation.userId, deps.allowedWaIds)) continue;

    const claimed = await claimWhatsAppEvent(inbound.providerMessageId);
    if (!claimed) continue;

    let visibleResponse = false;
    try {
      const rateCheck = await checkRateLimit(inbound.conversation.conversationId, deps.rateLimitPerHour);
      if (!rateCheck.allowed) {
        await deps.client.sendText(
          inbound.conversation,
          `You've hit the query limit (${deps.rateLimitPerHour}/hour). Resets in ${rateCheck.retryAfterMinutes} minutes.`,
        );
        visibleResponse = true;
        continue;
      }

      const clarification = await getClarificationState(inbound.conversation.conversationId);
      const messageForPipeline = clarification
        ? {
            ...inbound,
            text: `${clarification.originalQuestion} (Clarification: ${inbound.text})`,
          }
        : inbound;

      const escalation = await getEscalationByThread(inbound.conversation.conversationId);
      if (escalation?.status === 'pending') {
        await deps.client.sendText(
          inbound.conversation,
          "I'm still waiting for the data team on your previous question.",
        );
        visibleResponse = true;
        continue;
      }

      await runWhatsAppPipeline({
        message: messageForPipeline,
        client: deps.client,
        answerQuestion: (input) => answerWhatsAppQuestion({
          ...input,
          tables: deps.tables,
          config: deps.config,
        }),
        saveResponseContext,
      });
      visibleResponse = true;
      if (clarification) {
        await deleteClarificationState(clarification.clarificationId);
      }
    } catch (error) {
      if (!visibleResponse) await releaseWhatsAppEventClaim(inbound.providerMessageId).catch(() => {});
      throw error;
    }
  }
}
```

- [ ] **Step 4: Run task tests and typecheck**

Run:

```bash
npx vitest run tests/handlers/whatsappMessages.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit Task 6**

```bash
git add src/handlers/whatsappMessages.ts tests/handlers/whatsappMessages.test.ts
git commit -m "feat: handle inbound WhatsApp messages"
```

---

### Task 7: Webhook Route And App Wiring

**Files:**
- Create: `src/whatsapp/webhook.ts`
- Create: `tests/whatsapp/webhook.test.ts`
- Modify: `src/app.ts`
- Modify: `src/health/doctor.ts`
- Modify: `tests/health/doctor.test.ts`

- [ ] **Step 1: Write failing webhook route tests**

Create `tests/whatsapp/webhook.test.ts`:

```typescript
import crypto from 'node:crypto';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Request, Response, Router } from 'express';
import { registerWhatsAppWebhook } from '../../src/whatsapp/webhook.js';

const handleWhatsAppMessages = vi.fn();
vi.mock('../../src/handlers/whatsappMessages.js', () => ({
  handleWhatsAppMessages: (...args: unknown[]) => handleWhatsAppMessages(...args),
}));

function sign(secret: string, body: Buffer): string {
  return `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;
}

let getHandler: (req: Request, res: Response) => void;
let postHandlers: any[];

const router = {
  get: vi.fn((path: string, handler: any) => {
    if (path === '/whatsapp/webhook') getHandler = handler;
  }),
  post: vi.fn((path: string, ...handlers: any[]) => {
    if (path === '/whatsapp/webhook') postHandlers = handlers;
  }),
} as unknown as Router;

function res() {
  const send = vi.fn();
  const json = vi.fn();
  const status = vi.fn(() => ({ send, json }));
  return { status, send, json, res: { status, send, json } as unknown as Response };
}

describe('registerWhatsAppWebhook', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registerWhatsAppWebhook(router, {
      verifyToken: 'verify-token',
      appSecret: 'app-secret',
      phoneNumberId: 'phone-1',
      client: { sendText: vi.fn() } as any,
      tables: [],
      config: {
        geminiApiKey: 'gemini-key',
        maxBytesProcessed: 1000,
        queryTimeoutMs: 1000,
        maxResultRows: 10,
      },
      rateLimitPerHour: 30,
      allowedWaIds: [],
    });
  });

  it('registers GET and POST routes', () => {
    expect(router.get).toHaveBeenCalledWith('/whatsapp/webhook', expect.any(Function));
    expect(router.post).toHaveBeenCalledWith('/whatsapp/webhook', expect.any(Function), expect.any(Function));
  });

  it('returns the challenge for valid GET verification', () => {
    const out = res();
    getHandler({
      query: {
        'hub.mode': 'subscribe',
        'hub.verify_token': 'verify-token',
        'hub.challenge': 'challenge-1',
      },
    } as unknown as Request, out.res);

    expect(out.status).toHaveBeenCalledWith(200);
    expect(out.send).toHaveBeenCalledWith('challenge-1');
  });

  it('rejects invalid GET verification', () => {
    const out = res();
    getHandler({
      query: {
        'hub.mode': 'subscribe',
        'hub.verify_token': 'wrong',
        'hub.challenge': 'challenge-1',
      },
    } as unknown as Request, out.res);

    expect(out.status).toHaveBeenCalledWith(403);
    expect(out.send).toHaveBeenCalledWith('Forbidden');
  });

  it('rejects POST requests with bad signatures', async () => {
    const rawBody = Buffer.from(JSON.stringify({ entry: [] }));
    const out = res();
    await postHandlers.at(-1)({
      rawBody,
      body: rawBody,
      headers: { 'x-hub-signature-256': 'sha256=bad' },
    } as unknown as Request, out.res);

    expect(out.status).toHaveBeenCalledWith(401);
    expect(out.send).toHaveBeenCalledWith('Unauthorized');
    expect(handleWhatsAppMessages).not.toHaveBeenCalled();
  });

  it('returns Bad Request for invalid JSON with a valid signature', async () => {
    const rawBody = Buffer.from('{not valid json');
    const out = res();

    await postHandlers.at(-1)({
      rawBody,
      body: rawBody,
      headers: { 'x-hub-signature-256': sign('app-secret', rawBody) },
    } as unknown as Request, out.res);

    expect(out.status).toHaveBeenCalledWith(400);
    expect(out.send).toHaveBeenCalledWith('Bad Request');
    expect(handleWhatsAppMessages).not.toHaveBeenCalled();
  });

  it('uses preserved rawBody for signatures when Express has already parsed req.body', async () => {
    const payload = {
      object: 'whatsapp_business_account',
      entry: [{
        changes: [{
          field: 'messages',
          value: {
            metadata: { phone_number_id: 'phone-1' },
            messages: [{
              from: '15551234567',
              id: 'wamid.1',
              timestamp: '1780000000',
              type: 'text',
              text: { body: 'Show revenue' },
            }],
          },
        }],
      }],
    };
    const rawBody = Buffer.from(JSON.stringify(payload));
    const out = res();

    await postHandlers.at(-1)({
      rawBody,
      body: payload,
      headers: { 'x-hub-signature-256': sign('app-secret', rawBody) },
    } as unknown as Request, out.res);

    expect(out.status).toHaveBeenCalledWith(200);
    expect(out.send).toHaveBeenCalledWith('OK');
    expect(handleWhatsAppMessages).toHaveBeenCalledWith(
      [expect.objectContaining({ providerMessageId: 'wamid.1' })],
      expect.objectContaining({ rateLimitPerHour: 30 }),
    );
  });

  it('returns Internal Server Error when handler execution fails', async () => {
    const payload = {
      object: 'whatsapp_business_account',
      entry: [{
        changes: [{
          field: 'messages',
          value: {
            metadata: { phone_number_id: 'phone-1' },
            messages: [{
              from: '15551234567',
              id: 'wamid.2',
              timestamp: '1780000000',
              type: 'text',
              text: { body: 'Show revenue' },
            }],
          },
        }],
      }],
    };
    const rawBody = Buffer.from(JSON.stringify(payload));
    handleWhatsAppMessages.mockRejectedValueOnce(new Error('pipeline failed'));
    const out = res();

    await postHandlers.at(-1)({
      rawBody,
      body: payload,
      headers: { 'x-hub-signature-256': sign('app-secret', rawBody) },
    } as unknown as Request, out.res);

    expect(out.status).toHaveBeenCalledWith(500);
    expect(out.send).toHaveBeenCalledWith('Internal Server Error');
  });
});
```

- [ ] **Step 2: Run webhook tests and verify failure**

Run:

```bash
npx vitest run tests/whatsapp/webhook.test.ts
```

Expected: FAIL with an import error for `src/whatsapp/webhook.js`.

- [ ] **Step 3: Implement webhook registration**

Create `src/whatsapp/webhook.ts`:

```typescript
import express from 'express';
import type { Request, Response, Router } from 'express';
import type { ChannelClient } from '../channels/types.js';
import type { TableContext } from '../dbt/types.js';
import type { PipelineConfig } from '../pipeline.js';
import { handleWhatsAppMessages } from '../handlers/whatsappMessages.js';
import { rootLogger } from '../logging.js';
import { verifyWhatsAppSignature } from './signature.js';
import { parseWhatsAppWebhookPayload } from './payload.js';

export interface RegisterWhatsAppWebhookDeps {
  verifyToken: string;
  appSecret: string;
  phoneNumberId: string;
  client: ChannelClient;
  tables: TableContext[];
  config: PipelineConfig;
  rateLimitPerHour: number;
  allowedWaIds: string[];
}

function queryValue(req: Request, key: string): string | undefined {
  const value = req.query[key];
  return typeof value === 'string' ? value : undefined;
}

function rawBodyFrom(req: Request): Buffer {
  const maybeRawBody = (req as Request & { rawBody?: unknown }).rawBody;
  if (Buffer.isBuffer(maybeRawBody)) return maybeRawBody;
  return Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
}

function payloadFrom(req: Request, rawBody: Buffer): unknown {
  if (typeof req.body === 'object' && req.body !== null && !Buffer.isBuffer(req.body)) {
    return req.body;
  }
  return JSON.parse(rawBody.toString('utf8')) as unknown;
}

export function registerWhatsAppWebhook(router: Router, deps: RegisterWhatsAppWebhookDeps): void {
  router.get('/whatsapp/webhook', (req: Request, res: Response) => {
    const mode = queryValue(req, 'hub.mode');
    const token = queryValue(req, 'hub.verify_token');
    const challenge = queryValue(req, 'hub.challenge');

    if (mode === 'subscribe' && token === deps.verifyToken && challenge) {
      res.status(200).send(challenge);
      return;
    }

    res.status(403).send('Forbidden');
  });

  router.post('/whatsapp/webhook', express.raw({ type: 'application/json' }), async (req: Request, res: Response) => {
    try {
      const rawBody = rawBodyFrom(req);
      const signatureHeader = req.headers['x-hub-signature-256'];
      const signature = Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader;

      const valid = verifyWhatsAppSignature({
        appSecret: deps.appSecret,
        rawBody,
        signatureHeader: signature,
      });
      if (!valid) {
        res.status(401).send('Unauthorized');
        return;
      }

      let payload: unknown;
      try {
        payload = payloadFrom(req, rawBody);
      } catch {
        res.status(400).send('Bad Request');
        return;
      }

      const parsed = parseWhatsAppWebhookPayload(payload, deps.phoneNumberId);

      for (const unsupported of parsed.unsupported) {
        await deps.client.sendText(
          unsupported.conversation,
          'I can only answer text questions in this WhatsApp prototype.',
        );
      }

      await handleWhatsAppMessages(parsed.messages, {
        client: deps.client,
        tables: deps.tables,
        config: deps.config,
        rateLimitPerHour: deps.rateLimitPerHour,
        allowedWaIds: deps.allowedWaIds,
      });

      res.status(200).send('OK');
    } catch (error) {
      rootLogger.error({ err: error }, 'whatsapp.webhook_error');
      if (!res.headersSent) {
        res.status(500).send('Internal Server Error');
      }
    }
  });
}
```

- [ ] **Step 4: Run webhook tests and verify pass**

Run:

```bash
npx vitest run tests/whatsapp/webhook.test.ts
```

Expected: PASS.

- [ ] **Step 5: Wire app registration behind config**

Modify `src/app.ts` imports:

```typescript
import { registerWhatsAppWebhook } from './whatsapp/webhook.js';
import { createWhatsAppClient } from './whatsapp/client.js';
```

After lifecycle sweep registration and before `/health/doctor`, add:

```typescript
if (config.whatsapp.enabled) {
  const whatsappClient = createWhatsAppClient({
    accessToken: config.whatsapp.accessToken,
    phoneNumberId: config.whatsapp.phoneNumberId,
    graphApiVersion: config.whatsapp.graphApiVersion,
  });
  registerWhatsAppWebhook(receiver.router, {
    verifyToken: config.whatsapp.verifyToken,
    appSecret: config.whatsapp.appSecret,
    phoneNumberId: config.whatsapp.phoneNumberId,
    client: whatsappClient,
    tables,
    config: toPipelineConfig(config),
    rateLimitPerHour: config.limits.rateLimitPerHour,
    allowedWaIds: config.whatsapp.allowedWaIds,
  });
}
```

If `tables` is reassigned later in app startup, pass `getTables()` through the handler deps instead of the current array. Keep the registration after dbt artifacts load so the initial table list is available.

- [ ] **Step 6: Update doctor report tests for WhatsApp configuration**

Modify `tests/health/doctor.test.ts` by adding expected feature shape:

```typescript
expect(report.features).toEqual(expect.objectContaining({
  whatsapp: expect.objectContaining({
    enabled: false,
    configured: false,
    allowlistSize: 0,
  }),
}));
```

Modify `src/health/doctor.ts` so the report includes:

```typescript
whatsapp: {
  enabled: deps.config.whatsapp.enabled,
  configured: deps.config.whatsapp.enabled,
  allowlistSize: deps.config.whatsapp.allowedWaIds.length,
}
```

Use the existing report `features` object location in `src/health/doctor.ts`.

Also extend the `DiagnosticReport` interface so the returned object type matches the new report shape:

```typescript
export interface DiagnosticReport {
  status: OverallStatus;
  revision: string;
  uptimeSeconds: number;
  timestamp: string;
  features: {
    fileSearch: boolean;
    dbtWebhookIngestion: boolean;
    escalation: {
      mode: 'channel' | 'dm';
      targetConfigured: boolean;
      onNegativeFeedback: boolean;
    };
    whatsapp: {
      enabled: boolean;
      configured: boolean;
      allowlistSize: number;
    };
  };
  limits: {
    costGateMaxBytes: number;
    queryTimeoutMs: number;
    maxResultRows: number;
    rateLimitPerHour: number;
  };
  checks: CheckResult[];
}
```

- [ ] **Step 7: Run task tests and typecheck**

Run:

```bash
npx vitest run tests/whatsapp/webhook.test.ts tests/health/doctor.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 8: Commit Task 7**

```bash
git add src/whatsapp/webhook.ts tests/whatsapp/webhook.test.ts src/app.ts src/health/doctor.ts tests/health/doctor.test.ts
git commit -m "feat: wire WhatsApp webhook endpoint"
```

---

### Task 8: Governance And Documentation

**Files:**
- Modify: `README.md`
- Modify: `docs/trajectory-governance.md`
- Modify: `docs/superpowers/specs/2026-06-21-whatsapp-cloud-api-prototype-design.md` only if implementation discoveries contradict the spec

- [ ] **Step 1: Document WhatsApp prototype configuration in README**

Add a "WhatsApp Prototype Configuration" subsection after the Slack app setup sections:

````markdown
## WhatsApp Prototype Configuration

WhatsApp support is a gated prototype and is disabled by default.

Set these variables only in an implementation environment:

```text
WHATSAPP_ENABLED=true
WHATSAPP_VERIFY_TOKEN=<meta-webhook-verify-token>
WHATSAPP_APP_SECRET=<meta-app-secret>
WHATSAPP_ACCESS_TOKEN=<system-user-access-token>
WHATSAPP_PHONE_NUMBER_ID=<business-phone-number-id>
WHATSAPP_GRAPH_API_VERSION=v23.0
WHATSAPP_ALLOWED_WA_IDS=<comma-separated-test-wa-ids>
```

The webhook URL is:

```text
https://<your-cloud-run-url>/whatsapp/webhook
```

Keep `WHATSAPP_ALLOWED_WA_IDS` set during the prototype so only explicit test
numbers can invoke the analytics pipeline. Do not commit WABA IDs, phone
number IDs, tokens, phone numbers, or pilot transcripts to the template repo.
````

- [ ] **Step 2: Record governance entry**

Modify the head sections of `docs/trajectory-governance.md` by adding a concise note under Current Decision or Deferred Work:

```markdown
5. **WhatsApp Cloud API prototype is approved only as a gated channel experiment.** It stays behind `WHATSAPP_ENABLED=false` by default, uses allowlisted test numbers, and does not count as production product surface until manual acceptance evidence is recorded. Slack remains the analyst surface; WhatsApp-origin async escalation creation and resolution routing remain out of scope. OpenWA remains out of product runtime.
```

Append an Evidence Log entry:

```markdown
### As of 2026-06-21

- Decision: a WhatsApp Cloud API-shaped prototype may be implemented as a gated channel experiment.
- Scope: one-to-one text-only inbound questions, compact text answers, safe no-answer handling for exhausted supervisor loops, allowlisted test numbers, and no business-initiated outreach.
- Non-scope: OpenWA runtime dependency, WhatsApp group chats, Slack parity controls, WhatsApp-origin async escalation creation/resolution, production-default enablement, or committed live WhatsApp identifiers/evidence.
- Evidence source: `docs/superpowers/specs/2026-06-21-whatsapp-cloud-api-prototype-design.md`.
```

- [ ] **Step 3: Run docs checks**

Run:

```bash
git diff --check
npm run typecheck
```

Expected: PASS.

- [ ] **Step 4: Commit Task 8**

```bash
git add README.md docs/trajectory-governance.md docs/superpowers/specs/2026-06-21-whatsapp-cloud-api-prototype-design.md
git commit -m "docs: document WhatsApp prototype gate"
```

---

### Task 9: Final Verification

**Files:**
- No planned source edits.

- [ ] **Step 1: Run targeted WhatsApp tests**

Run:

```bash
npx vitest run tests/whatsapp/keys.test.ts tests/whatsapp/signature.test.ts tests/whatsapp/payload.test.ts tests/whatsapp/client.test.ts tests/whatsapp/renderer.test.ts tests/whatsapp/pipeline.test.ts tests/whatsapp/webhook.test.ts tests/handlers/whatsappMessages.test.ts tests/state/whatsappEventDedupe.test.ts tests/infra/firestoreTtls.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run existing affected tests**

Run:

```bash
npx vitest run tests/config.test.ts tests/health/doctor.test.ts tests/handlers/messages.test.ts tests/pipeline.test.ts tests/state/responseContext.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run full typecheck**

Run:

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 4: Run full test suite**

Run:

```bash
npm test
```

Expected: PASS.

- [ ] **Step 5: Check diff hygiene**

Run:

```bash
git status --short
git diff --check
```

Expected: no unstaged files except intentional local artifacts; `git diff --check` emits no output.

- [ ] **Step 6: Final commit if verification produced doc-only adjustments**

If Task 9 required any small documentation correction, commit it:

```bash
git add README.md docs/trajectory-governance.md docs/superpowers/specs/2026-06-21-whatsapp-cloud-api-prototype-design.md
git commit -m "docs: finalize WhatsApp prototype verification notes"
```

Expected: commit succeeds or there are no files to commit.

---

## Self-Review

Spec coverage:

- Official Cloud API shape: Tasks 2, 3, and 7.
- Feature flag and optional config: Task 1.
- Text-only one-to-one support: Tasks 2, 6, and 7.
- Compact renderer: Task 3.
- No OpenWA dependency: Tasks 1 through 9 avoid package changes except existing dependencies.
- Surface-qualified keys: Tasks 1 and 4.
- Dedupe: Task 4 and Task 6.
- Clarification resume: Task 6 and Task 5.
- Async WhatsApp-origin escalation deferred: Task 5 returns safe no-answer text for exhausted supervisor loops; Task 6 only guards already-pending escalation state.
- Slack unchanged: verification in Task 9.
- Governance update: Task 8.
- No live identifiers in repo: Task 8.

Risk controls:

- The pipeline runner starts with injected tests before real stage integration.
- WhatsApp route rejects bad signatures before parsing JSON.
- Unsupported messages get one fixed text reply.
- The app registers WhatsApp only when `WHATSAPP_ENABLED=true` and all required config values exist.
- Full test suite remains the final gate.
