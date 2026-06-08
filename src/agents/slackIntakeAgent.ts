import { GoogleGenAI } from '@google/genai';
import { z } from 'zod';
import { toJSONSchema } from 'zod/v4/core';
import { generateForNode } from './modelGateway.js';
import { rootLogger } from '../logging.js';

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
// Flash structured-output latency for this classification is ~1.7-2.2s warm and
// higher on a cold start. A 2s cap silently dropped real greetings into the
// analytics pipeline (fail-open), so the timeout must clear that band with
// headroom while still bounding a genuinely hung call.
const INTAKE_TIMEOUT_MS = 8_000;

// Why a fail-open fallback fired. Logged as a structured reason code so a
// timeout, a model/network error, a malformed payload, and a sanitize rejection
// are distinguishable in production instead of all looking like a silent route
// to the analytics pipeline. Never logged alongside user or response text.
type IntakeFallbackReason =
  | 'timeout'
  | 'model_error'
  | 'json_parse_error'
  | 'schema_validation_error'
  | 'sanitize_empty'
  | 'sanitize_oversized'
  | 'sanitize_unsafe'
  | 'unexpected_error';

// Correlation fields shared by every fallback log so a production entry can be
// tied back to the originating Slack thread. Plain identifiers only — never the
// message or response text.
interface IntakeLogContext {
  channel?: string;
  threadTs?: string;
}

// Distinct error type so the catch can tell a timeout apart from a model/network
// failure without string-matching the message.
class IntakeTimeoutError extends Error {}

function logIntakeFallback(
  reason: IntakeFallbackReason,
  meta: IntakeLogContext & { elapsedMs?: number; textLength?: number } = {},
): void {
  rootLogger.warn({ reason, ...meta }, 'intake.fallback');
}


export async function classifySlackIntake(
  text: string,
  apiKey: string,
  options: { timeoutMs?: number } & IntakeLogContext = {},
): Promise<SlackIntakeResult> {
  const startTime = Date.now();
  const context: IntakeLogContext = { channel: options.channel, threadTs: options.threadTs };

  // Deterministic fast-path: obvious greetings and thanks are classified by a
  // pure string match, with no model call. This is what makes "hi" robust to
  // cold-start event-loop starvation — the model round-trip and the
  // setTimeout-based timeout both depend on a live event loop (an 8s cap was
  // observed taking 60s on a throttled Cloud Run container and failing open
  // into the analytics pipeline), whereas this match waits on neither I/O nor a
  // timer and resolves instantly under any infra config.
  const obvious = classifyObviousIntake(text);
  if (obvious) return obvious;

  let response: { text?: string };
  try {
    const ai = new GoogleGenAI({ apiKey });
    response = await withTimeout(
      generateForNode('slackIntake', ai, {
        contents: [{ role: 'user', parts: [{ text: buildPrompt(text) }] }],
        config: {
          responseMimeType: 'application/json',
          responseJsonSchema: toJSONSchema(SlackIntakeSchema),
        },
      }),
      options.timeoutMs ?? INTAKE_TIMEOUT_MS,
    );
  } catch (error) {
    const reason: IntakeFallbackReason =
      error instanceof IntakeTimeoutError ? 'timeout' : 'model_error';
    logIntakeFallback(reason, { ...context, elapsedMs: Date.now() - startTime });
    return FALLBACK_RESULT;
  }

  const responseText = response.text ?? '';

  let json: unknown;
  try {
    json = JSON.parse(responseText || '{}');
  } catch {
    logIntakeFallback('json_parse_error', { ...context, textLength: responseText.length });
    return FALLBACK_RESULT;
  }

  const validation = SlackIntakeSchema.safeParse(json);
  if (!validation.success) {
    logIntakeFallback('schema_validation_error', { ...context, textLength: responseText.length });
    return FALLBACK_RESULT;
  }

  // sanitizeResult only operates on bounded primitives, so a throw here is not
  // expected — but keep the never-throw / fail-open contract the caller relies
  // on, and log it under a distinct reason rather than masking it as a model
  // failure.
  try {
    return sanitizeResult(validation.data, context);
  } catch {
    logIntakeFallback('unexpected_error', { ...context, elapsedMs: Date.now() - startTime });
    return FALLBACK_RESULT;
  }
}

