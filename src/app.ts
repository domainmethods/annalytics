import { readFileSync } from 'node:fs';
import { App, ExpressReceiver } from '@slack/bolt';
import { loadConfig } from './config.js';
import type { TableContext } from './dbt/types.js';
import { parseDbtArtifacts } from './dbt/parser.js';
import { initFirestore } from './state/firestore.js';
import { initBigQuery } from './validation/dryRun.js';
import { initBigQueryClient, getBigQueryClient } from './execution/runner.js';
import { registerCommands } from './handlers/commands.js';
import { registerMentions } from './handlers/mentions.js';
import { registerMessageHandler } from './handlers/messageHandler.js';
import { recordFeedback, getResponseContext } from './state/responseContext.js';
import { buildReasoningBlocks, REASONING_BLOCK_PREFIX } from './slack/reasoningBlocks.js';
import { buildSqlBlocks, SQL_BLOCK_PREFIX } from './slack/sqlBlocks.js';
import { buildFeedbackActions, overrideButtonsForResultShape } from './slack/blocks.js';
import { handleTableOverride, handleSummaryOverride, handleCsvOverride } from './handlers/responseOverrides.js';
import { registerDbtRunIngestion } from './handlers/dbtRunIngestion.js';
import { startSummaryRefresh } from './teachings/summaryMap.js';
import { fetchAllSampleRows } from './dbt/sampleRows.js';
import { saveSampleRows } from './dbt/sampleRowCache.js';
import { rootLogger } from './logging.js';

const config = loadConfig();

// Initialize clients
initFirestore(config.gcp.projectId);
initBigQuery(config.gcp.projectId);
initBigQueryClient(config.gcp.projectId);

// In-memory schema cache — loaded at startup from dbt artifacts
let tables: TableContext[] = [];
const getTables = () => tables;
const getConfig = () => config;

// Load dbt artifacts at startup — fail fast if missing
const manifest = JSON.parse(readFileSync(config.dbt.manifestPath, 'utf-8'));
const catalog = JSON.parse(readFileSync(config.dbt.catalogPath, 'utf-8'));
tables = parseDbtArtifacts(manifest, catalog);
rootLogger.info({ tableCount: tables.length }, 'Loaded dbt metadata');

// Start teaching summary refresh
startSummaryRefresh();

// Populate sample rows cache at startup (non-blocking)
(async () => {
  try {
    const bq = getBigQueryClient();
    const results = await fetchAllSampleRows(bq, tables);
    for (const result of results) {
      if (result.rows.length > 0) {
        await saveSampleRows(result);
      }
    }
    rootLogger.info({ count: results.filter(r => r.rows.length > 0).length }, 'Sample rows cached');
  } catch (err) {
    rootLogger.warn({ error: (err as Error).message }, 'Sample rows population failed');
  }
})();

// Set up Bolt.js
const receiver = new ExpressReceiver({
  signingSecret: config.slack.signingSecret,
});

receiver.router.get('/health', (_req, res) => {
  res.status(200).send('OK');
});

receiver.router.post('/refresh-metadata', async (_req, res) => {
  res.status(200).send('OK');
  rootLogger.info('Metadata refresh triggered');
});

if (config.dbt.webhookSecret) {
  registerDbtRunIngestion(receiver.router, config.dbt.webhookSecret);
}

const app = new App({
  token: config.slack.botToken,
  receiver,
  processBeforeResponse: false,
});

// Register handlers
registerCommands(app, getConfig, getTables);
registerMentions(app, getConfig, getTables);
// Message handler (thread follow-ups in channels + DMs) — extracted to
// handlers/messageHandler.ts so the orchestration is unit/integration-testable
// instead of living in this coverage-excluded entry point.
registerMessageHandler(app, getConfig, getTables);

