# WhatsApp Interactive Responses Design

**Date:** 2026-06-23
**Status:** Implemented
**Scope:** Design record for the WhatsApp interactive responses implementation

## Summary

Add native WhatsApp interactive responses to the existing gated WhatsApp
prototype so users can act on an answer without remembering text commands.
The feature should use official Meta WhatsApp Cloud API interactive reply
buttons and list messages, not Slack Block Kit and not OpenWA. It should keep
the prototype narrow: answer feedback, answer details, and safe output-format
choices. Slack remains the richer analyst/operator surface.

The recommended user-facing pattern is a compact two-step control surface:

1. After each WhatsApp answer, send an interactive reply-button message with
   three choices: `Looks right`, `Problem`, and `Actions`.
2. Use follow-up interactive messages only when needed:
   - `Actions` opens a list message for `Show reasoning`, `Show SQL`, `Table
     view`, and `Summary view`.
   - `Problem` opens a list or reply-button follow-up for negative-feedback
     reasons.

This respects WhatsApp's small-button UI while preserving the important Slack
trust affordances: feedback, reasoning, SQL visibility, and result re-rendering.

## Context

The current WhatsApp prototype is intentionally text-only. The outbound
client exposes `sendText`, the payload parser treats non-text inbound messages
as unsupported, and the WhatsApp pipeline renders compact plain text answers.
That was the right first prototype boundary, but it means WhatsApp users cannot
tap the same trust and feedback affordances that Slack users see as buttons.

The current Slack implementation has richer controls:

- positive and negative feedback buttons
- a reasoning toggle
- a SQL visibility toggle
- table, summary, and CSV output overrides
- negative-feedback reason prompts and a free-text "Other" modal

WhatsApp does not have Slack's update/modals/ephemeral model. It does have
native interactive messages. Meta's official docs describe reply-button
messages, list messages, interactive webhook replies, and the customer service
window for free-form service messages:

- https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/interactive-reply-buttons-messages
- https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/interactive-list-messages
- https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages/interactive/
- https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/send-messages

The design should continue the previous WhatsApp decision: use the official
Cloud API, keep OpenWA out of runtime, keep the code in this repo as a channel
adapter, and keep live WhatsApp identifiers and transcripts out of the template.

## Goals

- Let WhatsApp users provide quick positive or negative feedback on an answer.
- Let WhatsApp users request reasoning and generated SQL for a persisted
  answer without re-running the query.
- Let WhatsApp users request table or summary output overrides where those
  overrides are meaningful for the result shape.
- Keep interactions backed by existing `response_context` records.
- Preserve Slack behavior and Slack Block Kit code unchanged except for shared
  pure helpers where a helper already belongs outside Slack.
- Keep WhatsApp implementation surface isolated under `src/whatsapp/` where
  possible.
- Maintain the gated prototype posture: `WHATSAPP_ENABLED=false` by default
  and allowlist-based live testing.

## Non-Goals

- Full Slack parity.
- WhatsApp group chat support.
- WhatsApp-origin async human escalation creation or analyst resolution
  routing.
- Slack-style ephemeral prompts, modals, or in-place message updates.
- CSV export or document/media delivery in the first interactive slice.
- WhatsApp message templates for business-initiated outbound interactions.
- OpenWA, browser automation, QR-session management, or unofficial WhatsApp Web
  semantics.
- A transport-neutral Block Kit replacement layer.

## External API Constraints

The implementation should treat these WhatsApp Cloud API constraints as design
inputs:

- Reply buttons are a compact control surface and support up to three
  predefined replies.
- List messages are the better fit when the action menu has more than three
  choices.
- Interactive replies arrive through the messages webhook with action-specific
  IDs and titles. Backend routing should use IDs, not localized display text.
- Free-form service messages are constrained by the WhatsApp customer service
  window. This feature is scoped to user-initiated conversations in the current
  prototype and should not introduce business-initiated template outreach.
- WhatsApp does not update a previously sent answer in the same way Slack
  `chat.update` does. Actions should generally send a new follow-up message.

## Alternatives Considered

### A. One Reply-Button Row After Every Answer

Send only three reply buttons after every answer: `Looks right`, `Problem`,
and `Reasoning`.

This is simple, but it hides SQL and output overrides, and forces the design to
choose one trust affordance over another. It also gives the user no place to
discover table/summary options.

### B. One Large List After Every Answer

Send one list message after every answer containing every possible action.