// ── Deterministic intake fast-path ─────────────────────────────────────────
//
// Precision over recall by design: a miss simply falls through to the model
// (status quo, no regression), so the cost of being conservative is nil, while
// a false positive would answer a real analytics question with a canned
// greeting. We therefore match only when the WHOLE normalized message is a
// known greeting/thanks phrase — any substantive token makes it fall through.
const GREETING_PHRASES = new Set([
  'hi', 'hello', 'hey', 'heya', 'hiya', 'yo', 'hullo', 'howdy', 'greetings',
  'sup', 'whats up', 'wassup', 'hi there', 'hello there', 'hey there',
  'hi anna', 'hello anna', 'hey anna', 'hi everyone', 'hello everyone',
  'hey everyone', 'hi all', 'hello all', 'hi team', 'hey team', 'hello team',
  'good morning', 'good afternoon', 'good evening', 'gm', 'morning',
]);

const THANKS_PHRASES = new Set([
  'thanks', 'thank you', 'ty', 'thx', 'thank u', 'cheers', 'thanks anna',
  'thank you anna', 'thanks so much', 'thank you so much', 'thanks a lot',
  'thanks a bunch', 'much appreciated', 'appreciate it', 'thanks again',
  'thank you very much', 'ok thanks', 'okay thanks', 'great thanks',
]);

const GREETING_RESPONSE =
  "Hi! Ask me a question about your data and I'll pull the numbers for you.";
const THANKS_RESPONSE =
  "You're welcome! Send a data question whenever you need numbers.";

// Lowercase, drop apostrophes (so "what's" → "whats"), replace every remaining
// non-alphanumeric run — punctuation, emoji, symbols — with a single space, and
// collapse whitespace. "Hi!!! 👋" and "hi" normalize identically.
function normalizeIntakeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/['’`]/g, '')
    .replace(/[^\p{Letter}\p{Number}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function classifyObviousIntake(text: string): SlackIntakeResult | null {
  const normalized = normalizeIntakeText(text);
  if (!normalized) return null;
  if (GREETING_PHRASES.has(normalized)) {
    return { route: 'immediate_response', responseText: GREETING_RESPONSE, reasoning: 'deterministic: greeting' };
  }
  if (THANKS_PHRASES.has(normalized)) {
    return { route: 'immediate_response', responseText: THANKS_RESPONSE, reasoning: 'deterministic: thanks' };
  }
  return null;
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

function sanitizeResult(
  result: SlackIntakeResult,
  context: IntakeLogContext = {},
): SlackIntakeResult {
  if (result.route === 'analytics_pipeline') {
    return {
      route: 'analytics_pipeline',
      responseText: null,
      reasoning: result.reasoning,
    };
  }

  const responseText = result.responseText?.trim() ?? '';
  if (!responseText) {
    logIntakeFallback('sanitize_empty', { ...context, textLength: 0 });
    return FALLBACK_RESULT;
  }
  if (responseText.length > MAX_RESPONSE_CHARS) {
    logIntakeFallback('sanitize_oversized', { ...context, textLength: responseText.length });
    return FALLBACK_RESULT;
  }
  if (isUnsafeResponse(responseText)) {
    logIntakeFallback('sanitize_unsafe', { ...context, textLength: responseText.length });
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
  if (['dbt', 'file search', 'gemini', 'firestore', 'cloud run', 'secret manager'].some((term) => lower.includes(term))) return true;
  if (text.includes('```') || looksLikeSql(text)) return true;
  if (/\bproject\s+[a-z][a-z0-9-]{4,}-\d{3,}\b/i.test(text)) return true;
  if (/\b[a-z][\w-]+\.[a-z][\w-]+\.[a-z][\w-]+\b/i.test(text)) return true;
  if (/\b[a-z][\w-]+\.[a-z][\w-]+\b/i.test(text) && lower.includes('table')) return true;
  return false;
}

// A bare SELECT...FROM pair also occurs in plain prose ("you can select a metric
// and I'll pull it from your data"), so we don't block on that alone. Require a
// SQL-specific marker: a statement terminator, a backticked identifier after FROM,
// or a qualified (dotted) table reference right after FROM.
function looksLikeSql(text: string): boolean {
  if (!/\bselect\b[\s\S]+\bfrom\b/i.test(text)) return false;
  if (/;/.test(text)) return true;
  if (/\bfrom\s+`/i.test(text)) return true;
  if (/\bfrom\s+[a-z][\w-]*\.[a-z][\w-]*/i.test(text)) return true;
  return false;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => reject(new IntakeTimeoutError('Slack intake timeout')), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
