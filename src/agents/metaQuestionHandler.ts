import { GoogleGenAI } from '@google/genai';
import type { ResponseContext } from '../types.js';
import { getFlashModel } from './modelConfig.js';

export async function handleMetaQuestion(
  followUpQuestion: string,
  ctx: ResponseContext,
  apiKey: string,
): Promise<string> {
  const ai = new GoogleGenAI({ apiKey });

  const citations = ctx.groundingCitations.length > 0
    ? ctx.groundingCitations.map(c => `- ${c.sourceFile}: "${c.chunkText}"`).join('\n')
    : 'None';

  const schema = ctx.retrievedSchema && ctx.retrievedSchema.length > 0
    ? ctx.retrievedSchema.map(t =>
      `${t.name}: ${t.description}\n  Columns: ${t.columns.map(c => `${c.name} (${c.dataType}) — ${c.description}`).join(', ')}`,
    ).join('\n')
    : 'Not available';

  const prompt = `You are a data analyst assistant. A user asked a question about your previous answer's reasoning process. Answer their follow-up question by explaining WHY you made the choices you did.

PREVIOUS QUESTION: ${ctx.clarifiedQuestion}

GENERATED SQL:
${ctx.generatedSql}

ASSUMPTIONS: ${ctx.assumptions.length > 0 ? ctx.assumptions.join('; ') : 'None'}

REASONING CHAIN: ${ctx.reasoningChain || 'Not recorded'}

SUPERVISOR NOTES: ${ctx.supervisorNotes || 'None'}

TEACHINGS REFERENCED:
${citations}

AVAILABLE SCHEMA:
${schema}

In your response:
- Explain WHY these specific tables were chosen and WHY others were not
- Reference the dbt model descriptions when explaining table choices
- Reference the teachings that informed your decisions
- Be concise and direct

USER'S FOLLOW-UP QUESTION: ${followUpQuestion}`;

  const response = await ai.models.generateContent({
    model: getFlashModel(),
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
  });

  const text = response.text;
  if (!text) throw new Error('Empty response from Gemini');

  return text;
}
