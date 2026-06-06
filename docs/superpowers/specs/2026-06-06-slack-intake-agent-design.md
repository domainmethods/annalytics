# Slack Intake Agent Design

## Context

Anna Lytics currently handles Slack DMs, app mentions, and slash commands by sending users through the normal analytics pipeline unless a hardcoded helper recognizes an exact greeting/help phrase. That helper improves latency for simple messages like "hi", but it is brittle and should not grow into a phrase list.

The desired behavior is a fast, flexible Slack front-door router that can respond immediately to greetings/help/small talk while sending any plausible analytics question into the existing pipeline.

## Goals

- Replace hardcoded greeting/help phrase matching with a Gemini Flash intake agent.
- Keep obvious conversational Slack messages fast without posting `Understanding your question...`.
- Preserve the existing analytics pipeline for real data questions.
- Keep the template implementation-agnostic and avoid client-specific metric, project, or warehouse claims.
- Fail safe: if intake classification is uncertain or fails, route to the analytics pipeline.

## Non-Goals

- Do not change SQL generation, validation, execution, or response formatting.
- Do not add client-specific ReferenceCards, dbt artifacts, benchmark outputs, project IDs, store IDs, or Cloud Run URLs.
- Do not make the intake agent a second source of metric/domain truth.
- Do not use File Search or dbt context in this intake step.

## Architecture

Add a dedicated `src/agents/slackIntakeAgent.ts` using Gemini Flash via `getFlashModel()` and structured JSON output.

The agent returns:

```ts
type SlackIntakeRoute = 'immediate_response' | 'analytics_pipeline';

interface SlackIntakeResult {
  route: SlackIntakeRoute;
  responseText: string | null;
  reasoning: string;
}
```

Boundary responsibilities:

- `slackIntakeAgent`: Slack front-door UX routing for greetings, help, thanks, capability questions, and obvious small talk.
- `clarificationAgent`: analytics question readiness and ambiguity handling.
- `runPipeline`: SQL generation, validation, execution, and final analytics response.

The existing hardcoded greeting/helper behavior will be removed.

## Handler Flow

For Slack DMs, app mentions, and `/anna` commands:

1. Acknowledge Slack immediately, as today.
2. Run existing cheap guards:
   - event dedupe for message/app mention events
   - rate limit
   - preflight/thread lock where applicable
3. Before posting `Understanding your question...`, call `classifySlackIntake(text, apiKey)`.
4. If the result is `immediate_response`:
   - post the generated `responseText`
   - mark the Slack event visible when event dedupe is active
   - release the thread lock when one was acquired
   - return without calling `runPipeline`
5. If the result is `analytics_pipeline`, continue the current behavior and run the analytics pipeline.

If the intake call fails, times out, returns invalid JSON, returns empty response text for `immediate_response`, or violates the response contract, the caller treats it as `analytics_pipeline`.

## Prompt Contract

The prompt instructs Flash to classify Slack text into one of two routes:

- `immediate_response`: greetings, help/capability questions, thanks, and obvious small talk.
- `analytics_pipeline`: anything asking about data, metrics, dimensions, time periods, trends, counts, performance, causes, comparisons, or business questions.

If unsure, choose `analytics_pipeline`.

For `immediate_response`, Flash generates `responseText` under these rules:

- maximum 2 short sentences
- no SQL
- no table names
- no project or client names
- no dbt, File Search, or internal implementation details
- no claims about available metrics unless the user named them
- keep the response generic and template-safe

The `reasoning` field is internal and is not shown to Slack users.

## Runtime Guardrails

The implementation validates the model response before using it:

- `responseText` must be non-empty for `immediate_response`.
- Response text must fit a sane max length.
- Unsafe response text falls back to `analytics_pipeline`.
- Obvious unsafe content includes SQL code fences, table-like identifiers, `dbt`, `File Search`, project IDs, and internal implementation details.
- Model errors, timeouts, invalid JSON, schema mismatches, and empty text fall back to `analytics_pipeline`.

Fallback must preserve correctness. A transient Flash failure may make greetings slower, but it must not block real analytics questions or produce misleading answers.

## Testing

Add tests for the agent with mocked Gemini:

- greeting returns `immediate_response` with model-generated text
- capability/help question returns `immediate_response`
- substantive analytics question returns `analytics_pipeline`
- vague analytics prompt like `traffic last month?` returns `analytics_pipeline`
- invalid JSON falls back to `analytics_pipeline`
- empty `responseText` for `immediate_response` falls back to `analytics_pipeline`
- unsafe response text falls back to `analytics_pipeline`
- timeout or rejected model call falls back to `analytics_pipeline`

Add or update handler tests/focused seams:

- immediate response path does not post `Understanding your question...`
- immediate response path does not call `runPipeline`
- analytics route preserves current pipeline behavior
- lock and event dedupe cleanup remain correct

Run:

```bash
npm run typecheck
npx vitest run tests/agents/slackIntakeAgent.test.ts tests/handlers/messages.test.ts tests/state/slackEventDedupe.test.ts tests/state/threadLock.test.ts tests/handlers/preflightChecks.test.ts
npm test
git diff --check
```

## Rollout

1. Remove the hardcoded immediate-help helper and exact phrase tests.
2. Implement the Flash intake agent and handler integration on the existing PR branch.
3. Push the PR update.
4. Build and deploy the new commit to Cloud Run.
5. Verify `/health` returns `200 OK`.
6. Send `hi` in Slack and confirm a fast generated response.
7. Send a real analytics question and confirm it enters the normal pipeline.
