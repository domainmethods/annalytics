import type { WebClient } from '@slack/web-api';
import type { KnownBlock, ActionsBlock } from '@slack/types';
import { GoogleGenAI } from '@google/genai';
import { getResponseContext } from '../state/responseContext.js';
import { validateSql } from '../validation/pipeline.js';
import { executeQuery } from '../execution/runner.js';
import type { OverrideConfig } from '../execution/overrideTypes.js';
import type { ResponseContext } from '../types.js';
import { buildTableBlocks, buildTruncatedBlocks, buildFeedbackActions, overrideButtonsForResultShape, formatValue, buildAssumptionBlocks } from '../slack/blocks.js';
import { generateForNode } from '../agents/modelGateway.js';
import { rootLogger } from '../logging.js';

export class ResponseContextNotFoundError extends Error {
  constructor() {
    super('Response context not found');
    this.name = 'ResponseContextNotFoundError';
  }
}
export { formatValue };

function extractTraceId(err: unknown): string {
  if (err instanceof Error && 'traceId' in err) {
    return (err as Error & { traceId: string }).traceId;
  }
  return 'unknown';
}

async function loadContext(compoundKey: string): Promise<ResponseContext> {
  const ctx = await getResponseContext(compoundKey);
  if (!ctx) throw new ResponseContextNotFoundError();
  return ctx;
}

const CONTEXT_UNAVAILABLE_TEXT = 'Response context is unavailable. Please ask the question again.';

export interface OverrideViewer {
  userId: string;
  /** Thread root of the answer message, so the notice lands in its thread. */
  threadTs?: string;
}

/**
 * Tell only the clicking user that the answer's context is gone. The delivered
 * answer is left untouched: a missing context must never overwrite it.
 */
export async function notifyContextUnavailable(
  client: WebClient,
  channel: string,
  viewer: OverrideViewer | undefined,
): Promise<void> {
  if (!viewer) return;
  await client.chat.postEphemeral({
    channel,
    user: viewer.userId,
    ...(viewer.threadTs ? { thread_ts: viewer.threadTs } : {}),
    text: CONTEXT_UNAVAILABLE_TEXT,
  })
    .catch(error => rootLogger.warn({ error: (error as Error).message }, 'override.context_unavailable_notice_failed'));
}

async function reExecuteSql(ctx: ResponseContext, config: OverrideConfig) {
  const validation = await validateSql(ctx.generatedSql, config.maxBytesProcessed);
  if (!validation.valid) {
    throw Object.assign(
      new Error(validation.error || 'Validation failed'),
      { traceId: ctx.traceId },
    );
  }

  const result = await executeQuery(ctx.generatedSql, {
    maxRows: config.maxResultRows,
    timeoutMs: config.queryTimeoutMs,
    maxBytes: config.maxBytesProcessed,
  });

  return { ctx, result };
}

export async function handleTableOverride(
  compoundKey: string,
  channel: string,
  messageTs: string,
  client: WebClient,
  config: OverrideConfig,
  viewer?: OverrideViewer,
): Promise<void> {
  try {
    const ctx = await loadContext(compoundKey);
    const { result } = await reExecuteSql(ctx, config);

    const MAX_DISPLAY_ROWS = 20;
    const displayRows = result.rows.slice(0, MAX_DISPLAY_ROWS);
    const isTruncated = result.rows.length > MAX_DISPLAY_ROWS || result.truncated;
    // SQL stays behind the "Show SQL" toggle here too — keep the re-rendered
    // message consistent with the original answer's layout.
    const overrides = overrideButtonsForResultShape(result.totalRows, result.columnNames.length);
    const blocks: KnownBlock[] = [
      ...buildAssumptionBlocks(ctx.assumptions, ctx.traceId),
      ...buildTableBlocks(displayRows, result.columnNames),
      ...(isTruncated ? buildTruncatedBlocks(displayRows.length, result.totalRows) : []),
      buildFeedbackActions(ctx.traceId, ctx.threadTs, ctx.statusMsgTs, overrides),
    ];

    await client.chat.update({ channel, ts: messageTs, text: ctx.explanation, blocks });
  } catch (err) {
    rootLogger.error(
      { error: (err as Error).message, traceId: extractTraceId(err) },
      'override.table.failed',
    );
    if (err instanceof ResponseContextNotFoundError) {
      await notifyContextUnavailable(client, channel, viewer);
      return;
    }
    await client.chat.update({
      channel,
      ts: messageTs,
      text: `Something went wrong re-running the query. (trace: ${extractTraceId(err)})`,
    });
  }
}

