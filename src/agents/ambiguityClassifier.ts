import { GoogleGenAI } from '@google/genai';
import { z } from 'zod';
import { toJSONSchema } from 'zod/v4/core';
import type { ThreadMessage } from '../types.js';
import { generateForNode } from './modelGateway.js';

const AmbiguityClassificationSchema = z.object({
  type: z.enum(['user_intent', 'org_knowledge']),
  question: z.string(),
  domain: z.string(),
  reasoning: z.string(),
});

export type AmbiguityType = 'user_intent' | 'org_knowledge';

export interface AmbiguityClassification {
  type: AmbiguityType;
  question: string;
  domain: string;
  reasoning: string;
}

export interface AmbiguityClassifierInput {
  question: string;
  ambiguities: string[];
  clarifyingQuestions: string[];
  threadContext: ThreadMessage[];
}

export async function classifyAmbiguity(
  input: AmbiguityClassifierInput,
  apiKey: string,
): Promise<AmbiguityClassification> {
  try {
    const ai = new GoogleGenAI({ apiKey });
    const response = await generateForNode('ambiguityClassifier', ai, {
      contents: [{ role: 'user', parts: [{ text: buildPrompt(input) }] }],
      config: {
        responseMimeType: 'application/json',
        responseJsonSchema: toJSONSchema(AmbiguityClassificationSchema),
      },
    });

    const parsed = AmbiguityClassificationSchema.safeParse(JSON.parse(response.text || '{}'));
    if (!parsed.success) return fallback(input);

    return {
      type: parsed.data.type,
      question: parsed.data.question.trim() || fallback(input).question,
      domain: parsed.data.domain.trim() || 'unclassified',
      reasoning: parsed.data.reasoning.trim() || 'classifier returned no reasoning',
    };
  } catch {
    return fallback(input);
  }
}

function buildPrompt(input: AmbiguityClassifierInput): string {
  return `Classify why this low-confidence analytics question is ambiguous.

ORIGINAL QUESTION:
${input.question}

AMBIGUITIES FROM CLARIFICATION:
${formatList(input.ambiguities)}

CURRENT USER-FACING CLARIFYING QUESTIONS:
${formatList(input.clarifyingQuestions)}

THREAD CONTEXT:
${input.threadContext.map(m => `${m.role}: ${m.content}`).join('\n') || '(none)'}

Types:
- user_intent: the requester must choose scope for this specific request, such as timeframe, segment, region, product, grouping, or output grain.
- org_knowledge: the resolver is a reusable institutional fact, such as a source-of-truth table, canonical metric definition, required filter, exclusion rule, or business ownership decision.

Choose user_intent when unsure. The side bar is not enabled in this tranche, so this label is for observability only.

Return JSON:
- type: "user_intent" or "org_knowledge"
- question: one concise question for the human who can resolve it
- domain: best-effort domain tag, or "unclassified"
- reasoning: short explanation`;
}

function formatList(values: string[]): string {
  return values.length > 0 ? values.map(value => `- ${value}`).join('\n') : '(none)';
}

function fallback(input: AmbiguityClassifierInput): AmbiguityClassification {
  return {
    type: 'user_intent',
    question: input.clarifyingQuestions[0] || input.question,
    domain: 'unclassified',
    reasoning: 'fallback: ambiguity classifier unavailable or uncertain',
  };
}
