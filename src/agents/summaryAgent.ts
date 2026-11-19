import { GoogleGenAI } from '@google/genai';
import { generateForNode } from './modelGateway.js';

export async function summarizeResults(input: {
  question: string;
  sql: string;
  rows: Record<string, unknown>[];
  totalRows: number;
  apiKey: string;
}): Promise<string> {
  try {
    const ai = new GoogleGenAI({ apiKey: input.apiKey });
    const sampleRows = input.rows.slice(0, 50);
    const response = await generateForNode('summaryOverride', ai, {
      contents: [{
        role: 'user',
        parts: [{
          text: `Summarize these query results in 2-3 sentences for a business user.\n\nQuestion: ${input.question}\nSQL: ${input.sql}\n\nResults (${input.totalRows} total rows, showing first ${sampleRows.length}):\n${JSON.stringify(sampleRows, null, 2)}`,
        }],
      }],
    });
    return response.text || '';
  } catch {
    return '';
  }
}
