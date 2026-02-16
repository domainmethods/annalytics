import { GoogleGenAI } from '@google/genai';
import type { TableContext } from '../dbt/types.js';
import type { SqlGenerationResult, ThreadMessage } from '../types.js';
import type { GroundingCitation } from './types.js';
import { assessQuality } from '../dbt/quality.js';
import { formatSampleRowsForPrompt } from '../dbt/sampleRowCache.js';

export interface GenerateSqlOptions {
  question: string;
  tables: TableContext[];
  threadContext: ThreadMessage[];
  apiKey: string;
  model?: string;
  previousAttempt?: { sql: string; error: string };
  fileSearchStoreId?: string;
  sampleRows?: Map<string, { rows: Record<string, unknown>[]; stale: boolean }>;
  negativeExample?: { sql: string; explanation: string; userFeedback: string };
}

// JSON Schema for structured output — used by Gemini's responseJsonSchema
const sqlResponseJsonSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object' as const,
  properties: {
    sql: { type: 'string', description: 'The BigQuery SQL query' },
    explanation: { type: 'string', description: 'Plain-English explanation' },
    tables_used: { type: 'array', items: { type: 'string' } },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    assumptions: { type: 'array', items: { type: 'string' }, description: 'Assumptions made about the question' },
    reasoning_chain: { type: 'string', description: 'Step-by-step reasoning for how the SQL was derived' },
  },
  required: ['sql', 'explanation', 'tables_used', 'confidence', 'assumptions', 'reasoning_chain'],
};

function buildSystemPrompt(opts: GenerateSqlOptions): string {
  const schemaSections = opts.tables.map((t) => {
    const quality = assessQuality(t);
    const qualityNote =
      quality.qualityTier === 'low'
        ? `\n⚠️ Minimal documentation — ${Math.round(quality.columnDescriptionCoverage * 100)}% columns described`
        : '';

    return `-- ${t.name}: ${t.description}${qualityNote}\n${t.sampleDDL}`;
  });

  let prompt = `You are a BigQuery SQL expert. Generate a single BigQuery SQL query to answer the user's question.

RULES:
- Use only the tables and columns described below
- Use BigQuery SQL dialect (backtick-quoted identifiers, DATE functions, etc.)
- Generate only SELECT statements
- Never generate DML (INSERT, UPDATE, DELETE) or DDL (CREATE, DROP, ALTER)
- If the question cannot be answered with the available schema, set confidence to "low" and explain why

SCHEMA:
${schemaSections.join('\n\n')}
`;

  // Add sample rows if provided
  if (opts.sampleRows) {
    const sampleSections: string[] = [];
    for (const [tableName, data] of opts.sampleRows) {
      const formatted = formatSampleRowsForPrompt(tableName, data.rows, data.stale);
      if (formatted) sampleSections.push(formatted);
    }
    if (sampleSections.length > 0) {
      prompt += `\nSAMPLE DATA:\n${sampleSections.join('\n\n')}\n`;
    }
  }

  // Add File Search context hint
  if (opts.fileSearchStoreId) {
    prompt += `\nTEACHINGS:
(Relevant teachings are automatically retrieved via Gemini File Search.
Follow sanctioned SQL patterns when they exist for the question type.)\n`;
  }

  // Add negative example if provided
  if (opts.negativeExample) {
    const ne = opts.negativeExample;
    prompt += `\nPREVIOUS ATTEMPT (rejected by user):
SQL: ${ne.sql}
Explanation: ${ne.explanation}
User feedback: "${ne.userFeedback}"
Do NOT repeat this approach. Adjust based on the user's correction.\n`;
  }

  return prompt;
}

function buildContents(
  question: string,
  threadContext: ThreadMessage[],
): Array<{ role: string; parts: Array<{ text: string }> }> {
  const messages: Array<{ role: string; parts: Array<{ text: string }> }> = [];

  // Include thread context as conversation history
  for (const msg of threadContext) {
    messages.push({
      role: msg.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: msg.content }],
    });
  }

  // Current question
  messages.push({
    role: 'user',
    parts: [{ text: question }],
  });

  return messages;
}

