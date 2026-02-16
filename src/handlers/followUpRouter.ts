import type { WebClient } from '@slack/web-api';
import type { TableContext } from '../dbt/types.js';
import type { PipelineConfig } from '../pipeline.js';
import type { FollowUpIntent } from '../agents/followUpClassifier.js';
import { getLatestResponseContext } from '../state/responseContext.js';
import { handleMetaQuestion } from '../agents/metaQuestionHandler.js';
import { buildRefinementInput } from '../agents/refinementHandler.js';
import { generateDiagnosticSql } from '../agents/discrepancyHandler.js';
import { runPipeline } from '../pipeline.js';
import { validateSql } from '../validation/pipeline.js';
import { executeQuery } from '../execution/runner.js';
import { reviewSql } from '../agents/supervisorAgent.js';
import { friendlyErrorMessage } from '../errors.js';
import { createTraceId } from '../logging.js';

export async function routeFollowUp(
  intent: FollowUpIntent,
  message: string,
  threadTs: string,
  channel: string,
  statusMsgTs: string,
  client: WebClient,
  config: PipelineConfig,
  tables: TableContext[],
): Promise<void> {
  const traceId = createTraceId();

  switch (intent) {
    case 'meta_question': {
      const ctx = await getLatestResponseContext(threadTs);
      if (!ctx) {
        await client.chat.update({ channel, ts: statusMsgTs, text: 'No previous query to explain.' });
        return;
      }
      const answer = await handleMetaQuestion(message, ctx, config.geminiApiKey);
      await client.chat.update({ channel, ts: statusMsgTs, text: answer });
      break;
    }

    case 'refinement': {
      const ctx = await getLatestResponseContext(threadTs);
      if (!ctx) {
        await client.chat.update({ channel, ts: statusMsgTs, text: 'No previous query to refine.' });
        return;
      }
      const { compositeQuestion, previousSql } = buildRefinementInput(message, ctx);
      await runPipeline({
        question: compositeQuestion,
        channel,
        threadTs,
        statusMsgTs,
        client,
        tables,
        config,
        refinementHint: { previousSql },
      });
      break;
    }

    case 'discrepancy': {
      const ctx = await getLatestResponseContext(threadTs);
      if (!ctx) {
        await client.chat.update({ channel, ts: statusMsgTs, text: 'No previous query to investigate.' });
        return;
      }
      try {
        await client.chat.update({ channel, ts: statusMsgTs, text: 'Investigating...' });
        const diagnostic = await generateDiagnosticSql(message, ctx, config.geminiApiKey);

        const validation = await validateSql(diagnostic.diagnosticSql, config.maxBytesProcessed);
        if (!validation.valid) {
          await client.chat.update({
            channel,
            ts: statusMsgTs,
            text: `Could not validate diagnostic query. (trace: ${traceId})`,
          });
          return;
        }

        // Lightweight supervisor review (single call)
        const review = await reviewSql({
          userQuestion: message,
          clarifiedQuestion: `Diagnostic investigation: ${diagnostic.explanation}`,
          generatedSql: diagnostic.diagnosticSql,
          explanation: diagnostic.explanation,
          reasoningChain: `Investigating discrepancy in: ${ctx.generatedSql}`,
          groundingCitations: [],
          apiKey: config.geminiApiKey,
        });
        if (review.verdict === 'FAIL') {
          await client.chat.update({
            channel,
            ts: statusMsgTs,
            text: `Diagnostic query did not pass review: ${review.issues.join('; ')} (trace: ${traceId})`,
          });
          return;
        }

        const result = await executeQuery(diagnostic.diagnosticSql, {
          maxRows: config.maxResultRows,
          timeoutMs: config.queryTimeoutMs,
          maxBytes: config.maxBytesProcessed,
        });

        const rowSummary = result.rows.slice(0, 10)
          .map(row => Object.entries(row).map(([k, v]) => `${k}: ${String(v)}`).join(', '))
          .join('\n');

        await client.chat.update({
          channel,
          ts: statusMsgTs,
          text: `*Investigation:* ${diagnostic.explanation}\n\n\`\`\`${diagnostic.diagnosticSql}\`\`\`\n\n*Findings (${result.totalRows} rows):*\n${rowSummary}`,
        });
      } catch (error) {
        await client.chat.update({
          channel,
          ts: statusMsgTs,
          text: friendlyErrorMessage(error as Error, traceId),
        });
      }
      break;
    }

    case 'new_query':
    default:
      await runPipeline({
        question: message,
        channel,
        threadTs,
        statusMsgTs,
        client,
        tables,
        config,
      });
  }
}
