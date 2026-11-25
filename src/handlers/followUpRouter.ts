import type { WebClient } from '@slack/web-api';
import type { TableContext } from '../dbt/types.js';
import type { PipelineConfig } from '../pipeline.js';
import type { FollowUpIntent } from '../agents/followUpClassifier.js';
import { getLatestResponseContext, getSlackResponseContext } from '../state/responseContext.js';
import { handleMetaQuestion } from '../agents/metaQuestionHandler.js';
import { buildRefinementInput } from '../agents/refinementHandler.js';
import { generateDiagnosticSql } from '../agents/discrepancyHandler.js';
import { runPipeline } from '../pipeline.js';
import { validateSql } from '../validation/pipeline.js';
import { executeQuery } from '../execution/runner.js';
import { reviewSql } from '../agents/supervisorAgent.js';
import { friendlyErrorMessage } from '../errors.js';
import { createLogger, createTraceId } from '../logging.js';
import { formatValue } from '../slack/blocks.js';
import { createStatusReporter } from '../slack/statusReporter.js';

export async function routeFollowUp(
  intent: FollowUpIntent,
  message: string,
  threadTs: string,
  channel: string,
  statusMsgTs: string,
  client: WebClient,
  config: PipelineConfig,
  tables: TableContext[],
  options: { refinementTargetKey?: string } = {},
): Promise<void> {
  const traceId = createTraceId();

  switch (intent) {
    case 'meta_question': {
      const ctx = await getLatestResponseContext(channel, threadTs);
      if (!ctx) {
        await client.chat.update({ channel, ts: statusMsgTs, text: 'No previous query to explain.' });
        return;
      }
      const answer = await handleMetaQuestion(message, ctx, config.geminiApiKey);
      await client.chat.update({ channel, ts: statusMsgTs, text: answer });
      break;
    }

    case 'refinement': {
      // A refine prompt names the answer to change (#51); without one, refine
      // the newest answer in the thread.
      const targetKey = options.refinementTargetKey;
      const ctx = targetKey
        ? await getSlackResponseContext(channel, targetKey)
        : await getLatestResponseContext(channel, threadTs);
      if (!ctx) {
        await client.chat.update({
          channel,
          ts: statusMsgTs,
          text: targetKey
            ? "I can't find the answer you asked to refine anymore. Ask the question again and I'll start fresh."
            : 'No previous query to refine.',
        });
        return;
      }
      const { compositeQuestion, originalQuestion, previousSql } = buildRefinementInput(message, ctx);
      await runPipeline({
        question: compositeQuestion,
        originalQuestion,
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
      const ctx = await getLatestResponseContext(channel, threadTs);
      if (!ctx) {
        await client.chat.update({ channel, ts: statusMsgTs, text: 'No previous query to investigate.' });
        return;
      }
      // Status updates are cosmetic: a Slack failure on one must not stop the
      // investigation.
      const logger = createLogger(traceId);
      const status = createStatusReporter({
        write: (text) => client.chat.update({ channel, ts: statusMsgTs, text }),
        onError: (err, text) => logger.warn({ err, text }, 'followup.status_update_failed'),
      });
      try {
        // The steps run inside the heartbeat and hand back the final text, which
        // is written once it has ended so it never carries the elapsed time.
        const outcome = await status.withHeartbeat(async () => {
          await status.set('Investigating the discrepancy...');
          const diagnostic = await generateDiagnosticSql(message, ctx, config.geminiApiKey);

          await status.set('Verifying the approach...');
          const validation = await validateSql(diagnostic.diagnosticSql, config.maxBytesProcessed);
          if (!validation.valid) {
            return `Could not validate diagnostic query. (trace: ${traceId})`;
          }

          // Lightweight supervisor review (single call)
          await status.set('Reviewing for accuracy...');
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
            return `Diagnostic query did not pass review: ${review.issues.join('; ')} (trace: ${traceId})`;
          }

          await status.set('Retrieving the data...');
          const result = await executeQuery(diagnostic.diagnosticSql, {
            maxRows: config.maxResultRows,
            timeoutMs: config.queryTimeoutMs,
            maxBytes: config.maxBytesProcessed,
          });

          const rowSummary = result.rows.slice(0, 10)
            .map(row => Object.entries(row).map(([k, v]) => `${k}: ${formatValue(v)}`).join(', '))
            .join('\n');

          return `*Investigation:* ${diagnostic.explanation}\n\n\`\`\`${diagnostic.diagnosticSql}\`\`\`\n\n*Findings (${result.totalRows} rows):*\n${rowSummary}`;
        });
        await client.chat.update({ channel, ts: statusMsgTs, text: outcome });
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
