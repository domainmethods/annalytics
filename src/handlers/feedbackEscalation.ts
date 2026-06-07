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
import { buildOtherNoteModal } from '../slack/feedbackModals.js';
import { saveFeedbackNote, type FeedbackNote } from '../state/feedbackNotes.js';
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
  triggerId?: string;
}

/**
 * Routes a chosen negative-feedback reason:
 *  - escalate (wrong_number / wrong_data) → create esc_fb_ escalation + post card
 *  - refine (not_asked)                   → public refine prompt in-thread
 *  - record (other / unknown)             → ephemeral ack only
 */
export async function handleFeedbackReason(params: HandleFeedbackReasonParams): Promise<void> {
  const { reasonId, compoundKey, userId, channel, client, respond, config, triggerId } = params;

  // "Other" with an interaction trigger → collect a free-text note via modal
  // instead of acking immediately. The modal submission (a separate handler)
  // does the persistence + ack. Guarded on triggerId so callers that don't
  // pass one (e.g. legacy paths) still fall through to the record-only ack.
  if (reasonId === 'other' && triggerId) {
    try {
      await client.views.open({
        trigger_id: triggerId,
        view: buildOtherNoteModal(channel, compoundKey),
      });
      return;
    } catch (err) {
      // trigger_id is valid for ~3s; views.open also throws on any Slack API
      // error. An uncaught rejection leaves the user with no acknowledgement.
      // Mirror the escalate path's log-and-degrade idiom: log identifiers only,
      // then fall through to the same record-only ack the user would have gotten
      // without the modal — never a silent drop.
      rootLogger.error(
        { error: (err as Error).message, channel, compoundKey },
        'feedback.other_note.modal_open_failed',
      );
      await respond({ replace_original: true, text: 'Thanks — noted. I logged this for review.' });
      return;
    }
  }

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

  const escalationId = `esc_fb_${ctx.traceId}`;

  // Both remaining steps are external I/O that can fail (Slack rate limits / a
  // bad target channel / an API outage on the card post; Firestore on the save).
  // Neither must propagate: an uncaught rejection leaves the user's ephemeral
  // prompt un-replaced, so without an ack they may re-click. Mirror
  // escalationResponse.ts's downstream-failure idiom: log + degrade gracefully.
  // We log identifiers only (traceId/escalationId), never the SQL body.
  //
  // Partial-write note: if the card post succeeds but the save then fails, an
  // orphan card sits in the analyst channel with no matchable state. That is the
  // accepted v1 tradeoff — the user still gets the re-ask degrade, and a re-click
  // re-posts rather than silently dropping. (hasPendingEscalation stays false.)
  try {
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
      'feedback.escalation.failed',
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

export interface HandleOtherNoteSubmissionParams {
  privateMetadata: string;
  noteText: string;
  userId: string;
  client: WebClient;
}

/**
 * Handles the `view_submission` from the "Other" free-text modal (opened by
 * handleFeedbackReason). Persists the user's note as a FeedbackNote and posts a
 * deterministic, in-thread ephemeral ack. ResponseContext enrichment is
 * best-effort: a missing/evicted doc must never block recording the note.
 *
 * Called by the (separate) `app.view(...)` registration, which extracts the
 * note text from the modal input before invoking this.
 */
export async function handleOtherNoteSubmission(
  params: HandleOtherNoteSubmissionParams,
): Promise<void> {
  const { privateMetadata, noteText, userId, client } = params;

  let channel = '';
  let compoundKey = '';
  try {
    const meta = JSON.parse(privateMetadata) as { channel?: string; compoundKey?: string };
    channel = meta.channel ?? '';
    compoundKey = meta.compoundKey ?? '';
  } catch {
    // A malformed private_metadata means we can't reconstruct where to ack or
    // what to join the note to. Log identifiers only and return — never throw,
    // which would surface a Slack modal error to the user.
    rootLogger.error({ userId }, 'feedback.other_note.bad_metadata');
    return;
  }

  // Slack ts values use '.', never '_', so a well-formed compound key splits
  // into exactly two non-empty parts. Validate before use — a malformed key
  // would leave threadTs empty, keying the note to a colliding doc id and
  // posting the ack un-threaded. Log identifiers only and no-op (no save, no
  // ack) rather than corrupt state. Mirrors handleFeedbackReason's guard.
  const parts = compoundKey.split('_');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    rootLogger.error({ userId, compoundKey }, 'feedback.other_note.bad_compound_key');
    return;
  }
  const [threadTs] = parts;

  // ResponseContext is best-effort enrichment; a missing/evicted doc must not
  // block recording the user's note.
  const ctx = await getResponseContext(compoundKey).catch(() => null);

  // Firestore is not configured with ignoreUndefinedProperties, so a literal
  // `undefined` field value would reject the write. Build the note with the
  // optional enrichment keys OMITTED when the context is gone, rather than
  // assigning them `undefined`.
  const note: FeedbackNote = { note: noteText, userId, threadTs, channel };
  if (ctx?.clarifiedQuestion !== undefined) note.clarifiedQuestion = ctx.clarifiedQuestion;
  if (ctx?.traceId !== undefined) note.traceId = ctx.traceId;

  try {
    await saveFeedbackNote(note);
    rootLogger.info({ userId, traceId: ctx?.traceId, threadTs }, 'feedback.other_note.saved');
  } catch (err) {
    rootLogger.error(
      { error: (err as Error).message, userId, threadTs },
      'feedback.other_note.save_failed',
    );
  }

  await client.chat
    .postEphemeral({
      channel,
      user: userId,
      thread_ts: threadTs,
      text: 'Thanks — noted. I logged this for review.',
    })
    .catch((err) =>
      rootLogger.warn(
        { error: (err as Error).message, userId, threadTs },
        'feedback.other_note.ack_failed',
      ),
    );
}