This exposes more controls, but it is heavier than the normal answer path and
turns every response into a menu. It also makes the most common actions,
positive and negative feedback, one tap deeper than they should be.

### C. Hybrid Reply Buttons Plus Follow-Up Lists

Send the three most important top-level choices as reply buttons:
`Looks right`, `Problem`, and `Actions`. Use list messages for secondary
menus.

This is the recommended approach. It keeps the happy path lightweight, keeps
feedback easy, and still exposes the richer trust controls. It also maps cleanly
onto WhatsApp's native UI constraints instead of trying to simulate Slack.

## Recommended User Experience

### Answer Path

After the compact text answer is sent and response context is persisted, send
an interactive reply-button message:

- `Looks right`
- `Problem`
- `Actions`

The body should be short, for example:

```text
Was this answer useful?
```

The footer may include the trace id if it fits cleanly, but the answer text
already carries a trace id today. Do not duplicate long provenance in the
interactive prompt.

### Positive Feedback

When the user taps `Looks right`, record positive feedback against the
persisted response context. Send a short confirmation:

```text
Got it. I marked this answer as useful.
```

If the response context has expired, degrade safely:

```text
I cannot find that answer context anymore. Ask the question again if you want
me to re-check it.
```

### Negative Feedback

When the user taps `Problem`, send a follow-up reason picker. Use reply buttons
if there are three reasons or fewer; otherwise use a list message. The first
slice should include:

- `Wrong number`
- `Wrong data`
- `Not my question`
- `Other`

`Wrong number` and `Wrong data` should record negative feedback only in this
slice. Analyst-facing escalation from WhatsApp-origin feedback remains out of
scope under the current governance checkpoint. If that becomes desirable later,
it needs a separate design and a governance update before implementation.

`Not my question` should send a short prompt asking the user to restate the
question in the same WhatsApp thread. It should not automatically re-run the
previous SQL.

`Other` requires pending state because WhatsApp has no modal. The action should
send:

```text
Reply with what was wrong, and I will attach it to this answer.
```

The next inbound text from that WhatsApp conversation should be captured as the
free-text feedback note, then the pending state should clear.

### Actions Menu

When the user taps `Actions`, send a list message. Include rows only when they
are meaningful for the persisted result shape:

- `Show reasoning`
- `Show SQL`
- `Table view`
- `Summary view`

Suppress table/summary actions using the same row/column shape rules Slack uses
for output overrides. For zero-row and single-scalar answers, omit table and
summary because they add little value.

`Show reasoning` and `Show SQL` should load from `response_context` and send a
new plain-text follow-up. They should not call Gemini or BigQuery.

`Table view` and `Summary view` may reuse the existing override logic if the
shared path can be called without Slack dependencies. If the existing handlers
are too Slack-shaped, the first implementation should add a WhatsApp-specific
re-render path that uses the persisted SQL and existing validation/execution
contracts, then sends a new WhatsApp text response.

CSV should remain deferred because a useful CSV action in WhatsApp implies
document/media upload, filename handling, and possibly a different privacy and
retention surface.

## Architecture

### WhatsApp Interactive Types

Add `src/whatsapp/interactive.ts` with WhatsApp-owned types and builders:

- `WhatsAppInteractiveMessage`
- `WhatsAppReplyButton`
- `WhatsAppListSection`
- `WhatsAppListRow`
- `buildAnswerFeedbackButtons(...)`
- `buildProblemReasonPicker(...)`
- `buildAnswerActionsList(...)`

These builders should output Meta Cloud API payload fragments. They should not
import Slack block builders.

### WhatsApp Client

Extend the concrete WhatsApp client with provider-specific interactive sending:

```typescript
interface WhatsAppInteractiveClient extends ChannelClient {
  sendInteractive(
    conversation: ConversationRef,
    message: WhatsAppInteractiveMessage,
  ): Promise<{ messageId: string }>;
}
```

Do not add `sendInteractive` to the generic `ChannelClient` unless another
surface needs it. The generic channel interface should stay small; WhatsApp
interactivity is provider-specific.

### Action IDs

Use compact, versioned action IDs. IDs should be stable backend contracts and
must not rely on display text.

Recommended implementation shape:

```text
wa:v1:<kind>:<contextId>
```

Examples:

```text
wa:v1:ok:<contextId>
wa:v1:problem:<contextId>
wa:v1:actions:<contextId>
wa:v1:reason_wrong_number:<contextId>
wa:v1:show_reasoning:<contextId>
wa:v1:show_sql:<contextId>
wa:v1:override_table:<contextId>
wa:v1:override_summary:<contextId>
```

