import type { WebClient } from '@slack/web-api';
import type { KnownBlock } from '@slack/types';
import type { TableContext } from './dbt/types.js';
import type { SqlGenerationResult, QueryResult } from './types.js';
import { classifyQuestion } from './agents/clarificationAgent.js';
import { generateWithSupervision } from './agents/supervisorLoop.js';
import { generateSql } from './agents/sqlGenerator.js';
import { reconcileConfidence } from './agents/confidence.js';
import { classifyFollowUp } from './agents/followUpClassifier.js';
import { validateSql } from './validation/pipeline.js';
import { executeQuery } from './execution/runner.js';
import { chooseFormat } from './execution/formatter.js';
import { buildThreadContext } from './slack/threadContext.js';
import { buildClarificationBlocks } from './slack/clarificationBlocks.js';
import {
  buildSingleValueBlocks,
  buildTableBlocks,
  buildZeroRowBlocks,
  buildTruncatedBlocks,
  buildFeedbackActions,
} from './slack/blocks.js';
import { saveResponseContext, getLatestNegativeFeedback } from './state/responseContext.js';
import { saveClarificationState } from './state/clarificationState.js';
import { releaseThreadLock } from './state/threadLock.js';
import { getTeachingSummaries } from './teachings/summaryMap.js';
import { getSampleRows } from './dbt/sampleRowCache.js';
import { createTraceId, createLogger, logStage } from './logging.js';
import { friendlyErrorMessage } from './errors.js';

export interface PipelineConfig {
  geminiApiKey: string;
  geminiModel?: string;
  fileSearchStoreId?: string;
  maxBytesProcessed: number;
  queryTimeoutMs: number;
  maxResultRows: number;
}

export interface PipelineInput {
  question: string;
  channel: string;
  threadTs: string;
  statusMsgTs: string;
  client: WebClient;
  tables: TableContext[];
  config: PipelineConfig;
}

