import { GoogleGenAI } from '@google/genai';
import type { DbtRunHistoryEntry } from '../state/dbtRunHistory.js';
import { generateForNode } from './modelGateway.js';

const EMPTY_HISTORY_MESSAGE =
  "I don't have any build history for that model. Make sure dbt run results are being sent to Anna Lytics.";

export async function handleDbtStatus(
  question: string,
  runHistory: DbtRunHistoryEntry[],
  apiKey: string,
): Promise<string> {
  if (runHistory.length === 0) {
    return EMPTY_HISTORY_MESSAGE;
  }

  const ai = new GoogleGenAI({ apiKey });

  const systemInstruction =
    'You are a dbt operations assistant. Given the build history data, provide a clear, conversational answer to the user\'s question about dbt model build status. Include model names, statuses, timestamps, and execution times where relevant. Treat warn as a completed check that crossed a warning threshold; do not describe it as skipped or successful. Treat no-op as no operation needed and reused as a reused result; neither is a failure. Keep answers concise.';

  const response = await generateForNode('dbtStatus', ai, {
    contents: question + '\n\nBuild history:\n' + JSON.stringify(runHistory, null, 2),
    config: { systemInstruction },
  });

  const text = response.text;
  if (!text) throw new Error('Empty response from Gemini');

  return text;
}