export async function generateSql(opts: GenerateSqlOptions): Promise<SqlGenerationResult> {
  const ai = new GoogleGenAI({ apiKey: opts.apiKey });
  const model = opts.model || 'gemini-3.0-pro';

  let systemPrompt = buildSystemPrompt(opts);

  // Self-correction: include previous failed attempt
  if (opts.previousAttempt) {
    systemPrompt += `\nPREVIOUS ATTEMPT (failed validation):
SQL: ${opts.previousAttempt.sql}
Error: ${opts.previousAttempt.error}
Fix the error and generate a corrected query.`;
  }

  const tools = opts.fileSearchStoreId
    ? [{ fileSearch: { fileSearchStoreNames: [opts.fileSearchStoreId] } }]
    : undefined;

  let response;
  let fileSearchDegraded = false;
  try {
    response = await ai.models.generateContent({
      model,
      contents: buildContents(opts.question, opts.threadContext),
      config: {
        systemInstruction: systemPrompt,
        responseMimeType: 'application/json',
        responseJsonSchema: sqlResponseJsonSchema,
        tools,
      },
    });
  } catch {
    // Graceful degradation: retry without File Search tools
    if (tools) {
      fileSearchDegraded = true;
      response = await ai.models.generateContent({
        model,
        contents: buildContents(opts.question, opts.threadContext),
        config: {
          systemInstruction: systemPrompt,
          responseMimeType: 'application/json',
          responseJsonSchema: sqlResponseJsonSchema,
        },
      });
    } else {
      throw new Error('Gemini API call failed');
    }
  }

  const text = response.text;
  if (!text) throw new Error('Empty response from Gemini');

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`Failed to parse Gemini response as JSON: ${text.slice(0, 200)}`);
  }

  // Runtime validation — LLM output is untrusted
  if (typeof parsed.sql !== 'string') throw new Error('LLM response missing or invalid "sql" field');
  if (typeof parsed.explanation !== 'string') throw new Error('LLM response missing or invalid "explanation" field');
  if (!Array.isArray(parsed.tables_used)) throw new Error('LLM response missing "tables_used" array');
  if (!Array.isArray(parsed.assumptions)) throw new Error('LLM response missing "assumptions" array');
  if (typeof parsed.reasoning_chain !== 'string') throw new Error('LLM response missing or invalid "reasoning_chain" field');

  const rawConfidence = parsed.confidence;
  if (rawConfidence !== 'high' && rawConfidence !== 'medium' && rawConfidence !== 'low') {
    throw new Error(`LLM response has invalid confidence: ${String(rawConfidence)}`);
  }

  // Cap confidence to 'medium' when File Search was unavailable
  let confidence: 'high' | 'medium' | 'low' = rawConfidence;
  if (fileSearchDegraded && confidence === 'high') {
    confidence = 'medium';
  }

  const groundingCitations = extractGroundingCitations(response);

  return {
    sql: parsed.sql,
    explanation: parsed.explanation,
    tablesUsed: parsed.tables_used as string[],
    confidence,
    assumptions: parsed.assumptions as string[],
    reasoningChain: parsed.reasoning_chain,
    groundingCitations,
  };
}

function extractGroundingCitations(response: any): GroundingCitation[] {
  try {
    const chunks = response?.candidates?.[0]?.groundingMetadata?.groundingChunks;
    if (!Array.isArray(chunks)) return [];
    return chunks
      .filter((c: any) => c.retrievedContext)
      .map((c: any) => ({
        sourceFile: c.retrievedContext.uri ?? '',
        chunkText: c.retrievedContext.text ?? '',
        relevanceScore: c.retrievedContext?.score ?? 1.0,
      }));
  } catch {
    return [];
  }
}
