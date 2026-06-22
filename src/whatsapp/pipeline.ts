import type { ChannelClient, ChannelMessage } from '../channels/types.js';
import type { TableContext } from '../dbt/types.js';
import type { PipelineConfig } from '../pipeline.js';
import type { ResponseContext, ThreadMessage } from '../types.js';
import { classifyQuestion } from '../agents/clarificationAgent.js';
import { reconcileConfidence } from '../agents/confidence.js';
import { executeQuery } from '../execution/runner.js';
import { createLogger, createTraceId, logStage, rootLogger } from '../logging.js';
import { qualityLoop, type QualityResult } from '../qualityLoop.js';
import { saveClarificationState } from '../state/clarificationState.js';
import { getLatestNegativeFeedback } from '../state/responseContext.js';
import { getSampleRows } from '../dbt/sampleRowCache.js';
import { getTeachingSummaries } from '../teachings/summaryMap.js';
import {
  renderWhatsAppClarification,
  renderWhatsAppQueryAnswer,
  renderWhatsAppSafeError,
} from './renderer.js';
import { whatsappClarificationId } from './keys.js';

const ACK_TEXT = 'Got it. I am checking that now.';

export type WhatsAppPipelineOutcome =
  | {
    kind: 'answer';
    explanation: string;
    rows: Array<Record<string, unknown>>;
    columnNames: string[];
    totalRows: number;
    assumptions: string[];
    traceId: string;
    responseContext: ResponseContext;
  }
  | {
    kind: 'clarification';
    questions: string[];
    ambiguities?: string[];
    traceId: string;
  };

export interface AnswerWhatsAppQuestionInput {
  question: string;
  conversationId: string;
  providerMessageId: string;
  tables?: TableContext[];
  config?: PipelineConfig;
}

export interface RunWhatsAppPipelineInput {
  message: ChannelMessage;
  client: ChannelClient;
  answerQuestion: (input: AnswerWhatsAppQuestionInput) => Promise<WhatsAppPipelineOutcome>;
  saveResponseContext: (ctx: ResponseContext) => Promise<void>;
  markVisible?: () => Promise<void>;
  tables?: TableContext[];
  config?: PipelineConfig;
}

export type RunWhatsAppPipelineResult = {
  visible: boolean;
  outcome: 'answer' | 'clarification' | 'safe_error';
};

export async function runWhatsAppPipeline(
  input: RunWhatsAppPipelineInput,
): Promise<RunWhatsAppPipelineResult> {
  const traceId = createTraceId();
  const logger = createLogger(traceId);
  const { message, client } = input;
  const conversationId = message.conversation.conversationId;
  let terminalMessageWasVisible = false;
  let visibleMarked = false;

  const markTerminalVisible = async () => {
    if (input.markVisible && !visibleMarked) {
      visibleMarked = true;
      try {
        await input.markVisible();
      } catch (err) {
        logger.error({ err }, 'whatsapp.event_mark_visible_failed');
      }
    }
  };

  const sendTerminalText = async (text: string) => {
    const sent = await client.sendText(message.conversation, text);
    terminalMessageWasVisible = true;
    await markTerminalVisible();
    return sent;
  };

  try {
    await client.sendText(message.conversation, ACK_TEXT);

    const outcome = await input.answerQuestion({
      question: message.text,
      conversationId,
      providerMessageId: message.providerMessageId,
      ...(input.tables ? { tables: input.tables } : {}),
      ...(input.config ? { config: input.config } : {}),
    });

    if (outcome.kind === 'clarification') {
      const rendered = renderWhatsAppClarification(outcome.questions, outcome.traceId);
      const sent = await sendTerminalText(rendered);

      await saveClarificationState({
        clarificationId: whatsappClarificationId(message.conversation.userId),
        threadTs: conversationId,
        channel: conversationId,
        originalQuestion: message.text,
        ambiguities: outcome.ambiguities ?? [],
        clarifyingMessageTs: sent.messageId,
      });
      return { visible: true, outcome: 'clarification' };
    }

    const rendered = renderWhatsAppQueryAnswer({
      explanation: outcome.explanation,
      rows: outcome.rows,
      columnNames: outcome.columnNames,
      totalRows: outcome.totalRows,
      assumptions: outcome.assumptions,
      traceId: outcome.traceId,
    });
    const sent = await sendTerminalText(rendered);

    try {
      await input.saveResponseContext({
        ...outcome.responseContext,
        threadTs: conversationId,
        statusMsgTs: sent.messageId,
        surface: 'whatsapp',
      });
    } catch (err) {
      logger.error({ err }, 'whatsapp.response_context_save_failed');
    }
    return { visible: true, outcome: 'answer' };
  } catch (err) {
    logger.error({ err }, 'whatsapp.pipeline_failed');
    try {
      await sendTerminalText(renderWhatsAppSafeError(traceId));
      return { visible: true, outcome: 'safe_error' };
    } catch (sendErr) {
      logger.error({ err: sendErr }, 'whatsapp.safe_error_send_failed');
      if (!terminalMessageWasVisible) throw sendErr;
      return { visible: true, outcome: 'safe_error' };
    }
  }
}

