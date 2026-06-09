import type { WebClient } from '@slack/web-api';
import type { KnownBlock } from '@slack/types';
import type { TableContext } from './dbt/types.js';
import type { AppConfig } from './config.js';
import type { SqlGenerationResult, QueryResult } from './types.js';
import { classifyQuestion } from './agents/clarificationAgent.js';
import { classifyAmbiguity } from './agents/ambiguityClassifier.js';
import { qualityLoop } from './qualityLoop.js';
import { reconcileConfidence } from './agents/confidence.js';
import { classifyFollowUp } from './agents/followUpClassifier.js';
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
  overrideButtonsForResultShape,
  buildAssumptionBlocks,
} from './slack/blocks.js';
import { saveResponseContext, getLatestNegativeFeedback } from './state/responseContext.js';
import { saveClarificationState } from './state/clarificationState.js';
import { releaseThreadLock } from './state/threadLock.js';
import { getTeachingSummaries } from './teachings/summaryMap.js';
import { getSampleRows } from './dbt/sampleRowCache.js';
import { createTraceId, createLogger, logStage } from './logging.js';
import { friendlyErrorMessage } from './errors.js';
import { decideEscalation } from './agents/escalationDecision.js';
import { generateChartSpec } from './agents/chartAgent.js';
import { isChartable, renderChart } from './execution/chartRenderer.js';
import { saveEscalationState } from './state/escalationState.js';
import { buildEscalationBlocks, buildUserWaitingBlocks, buildBestEffortCaveatBlocks } from './slack/escalationBlocks.js';
import { getSchemaFallback } from './dbt/informationSchemaFallback.js';
import { handleDbtStatus } from './agents/dbtStatusAgent.js';
import { getRunHistoryForModel, getLatestRun } from './state/dbtRunHistory.js';

export interface PipelineConfig {
  geminiApiKey: string;
  geminiModel?: string;
  fileSearchStoreId?: string;
  maxBytesProcessed: number;
  queryTimeoutMs: number;
  maxResultRows: number;
  gcpProjectId?: string;
  escalation?: {
    mode: 'channel' | 'dm';
    channelId?: string;
    analystUserId?: string;
    timeoutHours: number;
    onNegativeFeedback?: boolean;
  };
}

export interface PipelineInput {
  question: string;
  channel: string;
  threadTs: string;
  statusMsgTs: string;
  client: WebClient;
  tables: TableContext[];
  config: PipelineConfig;
  refinementHint?: { previousSql: string };
}

export function toPipelineConfig(config: AppConfig): PipelineConfig {
  return {
    geminiApiKey: config.gemini.apiKey,
    geminiModel: config.gemini.model,
    fileSearchStoreId: config.gemini.fileSearchStoreId,
    maxBytesProcessed: config.limits.costGateMaxBytes,
    queryTimeoutMs: config.limits.queryTimeoutMs,
    maxResultRows: config.limits.maxResultRows,
    gcpProjectId: config.gcp.projectId,
    escalation: {
      mode: config.escalation.mode,
      channelId: config.escalation.channelId,
      analystUserId: config.escalation.analystUserId,
      timeoutHours: config.escalation.timeoutHours,
      onNegativeFeedback: config.escalation.onNegativeFeedback,
    },
  };
}