export async function handleSummaryOverride(
  compoundKey: string,
  channel: string,
  messageTs: string,
  client: WebClient,
  config: OverrideConfig,
  viewer?: OverrideViewer,
): Promise<void> {
  try {
    // Load context before replacing the answer with a progress message.
    const ctx = await loadContext(compoundKey);
    await client.chat.update({ channel, ts: messageTs, text: 'Generating summary...' });

    const { result } = await reExecuteSql(ctx, config);

    let summary: string;
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

    const overrides = overrideButtonsForResultShape(result.totalRows, result.columnNames.length);
    if (summary) {
      const blocks: KnownBlock[] = [
        ...buildAssumptionBlocks(ctx.assumptions, ctx.traceId),
        { type: 'section', text: { type: 'mrkdwn', text: summary } } as KnownBlock,
        buildFeedbackActions(ctx.traceId, ctx.threadTs, ctx.statusMsgTs, overrides),
      ];
      await client.chat.update({ channel, ts: messageTs, text: summary, blocks });
    } else {
      // Fallback to table format when Flash summarization fails
      const MAX_DISPLAY_ROWS = 20;
      const displayRows = result.rows.slice(0, MAX_DISPLAY_ROWS);
      const isTruncated = result.rows.length > MAX_DISPLAY_ROWS || result.truncated;
      const blocks: KnownBlock[] = [
        ...buildAssumptionBlocks(ctx.assumptions, ctx.traceId),
        { type: 'section', text: { type: 'mrkdwn', text: "Couldn't generate a summary. Here's the raw data:" } } as KnownBlock,
        ...buildTableBlocks(displayRows, result.columnNames),
        ...(isTruncated ? buildTruncatedBlocks(displayRows.length, result.totalRows) : []),
        buildFeedbackActions(ctx.traceId, ctx.threadTs, ctx.statusMsgTs, overrides),
      ];
      await client.chat.update({ channel, ts: messageTs, text: ctx.explanation, blocks });
    }
  } catch (err) {
    rootLogger.error(
      { error: (err as Error).message, traceId: extractTraceId(err) },
      'override.summary.failed',
    );
    if (err instanceof ResponseContextNotFoundError) {
      await notifyContextUnavailable(client, channel, viewer);
      return;
    }
    await client.chat.update({
      channel,
      ts: messageTs,
      text: `Something went wrong re-running the query. (trace: ${extractTraceId(err)})`,
    });
  }
}

export async function handleCsvOverride(
  compoundKey: string,
  channel: string,
  threadTs: string,
  messageTs: string,
  userId: string,
  currentBlocks: KnownBlock[],
  client: WebClient,
  config: OverrideConfig,
): Promise<void> {
  try {
    const ctx = await loadContext(compoundKey);
    const { result } = await reExecuteSql(ctx, config);

    const header = result.columnNames.join(',');
    const rows = result.rows.map(row =>
      result.columnNames.map(col => {
        const val = formatValue(row[col]);
        return val.includes(',') || val.includes('"') || val.includes('\n')
          ? `"${val.replace(/"/g, '""')}"`
          : val;
      }).join(','),
    );
    const csv = [header, ...rows].join('\n');

    await client.filesUploadV2({
      channel_id: channel,
      thread_ts: threadTs,
      filename: 'query_results.csv',
      file: Buffer.from(csv, 'utf-8'),
      title: `Results: ${ctx.clarifiedQuestion}`,
    });

    // Idempotency: rebuild the message without the CSV button and add an
    // "exported" marker, so a re-click can't upload a duplicate file.
    // Drop only the feedback/override actions block (the one carrying the CSV
    // button); preserve any other actions block (e.g. the assumptions "refine"
    // block from buildResponseBlocks) so a CSV export doesn't strip it.
    const isOverrideActions = (b: KnownBlock): boolean =>
      b.type === 'actions' &&
      (b as ActionsBlock).elements.some(
        (e) =>
          'action_id' in e &&
          typeof e.action_id === 'string' &&
          (e.action_id.startsWith('override_') ||
            e.action_id.startsWith('thumbs_') ||
            e.action_id.startsWith('show_') ||
            e.action_id.startsWith('hide_')),
      );
    const preserved = currentBlocks.filter((b) => !isOverrideActions(b));
    const overrides = { ...overrideButtonsForResultShape(result.totalRows, result.columnNames.length), csv: false };
    const blocks: KnownBlock[] = [
      ...preserved,
      buildFeedbackActions(ctx.traceId, ctx.threadTs, ctx.statusMsgTs, overrides),
      { type: 'context', elements: [{ type: 'mrkdwn', text: '📎 CSV exported' }] } as KnownBlock,
    ];
    await client.chat.update({ channel, ts: messageTs, text: ctx.explanation, blocks });
  } catch (err) {
    rootLogger.error(
      { error: (err as Error).message, traceId: extractTraceId(err) },
      'override.csv.failed',
    );
    await client.chat.postEphemeral({
      channel,
      user: userId,
      thread_ts: threadTs,
      text: err instanceof ResponseContextNotFoundError
        ? CONTEXT_UNAVAILABLE_TEXT
        : `Something went wrong exporting to CSV. (trace: ${extractTraceId(err)})`,
    });
  }
}
