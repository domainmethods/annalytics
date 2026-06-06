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
  if (['dbt', 'file search', 'gemini', 'firestore', 'cloud run', 'secret manager'].some((term) => lower.includes(term))) return true;
  if (text.includes('```') || /\bselect\b.+\bfrom\b/is.test(text)) return true;
  if (/\bproject\s+[a-z][a-z0-9-]{4,}-\d{3,}\b/i.test(text)) return true;
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