export async function runPipeline(input: PipelineInput): Promise<void> {
  const { question, channel, threadTs, statusMsgTs, client, tables, config } = input;
  const traceId = createTraceId();
  const logger = createLogger(traceId);
  const startTime = Date.now();

  const updateStatus = async (text: string) => {
    // Status updates are cosmetic. A transient Slack failure (rate limit,
    // network blip) must never abort the real query — log and move on.
    try {
      await client.chat.update({ channel, ts: statusMsgTs, text });
    } catch (err) {
      logger.warn({ err, text }, 'pipeline.status_update_failed');
    }
  };

  try {
    // Stage 1: Clarification
    await updateStatus('Interpreting your question...');
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
      const ambiguity = await classifyAmbiguity({
        question,
        ambiguities: clarification.ambiguities,
        clarifyingQuestions: clarification.clarifying_questions,
        threadContext,
      }, config.geminiApiKey);
      logger.info({
        ambiguityType: ambiguity.type,
        ambiguityDomain: ambiguity.domain,
        reasoning: ambiguity.reasoning,
      }, 'ambiguity.classified');

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
        ambiguityType: ambiguity.type,
        ambiguityDomain: ambiguity.domain,
        ambiguityQuestion: ambiguity.question,
        clarifyingMessageTs: statusMsgTs,
      });
      return;
    }

    const resolvedQuestion = clarification.resolved_question || question;
    const assumptions = clarification.assumptions;

    // dbt_status route → bypass SQL generation entirely
    if (clarification.route === 'dbt_status') {
      await updateStatus('Checking the latest data refresh...');
      const modelName = extractModelName(resolvedQuestion);
      const runHistory = modelName
        ? await getRunHistoryForModel(modelName)
        : await getLatestRun();
      const statusAnswer = await handleDbtStatus(resolvedQuestion, runHistory, config.geminiApiKey);

      await client.chat.update({
        channel,
        ts: statusMsgTs,
        text: statusAnswer,
      });

      // Persist minimal ResponseContext for observability
      await saveResponseContext({
        responseId: traceId,
        threadTs,
        statusMsgTs,
        clarifiedQuestion: resolvedQuestion,
        assumptions: assumptions || [],
        reasoningChain: 'dbt_status route — no SQL generation',
        generatedSql: '',
        explanation: statusAnswer,
        tablesUsed: [],
        confidence: 'high',
        clarificationConfidence: clarification.confidence,
        primaryAgentConfidence: 'high',
        queryResults: { rowCount: 0, columnNames: [], bytesProcessed: 0 },
        pipelineDurationMs: Date.now() - startTime,
        traceId,
        createdAt: new Date(),
        groundingCitations: [],
        teachingsUsed: [],
        supervisorVerdict: 'pass',
        supervisorNotes: 'dbt_status route — no supervisor',
      });

      logStage(logger, { traceId, stage: 'format', durationMs: Date.now() - startTime });
      return;
    }

    // Stage 1b: INFORMATION_SCHEMA fallback for non-dbt tables
    let pipelineTables: TableContext[] = [...tables];
    if (config.gcpProjectId) {
      try {
        const sqlRefs = [...resolvedQuestion.matchAll(/(?:from|join|table)\s+`?(\w+\.\w+)`?/gi)].map(m => m[1]);
        const bareRefs = [...resolvedQuestion.matchAll(/\b([a-zA-Z]\w*\.[a-zA-Z]\w*)\b/g)].map(m => m[1]);
        const FALSE_POSITIVES = new Set(['e.g', 'i.e', 'vs.net', 'node.js']);
        const refs = [...new Set([...sqlRefs, ...bareRefs])]
          .filter((ref) => !FALSE_POSITIVES.has(ref.toLowerCase()));
        const unknown = refs
          .filter((ref) => !tables.some((t) => t.name === ref || t.name.endsWith(`.${ref}`)))
          .filter((ref) => ref.includes('.'))
          .filter((ref) => ref.split('.').every((seg) => !/^\d+$/.test(seg)));
        const fallbacks = await Promise.all(unknown.map(async (ref) => {
          const [dataset, table] = ref.split('.');
          const result = await getSchemaFallback(config.gcpProjectId!, dataset, table);
          if (!result) return null;
          return { ...result, description: `${result.description} \u26a0\ufe0f minimal documentation \u2014 no dbt metadata`.trim() };
        }));
        for (const fb of fallbacks) { if (fb) pipelineTables.push(fb); }
      } catch {
        pipelineTables = [...tables]; // Non-critical — continue with original tables
      }
    }

    // Stage 2: Load sample rows (parallel fetch)
    const sampleRowsMap = new Map<string, { rows: Record<string, unknown>[]; stale: boolean }>();
    const sampleResults = await Promise.all(
      tables.map(async (table) => {
        const cached = await getSampleRows(table.name);
        return cached ? { name: table.name, data: cached } : null;
      }),
    );
    for (const r of sampleResults) {
      if (r) sampleRowsMap.set(r.name, r.data);
    }
    logStage(logger, { traceId, stage: 'retrieve', durationMs: Date.now() - startTime });

    // Stage 3: Unified Quality Loop (generate + validate + supervise)
    const negativeExample = await getLatestNegativeFeedback(threadTs);

    const qualityResult = await qualityLoop(
      {
        question: resolvedQuestion,
        tables: pipelineTables,
        threadContext,
        apiKey: config.geminiApiKey,
        fileSearchStoreId: config.fileSearchStoreId,
        sampleRows: sampleRowsMap.size > 0 ? sampleRowsMap : undefined,
        negativeExample: negativeExample ? {
          sql: negativeExample.sql,
          explanation: negativeExample.explanation,
          userFeedback: threadContext[threadContext.length - 1]?.content || '',
        } : undefined,
        previousAttempt: input.refinementHint
          ? { sql: input.refinementHint.previousSql, error: '', refinement: resolvedQuestion }
          : undefined,
        bqml_hint: clarification.bqml_hint,
      },
      config.geminiApiKey,
      resolvedQuestion,
      config.maxBytesProcessed,
      {
        onGenerate: () => updateStatus('Researching the best approach...'),
        onValidate: () => updateStatus('Verifying the approach...'),
        onReview: () => updateStatus('Reviewing for accuracy...'),
        onRetry: () => updateStatus('Refining the approach...'),
      },
    );
    logStage(logger, { traceId, stage: 'generate', durationMs: Date.now() - startTime, confidence: qualityResult.sqlResult.confidence });
    logStage(logger, { traceId, stage: 'validate', durationMs: Date.now() - startTime, bytesProcessed: qualityResult.bytesProcessed });

    // Stage 3b: Cost gate exceeded — non-retryable policy boundary
    if (qualityResult.verdict === 'cost_exceeded') {
      const gb = (qualityResult.bytesProcessed ?? 0) / (1024 * 1024 * 1024);
      const limitGb = config.maxBytesProcessed / (1024 * 1024 * 1024);
      await updateStatus(
        `This query would scan ${gb.toFixed(1)} GB (limit: ${limitGb.toFixed(1)} GB). Try narrowing with a date range or specific filter. (trace: ${traceId})`,
      );
      return;
    }

    // Stage 3c: Escalation decision
    const escalationDecision = decideEscalation(
      qualityResult.verdict,
      qualityResult.sqlResult.confidence,
      qualityResult.failureHistory,
    );
    const escalationTarget = resolveEscalationTarget(config.escalation);

    if (escalationDecision.shouldEscalate) {
      logger.info({ trigger: escalationDecision.trigger, behavior: escalationDecision.behavior, dominantFailureType: escalationDecision.dominantFailureType, traceId }, 'escalation.triggered');
    }

    // Build failure diagnostics for escalation messages
    const failureDiagnostics = qualityResult.failureHistory.length > 0
      ? qualityResult.failureHistory.map(f => `Attempt ${f.attempt + 1}: [${f.failureType}] ${f.detail}`).join('\n')
      : '';

    if (escalationDecision.shouldEscalate && escalationDecision.behavior === 'park_wait' && escalationTarget) {
      const waitingBlocks = buildUserWaitingBlocks();
      await client.chat.update({
        channel,
        ts: statusMsgTs,
        text: "I've asked the data team — I'll reply here when I have the answer.",
        blocks: waitingBlocks as unknown as KnownBlock[],
      });

      const stuckDescription = failureDiagnostics || qualityResult.supervisorNotes || 'Could not generate a confident answer';
      const escalationMsg = await client.chat.postMessage({
        channel: escalationTarget,
        text: `Anna Lytics needs help with: "${question}"`,
        blocks: buildEscalationBlocks({
          userQuestion: question,
          channelName: `<#${channel}>`,
          threadLink: `slack://channel?id=${channel}&message=${threadTs}`,
          stuckDescription,
          bestGuessSql: qualityResult.sqlResult.sql,
        }) as unknown as KnownBlock[],
      });

      await saveEscalationState({
        escalationId: `esc_${traceId}`,
        originalThreadTs: threadTs,
        originalChannel: channel,
        trigger: escalationDecision.trigger,
        behavior: 'park_wait',
        stageToResume: 'sql_generation',
        context: {
          clarifiedQuestion: resolvedQuestion,
          userQuestion: question,
          groundingCitations: qualityResult.sqlResult.groundingCitations,
          previousSql: qualityResult.sqlResult.sql,
          supervisorNotes: qualityResult.supervisorNotes,
        },
        escalationChannel: escalationTarget,
        escalationTs: escalationMsg.ts!,
        statusMsgTs,
        bestEffortSql: qualityResult.sqlResult.sql,
        traceId,
      }, config.escalation?.timeoutHours ?? 4);

      return;
    }

    const shouldEscalateAsync = escalationDecision.shouldEscalate
      && escalationDecision.behavior === 'best_effort_verify'
      && !!escalationTarget;

    // Exhausted but not escalatable — abort
    if (qualityResult.verdict === 'exhausted' && !shouldEscalateAsync) {
      await updateStatus(
        `I wasn't able to generate a valid query for that question. (trace: ${traceId})`,
      );
      return;
    }

    // Stage 5: Execution
    await updateStatus('Retrieving the data...');
    const queryResult = await executeQuery(qualityResult.sqlResult.sql, {
      maxRows: config.maxResultRows,
      timeoutMs: config.queryTimeoutMs,
      maxBytes: config.maxBytesProcessed,
    });
    logStage(logger, { traceId, stage: 'execute', durationMs: Date.now() - startTime, bytesProcessed: queryResult.bytesProcessed });

    // Stage 6: Format + Respond
    const confidence = reconcileConfidence(
      qualityResult.sqlResult.confidence,
      qualityResult.finalConfidence,
    );

    const format = chooseFormat(queryResult);
    const blocks = buildResponseBlocks(format, qualityResult.sqlResult, queryResult, traceId, threadTs, statusMsgTs, assumptions);

    // Best-effort caveat for escalated responses
    if (shouldEscalateAsync) {
      blocks.unshift(...buildBestEffortCaveatBlocks(qualityResult.supervisorNotes));
    }

    await client.chat.update({
      channel,
      ts: statusMsgTs,
      text: qualityResult.sqlResult.explanation,
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
      reasoningChain: qualityResult.sqlResult.reasoningChain,
      generatedSql: qualityResult.sqlResult.sql,
      explanation: qualityResult.sqlResult.explanation,
      tablesUsed: qualityResult.sqlResult.tablesUsed,
      confidence,
      clarificationConfidence: clarification.confidence,
      primaryAgentConfidence: qualityResult.sqlResult.confidence,
      supervisorConfidence: qualityResult.finalConfidence,
      queryResults: {
        rowCount: queryResult.totalRows,
        columnNames: queryResult.columnNames,
        bytesProcessed: queryResult.bytesProcessed,
      },
      pipelineDurationMs: Date.now() - startTime,
      traceId,
      createdAt: new Date(),
      groundingCitations: qualityResult.sqlResult.groundingCitations,
      teachingsUsed: qualityResult.sqlResult.groundingCitations.map(c => c.sourceFile),
      supervisorVerdict: qualityResult.verdict as 'pass' | 'fail_then_pass' | 'exhausted',
      supervisorNotes: qualityResult.supervisorNotes,
      failureHistory: qualityResult.failureHistory,
      retrievedSchema: pipelineTables.map(table => ({
        name: table.name,
        description: table.description,
        columns: table.columns.map(c => ({
          name: c.name,
          description: c.description,
          dataType: c.dataType,
        })),
      })),
    });

    // Stage 7b: Chart generation (fire-and-forget — failures silently skipped)
    if (isChartable(queryResult)) {
      try {
        const chartSpec = await generateChartSpec({
          question: resolvedQuestion,
          columnNames: queryResult.columnNames,
          sampleRows: queryResult.rows.slice(0, 20),
          apiKey: config.geminiApiKey,
        });

        if (chartSpec) {
          const pngBuffer = await renderChart(
            chartSpec.vegaLiteSpec,
            queryResult.rows,
          );

          if (pngBuffer) {
            await client.filesUploadV2({
              channel_id: channel,
              thread_ts: threadTs,
              filename: 'chart.png',
              file: pngBuffer,
              title: chartSpec.chartTitle,
            });
          }
        }
      } catch (error) {
        console.debug('[Pipeline] Chart generation failed (non-blocking):', error);
      }
    }

    // Async escalation for best_effort_verify
    if (shouldEscalateAsync && escalationTarget) {
      const escalationMsg = await client.chat.postMessage({
        channel: escalationTarget,
        text: `Anna Lytics needs verification: "${question}"`,
        blocks: buildEscalationBlocks({
          userQuestion: question,
          channelName: `<#${channel}>`,
          threadLink: `slack://channel?id=${channel}&message=${threadTs}`,
          stuckDescription: qualityResult.supervisorNotes || 'Answer needs verification',
          bestGuessSql: qualityResult.sqlResult.sql,
        }) as unknown as KnownBlock[],
      });

      await saveEscalationState({
        escalationId: `esc_${traceId}`,
        originalThreadTs: threadTs,
        originalChannel: channel,
        trigger: escalationDecision.trigger,
        behavior: 'best_effort_verify',
        stageToResume: 'supervisor_review',
        context: {
          clarifiedQuestion: resolvedQuestion,
          userQuestion: question,
          groundingCitations: qualityResult.sqlResult.groundingCitations,
          previousSql: qualityResult.sqlResult.sql,
          supervisorNotes: qualityResult.supervisorNotes,
        },
        escalationChannel: escalationTarget,
        escalationTs: escalationMsg.ts!,
        statusMsgTs,
        bestEffortSql: qualityResult.sqlResult.sql,
        traceId,
      }, config.escalation?.timeoutHours ?? 4);
    }
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

