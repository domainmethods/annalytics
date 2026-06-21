# WhatsApp Cloud API Prototype Design

**Date:** 2026-06-21
**Status:** Approved for implementation planning
**Scope:** Prototype design only

## Summary

Add a gated WhatsApp prototype for Anna Lytics using the official WhatsApp
Cloud API shape. The prototype proves that a user can ask a narrow analytics
question over WhatsApp and receive a safe, compact answer while preserving the
existing Annalytics trust path: clarification, SQL generation, supervisor
review, validation, BigQuery execution, safe errors, response persistence,
rate limiting, idempotency, and human escalation.

This is not a Slack parity project. Slack remains the richer operator and
analyst surface. WhatsApp is a second user-facing ingress and egress path for
plain-text, one-to-one conversations.

## Context

The current product is Slack-native. `runPipeline` accepts Slack channel and
timestamp identifiers plus a Slack `WebClient`, then updates Slack messages,
loads Slack thread context, emits Block Kit responses, and persists state using
Slack-flavored `threadTs` and `statusMsgTs` values. Slack handlers also own
message dedupe, rate limiting, preflight checks, follow-up routing, and
clarification resume behavior.

The current governance checkpoint allows product expansion only when it is
evidence-gated and does not outrun trust infrastructure. A WhatsApp prototype
is new surface area, so it must stay narrow, feature-flagged, and measured
against explicit manual acceptance criteria before it can become a production
channel.

## Goals

- Prove official WhatsApp Cloud API integration can drive a single Annalytics
  request from inbound text to outbound answer.
- Keep Slack behavior unchanged.
- Avoid embedding OpenWA or other unofficial WhatsApp Web automation in the
  product runtime.
- Keep live WhatsApp identifiers, tokens, phone numbers, WABA IDs, and pilot
  evidence out of the reusable template repository.
- Establish a channel boundary that can be extended later without faking Slack
  concepts in WhatsApp.
- Preserve safe error handling, rate limiting, idempotency, and response
  persistence for WhatsApp requests.

## Non-Goals

- WhatsApp group chat support.
- Slack feature parity.
- App Home, slash commands, modals, reaction handlers, rich Block Kit controls,
  CSV/table override buttons, or reasoning toggles in WhatsApp.
- Business-initiated outreach outside a valid WhatsApp service window.
- OpenWA as a repo dependency, production adapter, or deployment requirement.
- A broad pipeline rewrite before the prototype proves the channel.
- New benchmark scaffolding beyond the manual prototype acceptance evidence.

## Recommended Approach

Use an official Cloud API-shaped prototype with a mockable outbound client.
The implementation should model Meta webhook verification, inbound payload
parsing, message dedupe, and outbound `messages` sends even when tests run
against local mocks. Live sends stay behind `WHATSAPP_ENABLED=true` and the
required WhatsApp env vars.

OpenWA may be used only outside this repository as a disposable local UX spike.
It must not shape committed product interfaces because it depends on WhatsApp
Web browser/session behavior and is not the production path.

## Alternatives Considered

### Adapter-First Refactor Before WhatsApp

Extract a fully transport-neutral pipeline before adding WhatsApp. This is the
cleanest long-term architecture, but it is too large for the prototype. The
current pipeline mixes core analytics behavior with Slack status updates,
thread context, and Block Kit rendering. A full refactor would create more risk
than the prototype needs.

### OpenWA Sandbox

Use OpenWA to move quickly with a local WhatsApp account. This is useful for a
throwaway UX spike, but it is not suitable for production Annalytics support.
The prototype should not depend on browser automation, QR reauthentication, or
unofficial API semantics.

### Separate Repository

Build WhatsApp support in a new repo. This would duplicate Annalytics safety
logic, BigQuery/dbt wiring, and state contracts. It only becomes appropriate if
the channel layer grows into a standalone messaging gateway product with its
own deploy cadence and ownership.

## User Experience

### Happy Path

1. A known user sends a text question to the WhatsApp business number.
2. The webhook verifies the request and normalizes the inbound message.
3. The bot sends one short acknowledgement: `Got it. I am checking that now.`
4. Annalytics runs the existing analytics path.
5. The bot sends one compact answer:
   - headline or answer summary
   - small table or single value when applicable
   - assumptions when they affect interpretation
   - trace id
   - short instruction for follow-up, such as replying with clarification