// Feedback button handlers — record to Firestore
app.action(/thumbs_(up|down)_.*/, async ({ action, ack, body }) => {
  await ack();
  const btn = action as { value?: string; action_id: string };
  const traceId = btn.value;
  const feedbackType = btn.action_id.startsWith('thumbs_up') ? 'positive' : 'negative';
  rootLogger.info({ traceId, feedbackType, userId: body.user.id }, 'feedback.received');

  // Record feedback in Firestore
  const threadTs = (body as any).message?.thread_ts || (body as any).message?.ts;
  const messageTs = (body as any).message?.ts;
  if (threadTs && messageTs) {
    await recordFeedback(threadTs, messageTs, feedbackType as 'positive' | 'negative');
  }
});

// "Wrong assumptions? Click to refine" button handler
app.action('refine_assumptions', async ({ ack, body, client }) => {
  await ack();
  const message = (body as any).message;
  const threadTs = message?.thread_ts || message?.ts;
  const channel = (body as any).channel?.id;

  if (threadTs && channel) {
    await client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text: 'What should I change about my assumptions? Reply with your corrections and I\'ll re-run the query.',
    });
  }
});

// "Show reasoning" toggle — appends reasoning blocks to the message
app.action(/show_reasoning_.*/, async ({ action, ack, body, client }) => {
  await ack();
  const btn = action as { value?: string; action_id: string };
  const compoundKey = btn.value; // threadTs_statusMsgTs
  if (!compoundKey) return;

  const ctx = await getResponseContext(compoundKey);
  if (!ctx) return;

  const channel = (body as any).channel?.id;
  const messageTs = (body as any).message?.ts;
  if (!channel || !messageTs) return;

  // Remove the feedback actions block that contains the show_reasoning button
  const currentBlocks: any[] = (body as any).message?.blocks || [];
  const withoutFeedback = currentBlocks.filter(
    (b: any) => !(b.type === 'actions' && b.elements?.some((e: any) => e.action_id?.startsWith('show_reasoning_'))),
  );
  const reasoningBlocks = buildReasoningBlocks(ctx);

  await client.chat.update({
    channel,
    ts: messageTs,
    text: (body as any).message?.text || '',
    blocks: [...withoutFeedback, ...reasoningBlocks],
  });
});

// "Hide reasoning" toggle — removes reasoning blocks from the message
app.action(/hide_reasoning_.*/, async ({ action, ack, body, client }) => {
  await ack();
  const btn = action as { value?: string; action_id: string };
  const compoundKey = btn.value; // threadTs_statusMsgTs
  if (!compoundKey) return;

  const ctx = await getResponseContext(compoundKey);
  if (!ctx) return;

  const channel = (body as any).channel?.id;
  const messageTs = (body as any).message?.ts;
  if (!channel || !messageTs) return;

  // Remove all reasoning blocks by block_id prefix
  const currentBlocks: any[] = (body as any).message?.blocks || [];
  const withoutReasoning = currentBlocks.filter(
    (b: any) => !b.block_id?.startsWith(REASONING_BLOCK_PREFIX),
  );

  // Re-add the feedback actions with show_reasoning/show_sql buttons. Rebuild
  // the override set from the persisted result shape so we don't resurrect
  // buttons the original answer suppressed (e.g. Table/CSV on a zero-row result).
  const [threadTs, statusMsgTs] = compoundKey.split('_');
  const overrides = overrideButtonsForResultShape(ctx.queryResults.rowCount, ctx.queryResults.columnNames.length);
  withoutReasoning.push(buildFeedbackActions(ctx.traceId, threadTs, statusMsgTs, overrides));

  await client.chat.update({
    channel,
    ts: messageTs,
    text: (body as any).message?.text || '',
    blocks: withoutReasoning,
  });
});

