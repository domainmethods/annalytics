import { readFileSync } from 'node:fs';
import { App, ExpressReceiver } from '@slack/bolt';
import type { GenericMessageEvent } from '@slack/types';
import { loadConfig } from './config.js';
import type { TableContext } from './dbt/types.js';
import { parseDbtArtifacts } from './dbt/parser.js';
import { initFirestore } from './state/firestore.js';
import { initBigQuery } from './validation/dryRun.js';
import { initBigQueryClient, getBigQueryClient } from './execution/runner.js';
import { registerCommands } from './handlers/commands.js';
import { registerMentions } from './handlers/mentions.js';
import { shouldRespond, checkClarificationReply } from './handlers/messages.js';
import { acquireThreadLock } from './state/threadLock.js';
import { checkRateLimit } from './state/rateLimiter.js';
import { recordFeedback } from './state/responseContext.js';
import { runPipeline } from './pipeline.js';
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

const app = new App({
  token: config.slack.botToken,
  receiver,
  processBeforeResponse: false,
});

// Register handlers
registerCommands(app, getConfig, getTables);
registerMentions(app, getConfig, getTables);

// Message handler (thread follow-ups in channels + DMs)
app.event('message', async ({ event, client }) => {
  // Skip bot messages, message_changed, etc.
  if ('bot_id' in event || 'subtype' in event) return;

  const msg = event as GenericMessageEvent;

  // Check for pending clarification reply FIRST
  const clarificationReply = await checkClarificationReply(msg);
  if (clarificationReply) {
    // Resume pipeline with clarified question
    await runPipeline({
      question: clarificationReply.clarifiedQuestion,
      channel: clarificationReply.channel,
      threadTs: clarificationReply.threadTs,
      statusMsgTs: clarificationReply.clarifyingMessageTs,
      client,
      tables: getTables(),
      config: {
        geminiApiKey: config.gemini.apiKey,
        geminiModel: config.gemini.model,
        fileSearchStoreId: config.gemini.fileSearchStoreId,
        maxBytesProcessed: config.limits.costGateMaxBytes,
        queryTimeoutMs: config.limits.queryTimeoutMs,
        maxResultRows: config.limits.maxResultRows,
      },
    });
    return;
  }

  const respond = await shouldRespond(msg);
  if (!respond) return;

  const threadTs = msg.thread_ts || msg.ts;

  // Rate limit check
  const rateCheck = await checkRateLimit(msg.user, config.limits.rateLimitPerHour);
  if (!rateCheck.allowed) {
    await client.chat.postMessage({
      channel: msg.channel,
      thread_ts: threadTs,
      text: `You've hit the query limit (${config.limits.rateLimitPerHour}/hour). Resets in ${rateCheck.retryAfterMinutes} minutes.`,
    });
    return;
  }

  // Acquire thread lock
  const locked = await acquireThreadLock(threadTs);
  if (!locked) {
    await client.chat.postMessage({
      channel: msg.channel,
      thread_ts: threadTs,
      text: "I'm still working on your previous question...",
    });
    return;
  }

  const statusMsg = await client.chat.postMessage({
    channel: msg.channel,
    thread_ts: threadTs,
    text: 'Understanding your question...',
  });

  await runPipeline({
    question: msg.text || '',
    channel: msg.channel,
    threadTs,
    statusMsgTs: statusMsg.ts!,
    client,
    tables: getTables(),
    config: {
      geminiApiKey: config.gemini.apiKey,
      geminiModel: config.gemini.model,
      fileSearchStoreId: config.gemini.fileSearchStoreId,
      maxBytesProcessed: config.limits.costGateMaxBytes,
      queryTimeoutMs: config.limits.queryTimeoutMs,
      maxResultRows: config.limits.maxResultRows,
    },
  });
});

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

// Start
(async () => {
  await app.start(config.port);
  rootLogger.info({ port: config.port }, 'Anna Lytics is running');
})();