export async function answerWhatsAppQuestion(
  input: AnswerWhatsAppQuestionInput,
): Promise<WhatsAppPipelineOutcome> {
  const { config, tables } = input;
  if (!config || !tables) {
    throw new Error('WhatsApp answerer requires pipeline config and tables');
  }
  const pipelineInput: AnswerWhatsAppQuestionInput & {
    tables: TableContext[];
    config: PipelineConfig;
  } = { ...input, config, tables };

  const traceId = createTraceId();
  const logger = createLogger(traceId);
  const startTime = Date.now();
  const threadContext: ThreadMessage[] = [];

  let teachingSummaries: Awaited<ReturnType<typeof getTeachingSummaries>> = [];
  try {
    teachingSummaries = await getTeachingSummaries();
  } catch (err) {
    logger.warn({ err }, 'whatsapp.teaching_summaries_failed');
  }

  const clarification = await classifyQuestion(
    input.question,
    threadContext,
    teachingSummaries,
    config.geminiApiKey,
  );
  logStage(logger, {
    traceId,
    stage: 'clarify',
    durationMs: Date.now() - startTime,
    confidence: clarification.confidence,
  });

  if (clarification.confidence === 'low') {
    return {
      kind: 'clarification',
      questions: clarification.clarifying_questions,
      ambiguities: clarification.ambiguities,
      traceId,
    };
  }

  const resolvedQuestion = clarification.resolved_question || input.question;
  if (clarification.route !== 'data_query') {
    const explanation = 'I can only answer warehouse data questions in this WhatsApp prototype.';
    return answerOutcome({
      input: pipelineInput,
      traceId,
      startTime,
      resolvedQuestion,
      assumptions: clarification.assumptions,
      qualityResult: {
        sqlResult: {
          sql: '',
          explanation,
          headline: 'unsupported WhatsApp route',
          tablesUsed: [],
          confidence: 'low',
          assumptions: [],
          reasoningChain: clarification.reasoning,
          groundingCitations: [],
        },
        verdict: 'exhausted',
        supervisorNotes: `Unsupported route: ${clarification.route}`,
        finalConfidence: 'low',
        retryCount: 0,
        failureHistory: [],
        bytesProcessed: 0,
      },
      explanation,
      rows: [],
      columnNames: [],
      totalRows: 0,
      bytesProcessed: 0,
      supervisorVerdict: 'exhausted',
      confidence: 'low',
      clarificationConfidence: clarification.confidence,
    });
  }

  const sampleRows = await loadSampleRows(tables, traceId);
  const negativeFeedback = await loadNegativeFeedback(input.conversationId, logger);

  const qualityResult = await qualityLoop(
    {
      question: resolvedQuestion,
      tables,
      threadContext,
      apiKey: config.geminiApiKey,
      fileSearchStoreId: config.fileSearchStoreId,
      sampleRows: sampleRows.size > 0 ? sampleRows : undefined,
      negativeExample: negativeFeedback
        ? {
            sql: negativeFeedback.sql,
            explanation: negativeFeedback.explanation,
            userFeedback: input.question,
          }
        : undefined,
      bqml_hint: clarification.bqml_hint,
    },
    config.geminiApiKey,
    resolvedQuestion,
    config.maxBytesProcessed,
  );
  logStage(logger, {
    traceId,
    stage: 'generate',
    durationMs: Date.now() - startTime,
    confidence: qualityResult.sqlResult.confidence,
  });

  const assumptions = mergeAssumptions(
    clarification.assumptions,
    qualityResult.sqlResult.assumptions,
  );

  if (qualityResult.verdict === 'exhausted') {
    const explanation = "I wasn't able to generate a valid query for that question.";
    return answerOutcome({
      input: pipelineInput,
      traceId,
      startTime,
      resolvedQuestion,
      assumptions,
      qualityResult,
      explanation,
      rows: [],
      columnNames: [],
      totalRows: 0,
      bytesProcessed: qualityResult.bytesProcessed ?? 0,
      supervisorVerdict: 'exhausted',
      confidence: 'low',
      clarificationConfidence: clarification.confidence,
    });
  }

  if (qualityResult.verdict === 'cost_exceeded') {
    const bytesProcessed = qualityResult.bytesProcessed ?? 0;
    const scanGb = bytesProcessed / (1024 * 1024 * 1024);
    const limitGb = config.maxBytesProcessed / (1024 * 1024 * 1024);
    const explanation = `This query would scan ${scanGb.toFixed(1)} GB (limit: ${limitGb.toFixed(1)} GB). Try narrowing with a date range or specific filter.`;
    return answerOutcome({
      input: pipelineInput,
      traceId,
      startTime,
      resolvedQuestion,
      assumptions,
      qualityResult,
      explanation,
      rows: [],
      columnNames: [],
      totalRows: 0,
      bytesProcessed,
      supervisorVerdict: 'exhausted',
      confidence: 'low',
      clarificationConfidence: clarification.confidence,
    });
  }

  const result = await executeQuery(qualityResult.sqlResult.sql, {
    maxRows: config.maxResultRows,
    timeoutMs: config.queryTimeoutMs,
    maxBytes: config.maxBytesProcessed,
  });
  logStage(logger, {
    traceId,
    stage: 'execute',
    durationMs: Date.now() - startTime,
    bytesProcessed: result.bytesProcessed,
  });

  const confidence = reconcileConfidence(
    qualityResult.sqlResult.confidence,
    qualityResult.finalConfidence,
  );

  return answerOutcome({
    input: pipelineInput,
    traceId,
    startTime,
    resolvedQuestion,
    assumptions,
    qualityResult,
    explanation: qualityResult.sqlResult.explanation,
    rows: result.rows,
    columnNames: result.columnNames,
    totalRows: result.totalRows,
    bytesProcessed: result.bytesProcessed,
    supervisorVerdict: qualityResult.verdict,
    confidence,
    clarificationConfidence: clarification.confidence,
  });
}