// "Show SQL" toggle — appends the SQL panel to the message. Mirrors the
// reasoning toggle: the feedback row (which holds the Show SQL button) is
// swapped out for the SQL panel, which carries its own "Hide SQL" button. The
// SQL is read from persisted ResponseContext — no re-query.
app.action(/show_sql_.*/, async ({ action, ack, body, client }) => {
  await ack();
  const btn = action as { value?: string; action_id: string };
  const compoundKey = btn.value; // threadTs_statusMsgTs
  if (!compoundKey) return;

  const ctx = await getResponseContext(compoundKey);
  if (!ctx) return;

  const channel = (body as any).channel?.id;
  const messageTs = (body as any).message?.ts;
  if (!channel || !messageTs) return;

  // Remove the feedback actions block that contains the show_sql button
  const currentBlocks: any[] = (body as any).message?.blocks || [];
  const withoutFeedback = currentBlocks.filter(
    (b: any) => !(b.type === 'actions' && b.elements?.some((e: any) => e.action_id?.startsWith('show_sql_'))),
  );
  const sqlBlocks = buildSqlBlocks(ctx);

  await client.chat.update({
    channel,
    ts: messageTs,
    text: (body as any).message?.text || '',
    blocks: [...withoutFeedback, ...sqlBlocks],
  });
});

// "Hide SQL" toggle — removes the SQL panel and restores the feedback row.
app.action(/hide_sql_.*/, async ({ action, ack, body, client }) => {
  await ack();
  const btn = action as { value?: string; action_id: string };
  const compoundKey = btn.value; // threadTs_statusMsgTs
  if (!compoundKey) return;

  const ctx = await getResponseContext(compoundKey);
  if (!ctx) return;

  const channel = (body as any).channel?.id;
  const messageTs = (body as any).message?.ts;
  if (!channel || !messageTs) return;

  // Remove all SQL panel blocks by block_id prefix
  const currentBlocks: any[] = (body as any).message?.blocks || [];
  const withoutSql = currentBlocks.filter(
    (b: any) => !b.block_id?.startsWith(SQL_BLOCK_PREFIX),
  );

  // Re-add the feedback actions with the result-shape-aware override set.
  const [threadTs, statusMsgTs] = compoundKey.split('_');
  const overrides = overrideButtonsForResultShape(ctx.queryResults.rowCount, ctx.queryResults.columnNames.length);
  withoutSql.push(buildFeedbackActions(ctx.traceId, threadTs, statusMsgTs, overrides));

  await client.chat.update({
    channel,
    ts: messageTs,
    text: (body as any).message?.text || '',
    blocks: withoutSql,
  });
});

// Response override handlers (Table, Summary, CSV)
const overrideConfig = {
  maxBytesProcessed: config.limits.costGateMaxBytes,
  queryTimeoutMs: config.limits.queryTimeoutMs,
  maxResultRows: config.limits.maxResultRows,
  geminiApiKey: config.gemini.apiKey,
};

app.action(/override_table_.*/, async ({ action, ack, body, client }) => {
  await ack();
  const btn = action as { value?: string };
  if (!btn.value) return;
  const channel = (body as any).channel?.id;
  const messageTs = (body as any).message?.ts;
  if (!channel || !messageTs) return;
  await handleTableOverride(btn.value, channel, messageTs, client, overrideConfig);
});

app.action(/override_summary_.*/, async ({ action, ack, body, client }) => {
  await ack();
  const btn = action as { value?: string };
  if (!btn.value) return;
  const channel = (body as any).channel?.id;
  const messageTs = (body as any).message?.ts;
  if (!channel || !messageTs) return;
  await handleSummaryOverride(btn.value, channel, messageTs, client, overrideConfig);
});

app.action(/override_csv_.*/, async ({ action, ack, body, client }) => {
  await ack();
  const btn = action as { value?: string };
  if (!btn.value) return;
  const channel = (body as any).channel?.id;
  const threadTs = (body as any).message?.thread_ts || (body as any).message?.ts;
  if (!channel || !threadTs) return;
  await handleCsvOverride(btn.value, channel, threadTs, client, overrideConfig);
});

// Start
(async () => {
  await app.start(config.port);
  rootLogger.info({ port: config.port }, 'Anna Lytics is running');
})();