The implementation plan resolves the Meta action-id length question by adding
`whatsapp_action_context` from the start. The `<contextId>` is a short opaque
document id. The context document stores the `responseContextKey`, action kind,
conversation id, user id, and TTL. Do not embed full WhatsApp provider message
ids in action IDs, and do not silently truncate IDs; truncation would make
action routing unsafe.

The stored `responseContextKey` should be the Firestore document id format
already used by `response_context`. Because WhatsApp outbound message IDs can
contain characters that are unsafe in Firestore path segments, the existing
URL-encoding rule for WhatsApp `statusMsgTs` must remain the single source of
truth for building the key.

### Webhook Parsing

Extend `src/whatsapp/payload.ts` so interactive replies are parsed separately
from normal user text:

```typescript
interface WhatsAppInteractiveAction {
  providerMessageId: string;
  conversation: ConversationRef;
  receivedAt: Date;
  actionId: string;
  actionTitle: string;
  kind: 'button_reply' | 'list_reply';
}
```

`parseWhatsAppWebhookPayload` should return both `messages` and `actions`.
Plain text should continue to flow through the existing message pipeline.
Interactive replies should flow through a new action handler and should not be
treated as unsupported messages.

### Action Handler

Add `src/whatsapp/actions.ts` to route parsed actions:

- validate allowlist
- dedupe the action provider message id
- parse and validate the action id
- load `response_context`
- dispatch the action
- send a safe follow-up message
- mark the event visible only after a visible response or safe no-op

This handler should mirror the defensive behavior in `src/whatsapp/messages.ts`
but should not run the analytics pipeline for detail-only actions.

### Pending Free-Text Feedback State

For `Other`, add a small state record rather than overloading clarification
state:

```typescript
interface WhatsAppPendingFeedbackNote {
  id: string;                  // feedback_whatsapp:<wa_id>
  conversationId: string;      // whatsapp:<wa_id>
  responseContextKey: string;
  traceId: string;
  createdAt: Date;
  expiresAt: Date;
}
```

When a normal text message arrives, `src/whatsapp/messages.ts` should check this
state before checking clarification state. If present, capture the inbound text
as a feedback note for the stored response context and clear the pending state.

This keeps "the next text is feedback" separate from "the next text resumes a
clarification." If both states somehow exist, feedback-note state wins because
it was initiated by the user's immediate button action; log the collision.

### Response Context Use

Interactive actions should rely on persisted `ResponseContext`:

- feedback updates the existing context
- reasoning renders `explanation`, `reasoningChain`, citations, assumptions,
  and supervisor notes from context
- SQL renders `generatedSql`
- table/summary overrides use persisted SQL and result-shape metadata

If the context is missing or expired, send safe recovery copy and do not throw.

### Message Updating

Do not try to update the original WhatsApp answer in place. The first
implementation should send follow-up messages. This matches WhatsApp's
conversation model and avoids a brittle provider capability dependency.

## Data Flow

### Initial Answer

1. User sends a text question.
2. Existing WhatsApp message pipeline runs.
3. Bot sends the compact text answer.
4. Pipeline saves `response_context` using the outbound answer message id.
5. Bot creates short action-context records and sends the interactive
   answer-control prompt with action IDs that reference those records.

### Interactive Action

1. User taps a WhatsApp button or list row.
2. Meta sends a `messages` webhook containing an interactive reply.
3. Webhook signature verification runs before JSON parsing, as today.
4. Payload parser emits a `WhatsAppInteractiveAction`.
5. Action handler dedupes the provider message id.
6. Action handler validates the allowlist and action id.
7. Action handler loads the referenced `response_context`.
8. Action handler executes the action and sends a follow-up message.
9. The dedupe doc is marked visible.

### Other Feedback

1. User taps `Problem`.
2. User taps `Other`.
3. Bot creates `whatsapp_pending_feedback_notes` state and asks for free text.
4. User sends text.
5. Normal message handler sees pending feedback state first.
6. Handler saves a feedback note, clears the pending state, and sends an ack.

## State And Collections

Preferred first slice:

- Reuse `response_context`.
- Reuse WhatsApp event dedupe for interactive action message IDs.
- Add `whatsapp_action_context` for compact action IDs.
- Add `whatsapp_pending_feedback_notes` because `Other` is included.