async function loadSampleRows(
  tables: TableContext[],
  traceId: string,
): Promise<Map<string, { rows: Record<string, unknown>[]; stale: boolean }>> {
  const sampleRows = new Map<string, { rows: Record<string, unknown>[]; stale: boolean }>();

  for (const table of tables) {
    try {
      const rows = await getSampleRows(table.name);
      if (rows) sampleRows.set(table.name, rows);
    } catch (err) {
      rootLogger.warn({ err, traceId, table: table.name }, 'whatsapp.sample_rows_failed');
    }
  }

  return sampleRows;
}

async function loadNegativeFeedback(
  conversationId: string,
  logger: ReturnType<typeof createLogger>,
): Promise<{ sql: string; explanation: string; tablesUsed: string[] } | null> {
  try {
    return await getLatestNegativeFeedback(conversationId);
  } catch (err) {
    logger.warn({ err }, 'whatsapp.negative_feedback_failed');
    return null;
  }
}

function mergeAssumptions(...groups: string[][]): string[] {
  return [...new Set(groups.flat().filter(Boolean))];
}

function answerOutcome(input: {
  input: AnswerWhatsAppQuestionInput & { tables: TableContext[]; config: PipelineConfig };
  traceId: string;
  startTime: number;
  resolvedQuestion: string;
  assumptions: string[];
  qualityResult: QualityResult;
  explanation: string;
  rows: Array<Record<string, unknown>>;
  columnNames: string[];
  totalRows: number;
  bytesProcessed: number;
  supervisorVerdict: 'pass' | 'fail_then_pass' | 'exhausted';
  confidence: 'high' | 'medium' | 'low';
  clarificationConfidence: 'high' | 'medium' | 'low';
}): WhatsAppPipelineOutcome {
  return {
    kind: 'answer',
    explanation: input.explanation,
    rows: input.rows,
    columnNames: input.columnNames,
    totalRows: input.totalRows,
    assumptions: input.assumptions,
    traceId: input.traceId,
    responseContext: {
      responseId: input.traceId,
      threadTs: input.input.conversationId,
      statusMsgTs: input.input.providerMessageId,
      surface: 'whatsapp',
      clarifiedQuestion: input.resolvedQuestion,
      assumptions: input.assumptions,
      reasoningChain: input.qualityResult.sqlResult.reasoningChain,
      generatedSql: input.qualityResult.sqlResult.sql,
      explanation: input.explanation,
      tablesUsed: input.qualityResult.sqlResult.tablesUsed,
      confidence: input.confidence,
      clarificationConfidence: input.clarificationConfidence,
      primaryAgentConfidence: input.qualityResult.sqlResult.confidence,
      supervisorConfidence: input.qualityResult.finalConfidence,
      queryResults: {
        rowCount: input.totalRows,
        columnNames: input.columnNames,
        bytesProcessed: input.bytesProcessed,
      },
      pipelineDurationMs: Date.now() - input.startTime,
      traceId: input.traceId,
      createdAt: new Date(),
      groundingCitations: input.qualityResult.sqlResult.groundingCitations,
      teachingsUsed: input.qualityResult.sqlResult.groundingCitations.map(c => c.sourceFile),
      supervisorVerdict: input.supervisorVerdict,
      supervisorNotes: input.qualityResult.supervisorNotes,
      failureHistory: input.qualityResult.failureHistory,
      retrievedSchema: input.input.tables.map(table => ({
        name: table.name,
        description: table.description,
        columns: table.columns.map(column => ({
          name: column.name,
          description: column.description,
          dataType: column.dataType,
        })),
      })),
    },
  };
}