export async function runPipeline(input: PipelineInput): Promise<void> {
  const { question, channel, threadTs, statusMsgTs, client, tables, config } = input;
  const traceId = createTraceId();
  const logger = createLogger(traceId);
  const startTime = Date.now();

  const updateStatus = async (text: string) => {
    await client.chat.update({ channel, ts: statusMsgTs, text });
  };

  try {
    // Stage 1: Clarification
    await updateStatus('Understanding your question...');
    let teachingSummaries: Awaited<ReturnType<typeof getTeachingSummaries>> = [];
    try {
      teachingSummaries = await getTeachingSummaries();
    } catch {
      // Continue with empty/stale cache if Firestore is unavailable
    }
    const threadMessages = await client.conversations.replies({
      channel,
      ts: threadTs,
      oldest: threadTs,
    });
    const threadContext = buildThreadContext(threadMessages.messages || [], 4, {
      summarizeOlder: true,
      stripQueryResults: true,
      maxTokens: 1000,
    });

    // Follow-up intent classification for thread messages (logged for observability)
    if (threadContext.length > 0) {
      try {
        const followUp = await classifyFollowUp(question, threadContext, config.geminiApiKey);
        logger.info({ intent: followUp.intent, reasoning: followUp.reasoning }, 'followup.classified');
      } catch {
        // Non-critical — continue pipeline if classification fails
      }
    }

    const clarification = await classifyQuestion(
      question, threadContext, teachingSummaries, config.geminiApiKey,
    );
    logStage(logger, { traceId, stage: 'clarify', durationMs: Date.now() - startTime });

    // LOW → suspend pipeline
    if (clarification.confidence === 'low') {
      const blocks = buildClarificationBlocks({
        clarificationId: `clarify_${threadTs}`,
        clarifyingQuestions: clarification.clarifying_questions,
        originalQuestion: question,
      });
      await client.chat.update({
        channel,
        ts: statusMsgTs,
        text: clarification.clarifying_questions.join('\n'),
        blocks: blocks as unknown as KnownBlock[],
      });
      await saveClarificationState({
        clarificationId: `clarify_${threadTs}`,
        threadTs,
        channel,
        originalQuestion: question,
        ambiguities: clarification.ambiguities,
        clarifyingMessageTs: statusMsgTs,
      });
      return;
    }

    const resolvedQuestion = clarification.resolved_question || question;
    const assumptions = clarification.assumptions;

    // Stage 2: Load sample rows
    const sampleRowsMap = new Map<string, { rows: Record<string, unknown>[]; stale: boolean }>();
    for (const table of tables) {
      const cached = await getSampleRows(table.name);
      if (cached) {
        sampleRowsMap.set(table.name, cached);
      }
    }
    logStage(logger, { traceId, stage: 'retrieve', durationMs: Date.now() - startTime });

    // Stage 3: SQL Generation + Supervisor Loop
    await updateStatus('Generating SQL...');
    const negativeExample = await getLatestNegativeFeedback(threadTs);

    const supervisedResult = await generateWithSupervision(
      {
        question: resolvedQuestion,
        tables,
        threadContext,
        apiKey: config.geminiApiKey,
        model: config.geminiModel,
        fileSearchStoreId: config.fileSearchStoreId,
        sampleRows: sampleRowsMap.size > 0 ? sampleRowsMap : undefined,
        negativeExample: negativeExample ? {
          sql: negativeExample.sql,
          explanation: negativeExample.explanation,
          userFeedback: threadContext[threadContext.length - 1]?.content || '',
        } : undefined,
      },
      config.geminiApiKey,
      resolvedQuestion,
    );
    logStage(logger, { traceId, stage: 'generate', durationMs: Date.now() - startTime, confidence: supervisedResult.sqlResult.confidence });

    // Stage 3b: Supervisor review status
    await updateStatus('Reviewing answer...');
    logStage(logger, { traceId, stage: 'supervise', durationMs: Date.now() - startTime });

    // Stage 4: Validation (L1-L4) with self-correction retry
    let sqlToExecute = supervisedResult.sqlResult.sql;
    let validation = await validateSql(sqlToExecute, config.maxBytesProcessed);
    logStage(logger, { traceId, stage: 'validate', durationMs: Date.now() - startTime, bytesProcessed: validation.bytesProcessed, error: validation.error });

    if (!validation.valid) {
      // Self-correction: retry once with validation error in prompt
      await updateStatus('Correcting query...');
      const correctedResult = await generateSql({
        question: resolvedQuestion,
        tables,
        threadContext,
        apiKey: config.geminiApiKey,
        model: config.geminiModel,
        fileSearchStoreId: config.fileSearchStoreId,
        previousAttempt: { sql: sqlToExecute, error: validation.error || 'Validation failed' },
      });
      sqlToExecute = correctedResult.sql;
      supervisedResult.sqlResult = correctedResult;

      validation = await validateSql(sqlToExecute, config.maxBytesProcessed);
      logStage(logger, { traceId, stage: 'validate', durationMs: Date.now() - startTime, bytesProcessed: validation.bytesProcessed, error: validation.error });
    }

    if (!validation.valid) {
      await updateStatus(
        `I wasn't able to generate a valid query for that question. (trace: ${traceId})`,
      );
      return;
    }

    // Stage 5: Execution
    await updateStatus('Running query...');
    const queryResult = await executeQuery(sqlToExecute, {
      maxRows: config.maxResultRows,
      timeoutMs: config.queryTimeoutMs,
      maxBytes: config.maxBytesProcessed,
    });
    logStage(logger, { traceId, stage: 'execute', durationMs: Date.now() - startTime, bytesProcessed: queryResult.bytesProcessed });

    // Stage 6: Format + Respond
    const confidence = reconcileConfidence(
      supervisedResult.sqlResult.confidence,
      supervisedResult.finalConfidence,
    );

    const format = chooseFormat(queryResult);
    const blocks = buildResponseBlocks(format, supervisedResult.sqlResult, queryResult, traceId, assumptions);

    // Exhaustion caveat: prepend warning when supervisor could not approve
    if (supervisedResult.verdict === 'exhausted') {
      blocks.unshift({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `_I'm not fully confident in this answer. [Supervisor note: ${supervisedResult.supervisorNotes}]_`,
        },
      } as KnownBlock);
    }

    await client.chat.update({
      channel,
      ts: statusMsgTs,
      text: supervisedResult.sqlResult.explanation,
      blocks,
    });
    logStage(logger, { traceId, stage: 'format', durationMs: Date.now() - startTime });

    // Stage 7: Persist ResponseContext
    await saveResponseContext({
      responseId: traceId,
      threadTs,
      statusMsgTs,
      clarifiedQuestion: resolvedQuestion,
      assumptions,
      reasoningChain: supervisedResult.sqlResult.reasoningChain,
      generatedSql: supervisedResult.sqlResult.sql,
      explanation: supervisedResult.sqlResult.explanation,
      tablesUsed: supervisedResult.sqlResult.tablesUsed,
      confidence,
      clarificationConfidence: clarification.confidence,
      primaryAgentConfidence: supervisedResult.sqlResult.confidence,
      supervisorConfidence: supervisedResult.finalConfidence,
      queryResults: {
        rowCount: queryResult.totalRows,
        columnNames: queryResult.columnNames,
        bytesProcessed: queryResult.bytesProcessed,
      },
      pipelineDurationMs: Date.now() - startTime,
      traceId,
      createdAt: new Date(),
      groundingCitations: supervisedResult.sqlResult.groundingCitations,
      teachingsUsed: supervisedResult.sqlResult.groundingCitations.map(c => c.sourceFile),
      supervisorVerdict: supervisedResult.verdict,
      supervisorNotes: supervisedResult.supervisorNotes,
    });
  } catch (error) {
    logger.error({ error }, 'Pipeline failed');
    await client.chat.update({
      channel,
      ts: statusMsgTs,
      text: friendlyErrorMessage(error as Error, traceId),
    });
  } finally {
    await releaseThreadLock(threadTs).catch(() => {});
  }
}

