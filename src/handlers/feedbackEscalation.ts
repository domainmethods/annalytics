import type { WebClient } from '@slack/web-api';
import type { KnownBlock } from '@slack/types';
import type { PipelineConfig } from '../pipeline.js';
import { resolveEscalationTarget } from '../pipeline.js';
import { getResponseContext } from '../state/responseContext.js';
import { hasPendingEscalation, saveEscalationState } from '../state/escalationState.js';
import { buildEscalationBlocks } from '../slack/escalationBlocks.js';
import {
  buildFeedbackReasonBlocks,
  buildFeedbackAckBlocks,
  feedbackReasonById,
} from '../slack/feedbackBlocks.js';
import { rootLogger } from '../logging.js';

/**
 * Shown when we can no longer reconstruct an answer's details (malformed
 * compound key, evicted ResponseContext, or a failed escalation-state write
 * after the card already posted). Single-sourced so the user-facing wording
 * stays identical across every degrade path.
 */
const REASK_MESSAGE =
  "I can't pull this answer's details anymore — please re-ask and I'll take another run at it.";

/** Bolt's `respond` updates the ephemeral message via its response_url. */
export type RespondFn = (message: {
  text?: string;
  blocks?: KnownBlock[];
  replace_original?: boolean;
  response_type?: 'ephemeral' | 'in_channel';
}) => Promise<unknown>;

export interface PromptFeedbackReasonParams {
  client: WebClient;
  channel: string;
  userId: string;
  threadTs: string;
  statusMsgTs: string;
}

/**
 * Posts the ephemeral 4-reason prompt to the user who clicked the negative-feedback
 * button. The public thread stays clean; only the resolution (if any) posts publicly later.
 */
export async function promptFeedbackReason(params: PromptFeedbackReasonParams): Promise<void> {
  const compoundKey = `${params.threadTs}_${params.statusMsgTs}`;
  await params.client.chat.postEphemeral({
    channel: params.channel,
    user: params.userId,
    thread_ts: params.threadTs,
    text: 'What was off about this answer?',
    blocks: buildFeedbackReasonBlocks(compoundKey) as unknown as KnownBlock[],
  });
}

export interface HandleFeedbackReasonParams {
  reasonId: string;
  compoundKey: string;
  userId: string;
  channel: string;
  client: WebClient;
  respond: RespondFn;
  config: PipelineConfig;
}

/**
 * Routes a chosen negative-feedback reason:
 *  - escalate (wrong_number / wrong_data) → create esc_fb_ escalation + post card
 *  - refine (not_asked)                   → public refine prompt in-thread
 *  - record (other / unknown)             → ephemeral ack only
 */
export async function handleFeedbackReason(params: HandleFeedbackReasonParams): Promise<void> {
  const { reasonId, compoundKey, userId, channel, client, respond, config } = params;
  const reason = feedbackReasonById(reasonId);

  // Unknown reason id → treat as record-only.
  if (!reason || reason.route === 'record') {
    await respond({ replace_original: true, text: 'Thanks — noted. I logged this for review.' });
    return;
  }

  // Slack ts values use '.', never '_', so a well-formed compound key splits
  // into exactly two non-empty parts. Validate before use — statusMsgTs is a
  // required field in the EscalationState write contract, so an undefined part
  // would corrupt the Firestore doc.
  const parts = compoundKey.split('_');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    await respond({ replace_original: true, text: REASK_MESSAGE });
    return;
  }
  const [threadTs, statusMsgTs] = parts;

  if (reason.route === 'refine') {
    // Reuse the exact wording of the existing `refine_assumptions` handler in
    // app.ts so the refine UX is consistent regardless of entry point.
    await client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text: "What should I change about my assumptions? Reply with your corrections and I'll re-run the query.",
    });
    await respond({ replace_original: true, text: 'Got it — let me know what to change in the thread.' });
    return;
  }

  // route === 'escalate'
  const target = resolveEscalationTarget(config.escalation);
  if (!target) {
    // No analyst target configured → record-only degrade.
    await respond({ replace_original: true, text: 'Thanks — noted. (No data-team channel is configured.)' });
    return;
  }

  const ctx = await getResponseContext(compoundKey);
  if (!ctx) {
    await respond({ replace_original: true, text: REASK_MESSAGE });
    return;
  }

  if (await hasPendingEscalation(threadTs)) {
    await respond({ replace_original: true, text: '✅ This thread is already flagged for the data team.' });
    return;
  }

  const escalationMsg = await client.chat.postMessage({
    channel: target,
    text: `Anna Lytics flagged answer: "${ctx.clarifiedQuestion}"`,
    blocks: buildEscalationBlocks({
      userQuestion: ctx.clarifiedQuestion,
      channelName: `<#${channel}>`,
      threadLink: `slack://channel?id=${channel}&message=${threadTs}`,
      stuckDescription: `User flagged this answer as "${reason.label}". Please verify and reply with a correction.`,
      bestGuessSql: ctx.generatedSql,
    }) as unknown as KnownBlock[],
  });

  const escalationId = `esc_fb_${ctx.traceId}`;

  // The escalation card is already posted (above). If the state write fails now,
  // we must NOT leave the user's ephemeral prompt un-replaced: without an ack
  // they may re-click, and since no state was saved hasPendingEscalation stays
  // false → a duplicate card posts, and the analyst's reply can't be matched.
  // Mirror escalationResponse.ts's downstream-failure idiom: log + degrade
  // gracefully rather than propagate. We log identifiers only (traceId/
  // escalationId), never the SQL body, matching the sibling's level of detail.
  try {
    await saveEscalationState({
      escalationId,
      originalThreadTs: threadTs,
      originalChannel: channel,
      trigger: 'user_negative_feedback',
      behavior: 'best_effort_verify',
      stageToResume: 'supervisor_review',
      context: {
        clarifiedQuestion: ctx.clarifiedQuestion,
        // ResponseContext does not persist the raw user question, so both
        // fields intentionally collapse to clarifiedQuestion. The downstream
        // teaching candidate's "original vs clarified" distinction is lost for
        // feedback-triggered escalations — acceptable given it's the best
        // available data; revisit if ResponseContext starts persisting the raw question.
        userQuestion: ctx.clarifiedQuestion,
        groundingCitations: ctx.groundingCitations,
        previousSql: ctx.generatedSql,
        supervisorNotes: ctx.supervisorNotes,
        feedbackReason: reason.label,
        feedbackUserId: userId,
      },
      escalationChannel: target,
      escalationTs: escalationMsg.ts!,
      statusMsgTs,
      bestEffortSql: ctx.generatedSql,
      traceId: ctx.traceId,
    }, config.escalation?.timeoutHours ?? 4);
  } catch (err) {
    rootLogger.error(
      { error: (err as Error).message, traceId: ctx.traceId, escalationId },
      'feedback.escalation.state_save_failed',
    );
    await respond({ replace_original: true, text: REASK_MESSAGE });
    return;
  }

  await respond({
    replace_original: true,
    blocks: buildFeedbackAckBlocks("✅ Flagged for the data team — I'll reply here when they weigh in.") as unknown as KnownBlock[],
    text: 'Flagged for the data team.',
  });
}
