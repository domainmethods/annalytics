import { GoogleGenAI } from '@google/genai';
import { z } from 'zod';
import { toJSONSchema } from 'zod/v4/core';
import type { ThreadMessage } from '../types.js';
import { generateForNode } from './modelGateway.js';

const FollowUpSchema = z.object({
  intent: z.enum(['new_query', 'refinement', 'meta_question', 'discrepancy']),
  reasoning: z.string(),
});

export type FollowUpIntent = 'new_query' | 'refinement' | 'meta_question' | 'discrepancy';

export async function classifyFollowUp(
  message: string,
  threadContext: ThreadMessage[],
  apiKey: string,
): Promise<{ intent: FollowUpIntent; reasoning: string }> {
  const ai = new GoogleGenAI({ apiKey });

  const prompt = `Classify this follow-up message in a data analysis conversation thread.

THREAD CONTEXT (recent messages):
${threadContext.map(m => `${m.role}: ${m.content}`).join('\n')}

FOLLOW-UP MESSAGE: ${message}

Intent types:
- new_query: Unrelated data question
- refinement: Modify the previous query (add columns, change filters, different grouping)
- meta_question: Question about the bot's reasoning ("why did you use that table?")
- discrepancy: "If X, how come Y?" investigation`;

  const response = await generateForNode('followUpClassifier', ai, {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    config: {
      responseMimeType: 'application/json',
      responseJsonSchema: toJSONSchema(FollowUpSchema),
    },
  });

  const text = response.text;
  if (!text) throw new Error('Empty response from Gemini');

  return JSON.parse(text) as { intent: FollowUpIntent; reasoning: string };
}
