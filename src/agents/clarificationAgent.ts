import { GoogleGenAI } from '@google/genai';
import { z } from 'zod';
import { toJSONSchema } from 'zod/v4/core';
import type { ClarificationResult } from './types.js';
import type { TeachingSummary } from '../teachings/types.js';
import type { ThreadMessage } from '../types.js';

const ClarificationSchema = z.object({
  route: z.enum(['data_query', 'dbt_status']),
  confidence: z.enum(['high', 'medium', 'low']),
  reasoning: z.string(),
  ambiguities: z.array(z.string()),
  assumptions: z.array(z.string()),
  clarifying_questions: z.array(z.string()),
  resolved_question: z.string(),
  bqml_hint: z.enum(['forecast', 'anomaly', 'generate']).nullable().optional(),
});

export async function classifyQuestion(
  question: string,
  threadContext: ThreadMessage[],
  teachingSummaries: TeachingSummary[],
  apiKey: string,
): Promise<ClarificationResult> {
  const ai = new GoogleGenAI({ apiKey });

  const systemPrompt = buildClarificationPrompt(teachingSummaries);
  const contents = buildContents(question, threadContext);

  const response = await ai.models.generateContent({
    model: 'gemini-3.0-flash',
    contents,
    config: {
      systemInstruction: systemPrompt,
      responseMimeType: 'application/json',
      responseJsonSchema: toJSONSchema(ClarificationSchema),
    },
  });

  return JSON.parse(response.text!) as ClarificationResult;
}

function buildClarificationPrompt(summaries: TeachingSummary[]): string {
  const summaryLines = summaries.map(
    s => `- ${s.term}: ${s.definition} (table: ${s.canonical_table})`,
  );

  return `You are a data analyst intake specialist. Evaluate whether the following question has enough specificity to generate an accurate SQL query against our data warehouse.

AVAILABLE CONTEXT (canonical business definitions):
${summaryLines.join('\n')}

Classify and respond with the confidence level:
- HIGH: Question is specific enough to generate accurate SQL immediately
- MEDIUM: Question can be answered but requires stating assumptions
- LOW: Question is too vague — ask 1-2 targeted clarifying questions

When the question matches a known business term exactly, prefer HIGH confidence.
When the topic is established in thread context, avoid redundant clarification.
If the user says "just guess" or "best guess is fine", always classify as HIGH.`;
}

function buildContents(
  question: string,
  threadContext: ThreadMessage[],
): Array<{ role: string; parts: Array<{ text: string }> }> {
  const contents: Array<{ role: string; parts: Array<{ text: string }> }> = [];
  for (const msg of threadContext) {
    contents.push({
      role: msg.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: msg.content }],
    });
  }
  contents.push({ role: 'user', parts: [{ text: question }] });
  return contents;
}