### Clarification

When clarification confidence is low, WhatsApp receives a plain-text
clarifying question. The user's next text reply in the same WhatsApp
conversation resumes the suspended request.

### Escalation

Slack remains the analyst and escalation surface for the prototype. If the
quality loop parks a request for human review, the WhatsApp user receives a
plain-text waiting message. The escalation card still posts to the configured
Slack destination. Analyst resolution posts back to WhatsApp only when the
stored escalation state identifies a WhatsApp origin.

### Unsupported Inputs

Non-text inbound WhatsApp messages receive one short unsupported-message reply:
`I can only answer text questions in this WhatsApp prototype.` The prototype
does not inspect images, documents, audio, locations, or contacts.

## Architecture

### New Channel Types

Add `src/channels/types.ts` with small, stable contracts:

```typescript
type ConversationSurface = 'slack' | 'whatsapp';

interface ConversationRef {
  surface: ConversationSurface;
  conversationId: string;
  userId: string;
}

interface ChannelMessage {
  surface: ConversationSurface;
  providerMessageId: string;
  conversation: ConversationRef;
  text: string;
  receivedAt: Date;
}

interface ChannelClient {
  sendText(conversation: ConversationRef, text: string): Promise<{ messageId: string }>;
  updateText?(messageId: string, text: string): Promise<void>;
  fetchContext?(conversation: ConversationRef, limit: number): Promise<ChannelMessage[]>;
}
```

The implementation should keep this boundary even if local TypeScript details
need small adjustments: channel code normalizes provider payloads, sends
provider messages, and does not own SQL generation or validation.

### WhatsApp Modules

- `src/whatsapp/webhook.ts`
  Registers `GET /whatsapp/webhook` and `POST /whatsapp/webhook` on the
  existing Express router.

- `src/whatsapp/signature.ts`
  Verifies `X-Hub-Signature-256` using HMAC-SHA256 over the raw request body
  and `WHATSAPP_APP_SECRET`.

- `src/whatsapp/payload.ts`
  Parses Meta webhook payloads into normalized `ChannelMessage` objects.
  Status-only payloads, unknown phone numbers, missing text bodies, and
  malformed payloads are ignored safely.

- `src/whatsapp/client.ts`
  Sends text messages to the Graph API `/{phone-number-id}/messages` endpoint.
  It has a test fake and logs provider errors without exposing raw provider
  detail to users.

- `src/whatsapp/renderer.ts`
  Converts Annalytics answer data into WhatsApp-safe plain text. The renderer
  caps rows and characters aggressively.

- `src/handlers/whatsappMessages.ts`
  Orchestrates dedupe, allowlist checks, rate limiting, preflight, pipeline
  invocation, and safe failure behavior for WhatsApp inbound messages.

### Pipeline Boundary

Avoid faking Slack Block Kit inside WhatsApp. The prototype should introduce a
narrow `runWhatsAppPipeline` wrapper that reuses existing pipeline stage helpers
where possible and emits WhatsApp text. If a helper is currently private inside
`runPipeline`, extract only that helper when it is required for WhatsApp and has
focused test coverage. Do not perform a full transport-neutral rewrite in this
prototype. A later tranche can do the deeper pipeline refactor if the prototype
is accepted.

### State Keys

All WhatsApp state identifiers must be surface-qualified:

- Inbound dedupe: `whatsapp:<providerMessageId>`
- Conversation/thread identity: `whatsapp:<wa_id>`
- Clarification id: `clarify_whatsapp:<wa_id>`
- Response context key: `whatsapp:<wa_id>_<outboundMessageId>` after the answer
  is sent; if an outbound id is unavailable, use
  `whatsapp:<wa_id>_<inboundProviderMessageId>`
- Escalation origin: include `originSurface: 'whatsapp'` or equivalent

Do not reuse raw WhatsApp ids in state locations that can collide with Slack
timestamps. Existing Slack keys can remain unchanged for the prototype, but new
WhatsApp keys must include the surface prefix.

### Configuration

Add optional configuration that is only required when WhatsApp is enabled:

- `WHATSAPP_ENABLED=false`
- `WHATSAPP_VERIFY_TOKEN`
- `WHATSAPP_APP_SECRET`
- `WHATSAPP_ACCESS_TOKEN`
- `WHATSAPP_PHONE_NUMBER_ID`
- `WHATSAPP_GRAPH_API_VERSION`
- `WHATSAPP_ALLOWED_WA_IDS`

`WHATSAPP_ALLOWED_WA_IDS` is recommended for the prototype so only explicit test
numbers can invoke the pipeline. The template docs may name these variables,
but must not include live values.

### Health and Diagnostics

`/health` remains dependency-free. `/health/doctor` may report WhatsApp as
configured or unconfigured. A live WhatsApp probe should be shallow and
metadata-only if possible; it must not send a user-visible test message.

## Data Flow

1. Meta calls `GET /whatsapp/webhook` during setup. The route checks
   `hub.verify_token` against `WHATSAPP_VERIFY_TOKEN` and returns
   `hub.challenge` on success.
2. Meta calls `POST /whatsapp/webhook` for inbound messages and status updates.
3. The route verifies `X-Hub-Signature-256` before parsing JSON.
4. The payload parser extracts one or more text `ChannelMessage` records.
5. The handler dedupes each provider message id.
6. The handler checks the optional allowlist and rate limit.
7. The handler checks pending clarification and pending escalation state for
   the surface-qualified conversation.
8. If clear, the handler sends the short acknowledgement.
9. The analytics path runs.
10. The WhatsApp renderer creates a compact text answer.
11. The WhatsApp client sends the answer.
12. Response context is persisted with surface metadata.

## Error Handling

- Bad webhook verification returns the appropriate setup failure response.
- Bad POST signatures return 401 and never parse or execute the payload.
- Duplicate messages return 200 without executing the pipeline again.
- Unsupported message types are handled without throwing.
- Provider send failures log safe structured details and surface a safe trace id
  when possible.
- User-visible text never contains raw provider errors, internal URLs, project
  ids, stack traces, access tokens, phone ids, WABA ids, or SQL validation
  internals beyond the existing safe Annalytics answer contract.

## Testing Strategy

Add focused tests before any live use:

- webhook GET verification success and failure
- POST signature success and failure
- parser behavior for text, status-only, non-text, missing fields, and multiple
  entries
- dedupe prevents duplicate pipeline invocation
- allowlist blocks unknown WhatsApp users when configured
- config requires WhatsApp secrets only when `WHATSAPP_ENABLED=true`
- renderer truncates table output and includes trace ids
- state-key helpers always prefix `whatsapp:`
- clarification resume works for a later inbound WhatsApp text
- existing Slack tests remain unchanged

No test should require live Meta credentials.

## Manual Prototype Acceptance

The prototype is accepted when:

- `npm run typecheck` passes.
- Targeted WhatsApp tests pass.
- Existing Slack handler and pipeline tests still pass.
- With a mocked WhatsApp client, one inbound text message produces exactly one
  pipeline invocation and one outbound text answer.
- Bad signatures and duplicate inbound ids do not run the pipeline.
- A clarification request can be answered by a later WhatsApp text message in
  the same conversation.
- Governance records the prototype as a gated channel experiment before it is
  treated as production product surface.

## Rollout

1. Land tests and code behind `WHATSAPP_ENABLED=false`.
2. Configure a test WABA and test phone number outside the template repo.
3. Enable an allowlisted internal number only.
4. Run a small manual smoke test:
   - simple single-value analytics question
   - small table question
   - intentionally ambiguous question requiring clarification
   - invalid or unsupported message type
   - duplicate webhook replay
5. Record evidence outside the reusable template unless the repository is
   intentionally converted into an implementation repo.
6. Update governance with the pilot outcome before expanding scope.

## Governance Notes

This prototype is surface-area expansion, so it must stay subordinate to the
trust guardrails:

- It cannot become production-default without manual acceptance evidence.
- It cannot add a second ReferenceCard domain or runtime behavior promotion by
  implication.
- It must not commit implementation-specific WhatsApp identifiers or pilot
  artifacts to the template repository.
- If the prototype changes the product trajectory, update
  `docs/trajectory-governance.md` in the same change set that activates the
  new trajectory.