function extractModelName(question: string): string | null {
  // dbt naming convention prefixes (most specific first)
  const prefixPatterns = [
    /\b(dim_\w+)\b/i,
    /\b(fct_\w+)\b/i,
    /\b(stg_\w+)\b/i,
    /\b(int_\w+)\b/i,
    /\b(rpt_\w+)\b/i,
    /\b(snap_\w+)\b/i,
    /\b(mart_\w+)\b/i,
  ];
  for (const pattern of prefixPatterns) {
    const match = question.match(pattern);
    if (match) return match[1].toLowerCase();
  }

  // Keyword-adjacent model names (e.g., "model users", "table revenue")
  const keywordPatterns = [
    /\bmodel\s+(\w+)\b/i,
    /\btable\s+(\w+)\b/i,
    /\b(?:was|is|did)\s+(\w+)\s+(?:built|run|refreshed|updated|succeed|fail)/i,
    /\b(?:status|history|build|run)\s+(?:of|for)\s+(\w+)\b/i,
  ];
  const stopwords = new Set(['the', 'last', 'latest', 'most', 'recent', 'dbt', 'my', 'our', 'any', 'all', 'a']);
  for (const pattern of keywordPatterns) {
    const match = question.match(pattern);
    if (match && !stopwords.has(match[1].toLowerCase())) return match[1].toLowerCase();
  }

  // No match → caller falls back to getLatestRun() for all-models overview
  return null;
}

