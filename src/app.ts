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
import {
  canMessageEventReachPipeline,
  shouldRespond,
  checkClarificationReply,
} from './handlers/messages.js';
import { checkEscalationResponse, resumeFromEscalation } from './handlers/escalationResponse.js';
import { checkOverdueEscalations } from './handlers/escalationLifecycle.js';
import { checkRateLimit } from './state/rateLimiter.js';
import { releaseThreadLock } from './state/threadLock.js';
import {
  claimSlackEvent,
  extractSlackEventId,
  markSlackEventVisible,
  releaseSlackEventClaim,
} from './state/slackEventDedupe.js';
import { preflightChecks } from './handlers/preflightChecks.js';
import { recordFeedback, getResponseContext } from './state/responseContext.js';
import { buildReasoningBlocks, REASONING_BLOCK_PREFIX } from './slack/reasoningBlocks.js';
import { buildFeedbackActions } from './slack/blocks.js';
import { handleTableOverride, handleSummaryOverride, handleCsvOverride } from './handlers/responseOverrides.js';
import { runPipeline, toPipelineConfig } from './pipeline.js';
import { classifyFollowUp } from './agents/followUpClassifier.js';
import { routeFollowUp } from './handlers/followUpRouter.js';
import { registerDbtRunIngestion } from './handlers/dbtRunIngestion.js';
import { buildThreadContext } from './slack/threadContext.js';
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

// Message handler (thread follow-ups in channels + DMs)
app.event('message', async ({ event, body, client }) => {
  // Skip bot messages, message_changed, etc.
  if ('bot_id' in event || 'subtype' in event) return;

  const msg = event as GenericMessageEvent;
  if (!canMessageEventReachPipeline(msg)) return;

  const eventId = extractSlackEventId(body);
  let visibleResponse = false;
  let lockHeld = false;
  const shouldProcess = await claimSlackEvent(eventId);
  if (!shouldProcess) return;

  try {
    // Non-blocking lifecycle check: reminders + timeouts for pending escalations
    checkOverdueEscalations(client, config.escalation).catch(err =>
      rootLogger.error({ error: (err as Error).message }, 'escalation.lifecycle.error'),
    );

    // Check for pending clarification reply FIRST
    const clarificationReply = await checkClarificationReply(msg);
    if (clarificationReply) {
      visibleResponse = true;
      await markSlackEventVisible(eventId).catch(() => {});
      // Resume pipeline with clarified question
      await runPipeline({
        question: clarificationReply.clarifiedQuestion,
        channel: clarificationReply.channel,
        threadTs: clarificationReply.threadTs,
        statusMsgTs: clarificationReply.clarifyingMessageTs,
        client,
        tables: getTables(),
        config: toPipelineConfig(config),
      });
      return;
    }

    // Check for escalation response (data team replying in escalation channel or DM)
    const isEscalationChannel = config.escalation.channelId && msg.channel === config.escalation.channelId;
    const isEscalationDm = config.escalation.mode === 'dm' && config.escalation.analystUserId;
    if ((isEscalationChannel || isEscalationDm) && msg.thread_ts) {
      const escalationCtx = await checkEscalationResponse(msg);
      if (escalationCtx) {
        visibleResponse = true;
        await markSlackEventVisible(eventId).catch(() => {});
        await resumeFromEscalation(escalationCtx, client, getTables(), toPipelineConfig(config));
        return;
      }
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
      visibleResponse = true;
      await markSlackEventVisible(eventId).catch(() => {});
      return;
    }

    // Preflight: lock + clarification + escalation guards
    const passed = await preflightChecks(msg.channel, threadTs, client);
    if (!passed) return;
    lockHeld = true;

    const statusMsg = await client.chat.postMessage({
      channel: msg.channel,
      thread_ts: threadTs,
      text: 'Understanding your question...',
    });
    visibleResponse = true;
    await markSlackEventVisible(eventId).catch(() => {});

    // Follow-up intent routing for thread replies
    if (msg.thread_ts) {
      try {
        const threadMessages = await client.conversations.replies({
          channel: msg.channel,
          ts: threadTs,
          oldest: threadTs,
        });
        const threadContext = buildThreadContext(threadMessages.messages || [], 4, {
          summarizeOlder: true,
          stripQueryResults: true,
          maxTokens: 1000,
        });
        if (threadContext.length > 0) {
          const { intent } = await classifyFollowUp(msg.text || '', threadContext, config.gemini.apiKey);
          if (intent !== 'new_query') {
            await routeFollowUp(
              intent, msg.text || '', threadTs, msg.channel, statusMsg.ts!,
              client, toPipelineConfig(config), getTables(),
            );
            await releaseThreadLock(threadTs).catch(() => {});
            lockHeld = false;
            return;
          }
        }
      } catch {
        // Classification failed — fall through to standard pipeline
      }
    }

    lockHeld = false;
    await runPipeline({
      question: msg.text || '',
      channel: msg.channel,
      threadTs,
      statusMsgTs: statusMsg.ts!,
      client,
      tables: getTables(),
      config: toPipelineConfig(config),
    });
  } catch (error) {
    if (!visibleResponse) await releaseSlackEventClaim(eventId).catch(() => {});
    if (lockHeld) await releaseThreadLock(msg.thread_ts || msg.ts).catch(() => {});
    throw error;
  }
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

  // Re-add the feedback actions with show_reasoning button
  const [threadTs, statusMsgTs] = compoundKey.split('_');
  withoutReasoning.push(buildFeedbackActions(ctx.traceId, threadTs, statusMsgTs));

  await client.chat.update({
    channel,
    ts: messageTs,
    text: (body as any).message?.text || '',
    blocks: withoutReasoning,
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
