#!/usr/bin/env node
/* global process, console, fetch */
// Transport smoke test for the negative-feedback escalation buttons.
//
// WHAT THIS COVERS (and what it does NOT):
//   The 599-test vitest suite already proves the handler *logic*. The one layer
//   it can't reach is the live HTTP transport: Slack request-signature
//   verification + Bolt action routing for the new `fb_reason_*` buttons. This
//   script sends a correctly *signed* synthetic `block_actions` payload to the
//   bot's `/slack/events` endpoint and asserts a 200 ack. A 200 proves:
//     1. the X-Slack-Signature was accepted (signing secret + v0 scheme correct),
//     2. Bolt matched the action_id to a registered handler,
//     3. the receiver acked (processBeforeResponse:false ⇒ ack is immediate).
//   It does NOT assert anything about the handler's *downstream* Slack/Firestore
//   calls, which run asynchronously after the ack.
//
// WHY IT'S SAFE AGAINST PRODUCTION:
//   IDs below are synthetic (U_SMOKE/C_SMOKE + a bogus message ts). The escalate
//   branch loads getResponseContext(compoundKey); a synthetic key matches no real
//   doc, so the handler degrades ("re-ask") BEFORE posting any escalation card.
//   No card is posted, no real Firestore doc is mutated. The only async side
//   effect is a respond()/postEphemeral attempt that fails harmlessly post-ack.
//
// USAGE:
//   SLACK_SIGNING_SECRET=... node scripts/smoke/feedbackEscalationTransport.mjs [target]
//     target = thumbs-down | reason:<id> | sequence   (default: sequence)
//   Optional env:
//     BASE_URL   default http://localhost:3000   (point at the deployed URL to smoke prod)
//     EVENTS_PATH default /slack/events
//
// The signing secret is read from env only and is never printed.

import { createHmac } from 'node:crypto';

const SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET;
if (!SIGNING_SECRET) {
  console.error('ERROR: set SLACK_SIGNING_SECRET in the environment (it is read, never printed).');
  process.exit(2);
}

const BASE_URL = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const EVENTS_PATH = process.env.EVENTS_PATH || '/slack/events';
const URL = `${BASE_URL}${EVENTS_PATH}`;

// Synthetic identifiers — chosen so nothing matches real Slack/Firestore data.
const USER = 'U_SMOKE';
const CHANNEL = 'C_SMOKE';
const THREAD_TS = '1700000000.000100';
const STATUS_TS = '1700000000.000200';
const COMPOUND_KEY = `${THREAD_TS}_${STATUS_TS}`;
const TRACE_ID = 'smoke-trace';

/** Build a Slack block_actions interaction payload for one button click. */
function buildPayload(actionId, value) {
  return {
    type: 'block_actions',
    token: 'smoke',
    team: { id: 'T_SMOKE' },
    user: { id: USER },
    api_app_id: 'A_SMOKE',
    // A real response_url would let respond() succeed; a placeholder just fails
    // harmlessly after the ack we are measuring.
    response_url: 'https://example.invalid/response_url',
    trigger_id: 'smoke.trigger',
    channel: { id: CHANNEL },
    message: { type: 'message', ts: STATUS_TS, thread_ts: THREAD_TS },
    actions: [{ type: 'button', action_id: actionId, block_id: 'smoke_block', value }],
  };
}

/** Sign + POST one payload exactly the way Slack does; return {status, ms}. */
async function send(label, payload) {
  // Slack interactivity is form-encoded as `payload=<urlencoded JSON>`.
  const rawBody = `payload=${encodeURIComponent(JSON.stringify(payload))}`;
  const ts = Math.floor(Date.now() / 1000).toString();
  const sig =
    'v0=' + createHmac('sha256', SIGNING_SECRET).update(`v0:${ts}:${rawBody}`).digest('hex');

  const started = Date.now();
  let res;
  try {
    res = await fetch(URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Slack-Request-Timestamp': ts,
        'X-Slack-Signature': sig,
      },
      body: rawBody,
    });
  } catch (err) {
    console.error(`  ✗ ${label}: request failed (${err.message}) — is ${BASE_URL} reachable?`);
    return { ok: false };
  }
  const ms = Date.now() - started;
  const ok = res.status === 200;
  console.log(`  ${ok ? '✓' : '✗'} ${label}: HTTP ${res.status} (${ms}ms)`);
  return { ok, status: res.status };
}

const steps = [];
const arg = (process.argv[2] || 'sequence').toLowerCase();
if (arg === 'thumbs-down' || arg === 'sequence') {
  steps.push(['👎 thumbs_down', buildPayload(`thumbs_down_${TRACE_ID}`, TRACE_ID)]);
}
if (arg.startsWith('reason:')) {
  const id = arg.slice('reason:'.length);
  steps.push([`reason ${id}`, buildPayload(`fb_reason_${id}`, COMPOUND_KEY)]);
} else if (arg === 'sequence') {
  steps.push(['reason wrong_number', buildPayload('fb_reason_wrong_number', COMPOUND_KEY)]);
}
if (steps.length === 0) {
  console.error(`Unknown target "${arg}". Use: thumbs-down | reason:<id> | sequence`);
  process.exit(2);
}

console.log(`Target: ${URL}`);
let allOk = true;
for (const [label, payload] of steps) {
  const r = await send(label, payload);
  allOk = allOk && r.ok;
}
console.log(allOk ? '\nPASS: endpoint accepted + routed all signed actions.' : '\nFAIL: see above.');
process.exit(allOk ? 0 : 1);