TTL policy is required for any new collection with `expiresAt`. Add the
collection to `infra/firestore.ttls.json` and parity tests in the same change.

## Error Handling

- Invalid action IDs: send no internal detail; log safely and mark the event
  visible only if the user gets a visible response.
- Expired response context: send recovery copy telling the user to re-ask.
- Provider send failure before a visible response: release the dedupe claim so
  Meta retry behavior can recover.
- Provider send failure after a visible response: keep the event visible to
  avoid duplicate prompts.
- Missing allowlist match: ignore, as the current WhatsApp message handler does.
- Unsupported interactive kind: send the existing unsupported-message copy only
  if it came from an allowlisted user; otherwise ignore.

## Security And Privacy

- Never put access tokens, phone number IDs, WABA IDs, project IDs, or raw
  provider errors in user-visible WhatsApp text.
- Treat all action IDs as untrusted webhook input. Validate prefix, version,
  kind, and response-context key before loading state or dispatching.
- Do not expose full reasoning by default. Only send reasoning after an explicit
  user action.
- Do not send SQL unless the user explicitly taps `Show SQL`.
- Keep the allowlist enabled during prototype testing.
- Keep OpenWA out of committed runtime code and deployment configuration.

## Testing Strategy

Add tests before implementation:

- `tests/whatsapp/interactive.test.ts`
  - builds answer feedback reply buttons
  - builds action list rows with stable IDs
  - suppresses table/summary rows for zero-row and single-scalar results

- `tests/whatsapp/client.test.ts`
  - sends interactive button payloads to the existing Graph API `/messages`
    endpoint
  - propagates safe provider-send errors
  - extracts outbound message IDs from successful sends

- `tests/whatsapp/payload.test.ts`
  - parses button replies
  - parses list replies
  - keeps plain text parsing unchanged
  - does not classify interactive replies as unsupported messages

- `tests/whatsapp/actions.test.ts`
  - records positive feedback
  - sends expired-context recovery copy
  - renders reasoning without Gemini or BigQuery calls
  - renders SQL without Gemini or BigQuery calls
  - dispatches table and summary overrides only when context exists
  - handles invalid action IDs safely
  - dedupes action provider message IDs

- `tests/whatsapp/messages.test.ts`
  - pending free-text feedback note wins before normal pipeline execution
  - pending feedback state is cleared after save
  - clarification resume still works when no pending feedback state exists

- `tests/infra/firestoreTtls.test.ts`
  - includes any new TTL-backed collections.

Existing Slack tests must remain unchanged. This feature should not weaken
Slack interactivity.

## Manual Acceptance

The interactive WhatsApp slice is accepted when:

- `npm run typecheck` passes.
- Targeted WhatsApp tests pass.
- Existing Slack interactivity tests pass.
- In the deployed WhatsApp demo service, an allowlisted user can:
  - ask a simple analytics question
  - tap `Looks right` and receive an acknowledgement
  - tap `Actions` and then `Show SQL`
  - tap `Actions` and then `Show reasoning`
  - tap `Actions` and then `Table view` on a table-shaped answer
  - tap `Actions` and then `Summary view` on a table-shaped answer
  - tap `Problem` and record one negative-feedback reason
  - tap `Problem` -> `Other`, send free text, and see it captured
- A replayed interactive webhook does not duplicate the action.
- A stale/expired response-context key degrades safely.
- No live WhatsApp identifiers, phone numbers, tokens, pilot transcripts, or
  Cloud Run URLs are committed to the template.

## Rollout

1. Implement behind existing `WHATSAPP_ENABLED` and allowlist controls.
2. Deploy only to the existing WhatsApp demo service first.
3. Smoke test with one allowlisted number.
4. Watch Cloud Run logs for action parse failures, provider send failures, and
   response-context misses.
5. Record manual acceptance evidence outside the template repo.
6. Update `docs/trajectory-governance.md` only if the prototype is promoted
   beyond gated demo behavior or if WhatsApp-origin escalation becomes active
   scope.

## Implementation Planning Decisions

- Use `whatsapp_action_context` from the start so Meta action IDs remain short
  and never embed raw provider message IDs.
- Include `Table view` and `Summary view` in the first implementation plan.
  They re-execute the stored SQL through the existing validation/execution
  contracts and send new WhatsApp text follow-ups.

## Design Decision

Proceed with the hybrid reply-button plus list-message design. It is the
smallest WhatsApp-native interaction model that preserves the trust affordances
users already get in Slack, while staying inside the current gated prototype
boundary.
