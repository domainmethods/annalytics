import { GoogleGenAI } from '@google/genai';
import { generateForNode } from '../agents/modelGateway.js';
import { executeQuery } from '../execution/runner.js';
import type { OverrideConfig } from '../execution/overrideTypes.js';
import type { ResponseContext } from '../types.js';
import { validateSql } from '../validation/pipeline.js';
import { renderWhatsAppQueryAnswer } from './renderer.js';

async function reExecute(ctx: ResponseContext, config: OverrideConfig) {
  const validation = await validateSql(ctx.generatedSql, config.maxBytesProcessed);
  if (!validation.valid) {
    throw Object.assign(
      new Error(validation.error || 'Validation failed'),
      { traceId: ctx.traceId },
    );
  }

  return executeQuery(ctx.generatedSql, {
    maxRows: config.maxResultRows,
    timeoutMs: config.queryTimeoutMs,
    maxBytes: config.maxBytesProcessed,
  });
}

export async function renderWhatsAppTableOverride(
  ctx: ResponseContext,
  config: OverrideConfig,
): Promise<string> {
  const result = await reExecute(ctx, config);
  return renderWhatsAppQueryAnswer({
    explanation: ctx.explanation,
    rows: result.rows,
    columnNames: result.columnNames,
    totalRows: result.totalRows,
    assumptions: ctx.assumptions,
    traceId: ctx.traceId,
  });
}

export async function renderWhatsAppSummaryOverride(
  ctx: ResponseContext,
  config: OverrideConfig,
): Promise<string> {
  const result = await reExecute(ctx, config);

  let summary = '';
  try {
    const ai = new GoogleGenAI({ apiKey: config.geminiApiKey });
    const sampleRows = result.rows.slice(0, 50);
    const response = await generateForNode('summaryOverride', ai, {
      contents: [{
        role: 'user',
        parts: [{
          text: `Summarize these query results in 2-3 sentences for a business user.\n\nQuestion: ${ctx.clarifiedQuestion}\nSQL: ${ctx.generatedSql}\n\nResults (${result.totalRows} total rows, showing first ${sampleRows.length}):\n${JSON.stringify(sampleRows, null, 2)}`,
        }],
      }],
    });
    summary = response.text || '';
  } catch {
    summary = '';
  }

  if (!summary.trim()) {
    return renderWhatsAppQueryAnswer({
      explanation: "I couldn't generate a summary. Here's the raw data:",
      rows: result.rows,
      columnNames: result.columnNames,
      totalRows: result.totalRows,
      assumptions: ctx.assumptions,
      traceId: ctx.traceId,
    });
  }

  return renderWhatsAppQueryAnswer({
    explanation: summary.trim(),
    rows: [],
    columnNames: result.columnNames,
    totalRows: 0,
    assumptions: ctx.assumptions,
    traceId: ctx.traceId,
    includeRows: false,
  });
}