function buildResponseBlocks(
  format: string,
  gen: SqlGenerationResult,
  result: QueryResult,
  traceId: string,
  assumptions?: string[],
): KnownBlock[] {
  const assumptionBlocks: KnownBlock[] = [];
  if (assumptions && assumptions.length > 0) {
    assumptionBlocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*Assumptions:* ${assumptions.join(', ')}` },
    } as KnownBlock);
    assumptionBlocks.push({
      type: 'actions',
      elements: [{
        type: 'button',
        text: { type: 'plain_text', text: 'Wrong assumptions? Click to refine' },
        action_id: 'refine_assumptions',
        value: traceId,
      }],
    } as KnownBlock);
  }

  const MAX_DISPLAY_ROWS = 20;

  switch (format) {
    case 'single_value': {
      const value = String(Object.values(result.rows[0])[0]);
      return [...assumptionBlocks, ...buildSingleValueBlocks(value, gen.explanation, gen.sql, traceId)];
    }
    case 'table':
    case 'wide_table':
    case 'summary': {
      const displayRows = result.rows.slice(0, MAX_DISPLAY_ROWS);
      const isTruncatedDisplay = result.rows.length > MAX_DISPLAY_ROWS || result.truncated;
      return [
        ...assumptionBlocks,
        ...buildTableBlocks(displayRows, result.columnNames),
        ...(isTruncatedDisplay ? buildTruncatedBlocks(displayRows.length, result.totalRows) : []),
        { type: 'section', text: { type: 'mrkdwn', text: `\`\`\`${gen.sql}\`\`\`` } } as KnownBlock,
        buildFeedbackActions(traceId),
      ];
    }
    case 'zero_rows':
      return [
        ...assumptionBlocks,
        ...buildZeroRowBlocks(gen.assumptions, gen.sql),
        buildFeedbackActions(traceId),
      ];
    default:
      return [
        ...assumptionBlocks,
        { type: 'section', text: { type: 'mrkdwn', text: gen.explanation } } as KnownBlock,
        { type: 'section', text: { type: 'mrkdwn', text: `\`\`\`${gen.sql}\`\`\`` } } as KnownBlock,
        buildFeedbackActions(traceId),
      ];
  }
}
