import { GoogleGenAI } from '@google/genai';
import { z } from 'zod';
import { toJSONSchema } from 'zod/v4/core';
import type { TeachingCandidate } from '../state/teachingCandidates.js';

export interface EscalationTeachingContext {
  escalationId: string;
  originalQuestion: string;
  clarifiedQuestion: string;
  humanResponse: string;
  failedSql?: string;
  supervisorNotes?: string;
  apiKey: string;
}

const candidateSchema = z.object({
  questionPatterns: z.array(z.string()),
  reasoning: z.string(),
  sanctionedSql: z.string().nullable(),
  modelsReferenced: z.array(z.string()),
  tags: z.array(z.string()),
});

const SYSTEM_INSTRUCTION =
  'You are extracting a reusable teaching from a resolved escalation. ' +
  'Question patterns should capture the general class of question (not just this specific one). ' +
  'Reasoning should explain the approach to answering this type of question. ' +
  'Sanctioned SQL must come from the human response or corrected approach, not from failed SQL. ' +
  'Models referenced are the BigQuery tables used. ' +
  'Tags are topic labels for categorization.';

function buildUserContent(context: EscalationTeachingContext): string {
  const parts: string[] = [
    `Original Question: ${context.originalQuestion}`,
    `Clarified Question: ${context.clarifiedQuestion}`,
    `Human Response: ${context.humanResponse}`,
  ];

  if (context.failedSql !== undefined) {
    parts.push(`Failed SQL (do not treat as sanctioned): ${context.failedSql}`);
  }

  if (context.supervisorNotes !== undefined) {
    parts.push(`Supervisor Notes: ${context.supervisorNotes}`);
  }

  return parts.join('\n\n');
}

export async function generateTeachingCandidate(
  context: EscalationTeachingContext,
): Promise<TeachingCandidate> {
  const ai = new GoogleGenAI({ apiKey: context.apiKey });

  const contents = [
    { role: 'user' as const, parts: [{ text: buildUserContent(context) }] },
  ];

  const response = await ai.models.generateContent({
    model: 'gemini-3.0-flash',
    contents,
    config: {
      systemInstruction: SYSTEM_INSTRUCTION,
      responseMimeType: 'application/json',
      responseJsonSchema: toJSONSchema(candidateSchema),
    },
  });

  const rawText = response.text;
  if (!rawText) {
    throw new Error('Gemini returned empty response for teaching candidate extraction');
  }
  const parsed = candidateSchema.parse(JSON.parse(rawText));

  return {
    candidateId: 'teach_' + context.escalationId,
    escalationId: context.escalationId,
    status: 'pending' as const,
    generatedAt: new Date(),
    originalQuestion: context.originalQuestion,
    humanResponse: context.humanResponse,
    ...parsed,
  };
}
