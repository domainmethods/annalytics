import { GoogleGenAI } from '@google/genai';
import type { TableContext } from '../dbt/types.js';
import type { SqlGenerationResult, ThreadMessage } from '../types.js';
import { assessQuality } from '../dbt/quality.js';
import { formatSampleRowsForPrompt } from '../dbt/sampleRowCache.js';
import { getProModel } from './modelConfig.js';
import { extractGroundingCitations } from './grounding.js';

export interface GenerateSqlOptions {
  question: string;
  tables: TableContext[];
  threadContext: ThreadMessage[];
  apiKey: string;
  model?: string;
  previousAttempt?: { sql: string; error: string; refinement?: string };
  fileSearchStoreId?: string;
  sampleRows?: Map<string, { rows: Record<string, unknown>[]; stale: boolean }>;
  negativeExample?: { sql: string; explanation: string; userFeedback: string };
  bqml_hint?: 'forecast' | 'anomaly' | 'generate' | null;
}

// JSON Schema for structured output — used by Gemini's responseJsonSchema
const sqlResponseJsonSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object' as const,
  properties: {
    sql: { type: 'string', description: 'The BigQuery SQL query' },
    explanation: { type: 'string', description: 'Plain-English explanation' },
    headline: { type: 'string', description: 'A concise one-line description of WHAT the answer value represents, e.g. "unique visitors to the website so far this month". Do NOT restate the number.' },
    tables_used: { type: 'array', items: { type: 'string' } },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    assumptions: { type: 'array', items: { type: 'string' }, description: 'Assumptions made about the question' },
    reasoning_chain: { type: 'string', description: 'Step-by-step reasoning for how the SQL was derived' },
  },
  required: ['sql', 'explanation', 'headline', 'tables_used', 'confidence', 'assumptions', 'reasoning_chain'],
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
- Provide a "headline": a short, plain-English description of what the result represents, without restating the number.

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
    prompt += `\nKNOWLEDGE CONTEXT:
Relevant teachings and reference cards are automatically retrieved via Gemini File Search.
Follow sanctioned SQL patterns from teachings when they exist.
When the user's metric, domain term, or routing trigger matches a retrieved ReferenceCard, treat that card as authoritative.
Follow reference-card constraints for canonical tables, metrics, grains, required filters, exclusions, and avoid-table guidance when they apply.\n`;
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

  if (opts.bqml_hint === 'forecast') {
    prompt += '\nBIGQUERY ML FUNCTIONS AVAILABLE:\nThe user is asking about forecasting/prediction. You may use ML.FORECAST:\n\nSELECT *\nFROM ML.FORECAST(\n  MODEL `project.dataset.model_name`,\n  STRUCT(horizon AS horizon, 0.95 AS confidence_level)\n)\n\nNotes:\n- The model must already exist (SELECT only, no CREATE MODEL)\n- Common models: ARIMA_PLUS for time series\n- Returns: forecast_timestamp, forecast_value, standard_error, confidence_level, prediction_interval_lower_bound, prediction_interval_upper_bound\n- Reference actual model names from the schema context above\n';
  } else if (opts.bqml_hint === 'anomaly') {
    prompt += '\nBIGQUERY ML FUNCTIONS AVAILABLE:\nThe user is asking about anomaly detection. You may use ML.DETECT_ANOMALIES:\n\nSELECT *\nFROM ML.DETECT_ANOMALIES(\n  MODEL `project.dataset.model_name`,\n  STRUCT(0.05 AS contamination)\n)\n\nNotes:\n- The model must already exist (SELECT only, no CREATE MODEL)\n- Returns: row data + is_anomaly (BOOL) + anomaly_probability (FLOAT64)\n- Lower contamination = fewer anomalies detected\n';
  } else if (opts.bqml_hint === 'generate') {
    prompt += '\nBIGQUERY ML FUNCTIONS AVAILABLE:\nThe user is asking about text generation. You may use ML.GENERATE_TEXT:\n\nSELECT ml_generate_text_result\nFROM ML.GENERATE_TEXT(\n  MODEL `project.dataset.llm_model`,\n  (SELECT prompt_column FROM source_table),\n  STRUCT(1024 AS max_output_tokens)\n)\n\nNotes:\n- The model must be a remote LLM connection (SELECT only, no CREATE MODEL)\n- Returns: ml_generate_text_result (STRING), ml_generate_text_status (STRING)\n';
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
  const model = opts.model || getProModel();

  let systemPrompt = buildSystemPrompt(opts);

  // Self-correction or refinement: include previous attempt context
  if (opts.previousAttempt) {
    if (opts.previousAttempt.refinement) {
      systemPrompt += `\nPREVIOUS SQL (user wants a modification):
SQL: ${opts.previousAttempt.sql}
Requested change: ${opts.previousAttempt.refinement}
Use the previous SQL as a starting point and apply the requested modification.`;
    } else {
      systemPrompt += `\nPREVIOUS ATTEMPT (failed validation):
SQL: ${opts.previousAttempt.sql}
Error: ${opts.previousAttempt.error}
Fix the error and generate a corrected query.`;
    }
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
  if (typeof parsed.headline !== 'string') throw new Error('LLM response missing or invalid "headline" field');
  if (!Array.isArray(parsed.tables_used) || !parsed.tables_used.every((t: unknown) => typeof t === 'string'))
    throw new Error('LLM response missing or invalid "tables_used" array');
  if (!Array.isArray(parsed.assumptions) || !parsed.assumptions.every((a: unknown) => typeof a === 'string'))
    throw new Error('LLM response missing or invalid "assumptions" array');
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
    headline: parsed.headline,
    tablesUsed: parsed.tables_used as string[],
    confidence,
    assumptions: parsed.assumptions as string[],
    reasoningChain: parsed.reasoning_chain,
    groundingCitations,
  };
}
