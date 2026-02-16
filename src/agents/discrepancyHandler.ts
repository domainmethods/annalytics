import { GoogleGenAI } from '@google/genai';
import { z } from 'zod';
import { toJSONSchema } from 'zod/v4/core';
import type { ResponseContext } from '../types.js';

const DiagnosticSchema = z.object({
  diagnosticSql: z.string(),
  explanation: z.string(),
});

export async function generateDiagnosticSql(
  discrepancyText: string,
  ctx: ResponseContext,
  apiKey: string,
): Promise<{ diagnosticSql: string; explanation: string }> {
  const ai = new GoogleGenAI({ apiKey });

  const prompt = `You are investigating a data discrepancy reported by a business user.

ORIGINAL QUESTION: ${ctx.clarifiedQuestion}
ORIGINAL SQL: ${ctx.generatedSql}
ORIGINAL RESULTS: ${ctx.queryResults.rowCount} rows, columns: ${ctx.queryResults.columnNames.join(', ')}

USER'S CONCERN: ${discrepancyText}

Generate a diagnostic SQL query to investigate. Consider:
- Break down the original query by the dimension in question
- Check for filter effects (how many rows excluded)
- Look for data gaps (NULL values, missing dates)
- Generate only SELECT statements`;

  const response = await ai.models.generateContent({
    model: 'gemini-3.0-pro',
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    config: {
      responseMimeType: 'application/json',
      responseJsonSchema: toJSONSchema(DiagnosticSchema),
    },
  });

  const text = response.text;
  if (!text) throw new Error('Empty response from Gemini');

  return JSON.parse(text) as { diagnosticSql: string; explanation: string };
}