export function resolveEscalationTarget(
  escalation?: PipelineConfig['escalation'],
): string | null {
  if (!escalation) return null;
  if (escalation.mode === 'dm' && escalation.analystUserId) return escalation.analystUserId;
  if (escalation.channelId) return escalation.channelId;
  return null;
}

export function buildResponseBlocks(
  format: string,
  gen: SqlGenerationResult,
  result: QueryResult,
  traceId: string,
  threadTs: string,
  statusMsgTs: string,
  assumptions?: string[],
): KnownBlock[] {
  const assumptionBlocks = buildAssumptionBlocks(assumptions ?? [], traceId);

  const MAX_DISPLAY_ROWS = 20;

  // Which override buttons this result shape warrants — single source of truth
  // shared with the toggle-restore handlers in app.ts. The raw SQL is no longer
  // rendered inline in any branch; it is revealed on demand via the "Show SQL"
  // toggle that buildFeedbackActions always includes.
  const overrides = overrideButtonsForResultShape(result.totalRows, result.columnNames.length);

  switch (format) {
    case 'single_value': {
      const value = String(Object.values(result.rows[0])[0]);
      return [
        ...buildSingleValueBlocks(value, gen.headline),
        ...assumptionBlocks,
        buildFeedbackActions(traceId, threadTs, statusMsgTs, overrides),
      ];
    }
    case 'table':
    case 'wide_table':
    case 'summary': {
      const displayRows = result.rows.slice(0, MAX_DISPLAY_ROWS);
      const isTruncatedDisplay = result.rows.length > MAX_DISPLAY_ROWS || result.truncated;
      return [
        ...buildTableBlocks(displayRows, result.columnNames),
        ...(isTruncatedDisplay ? buildTruncatedBlocks(displayRows.length, result.totalRows) : []),
        ...assumptionBlocks,
        buildFeedbackActions(traceId, threadTs, statusMsgTs, overrides),
      ];
    }
    case 'zero_rows':
      // No rows came back, so Table/Summary/CSV have nothing to render, explain,
      // or export (overrideButtonsForResultShape suppresses all three). Feedback
      // and the detail toggles stay — Reasoning/Show SQL answer "why no results?"
      return [
        ...buildZeroRowBlocks(gen.assumptions),
        ...assumptionBlocks,
        buildFeedbackActions(traceId, threadTs, statusMsgTs, overrides),
      ];
    default:
      return [
        { type: 'section', text: { type: 'mrkdwn', text: gen.explanation } } as KnownBlock,
        ...assumptionBlocks,
        buildFeedbackActions(traceId, threadTs, statusMsgTs, overrides),
      ];
  }
}
