import type { WebClient } from '@slack/web-api';
import type { TableContext } from '../dbt/types.js';
import type { PipelineConfig } from '../pipeline.js';
import type { EscalationState } from '../types.js';
import { getEscalationByEscalationThread, resolveEscalation } from '../state/escalationState.js';
import { buildEscalationResolvedBlocks } from '../slack/escalationBlocks.js';
import { runPipeline } from '../pipeline.js';
import { generateTeachingCandidate } from '../teachings/candidateGenerator.js';
import type { EscalationTeachingContext } from '../teachings/candidateGenerator.js';
import { saveTeachingCandidate } from '../state/teachingCandidates.js';

export interface EscalationResumeContext {
  escalationId: string;
  originalChannel: string;
  originalThreadTs: string;
  statusMsgTs: string;
  humanGuidance: string;
  behavior: 'best_effort_verify' | 'park_wait';
  context: EscalationState['context'];
  traceId: string;
}

export type EscalationResponseLookup =
  | { status: 'pending'; context: EscalationResumeContext }
  | { status: 'expired_now'; state: EscalationState }
  | null;

/**
 * Check if a message in a thread is a reply to a pending escalation.
 * Returns the escalation resume context if so, null otherwise.
 */
export async function checkEscalationResponse(
  event: { thread_ts?: string; text?: string; channel: string },
): Promise<EscalationResponseLookup> {
  const threadTs = event.thread_ts;
  if (!threadTs) return null;

  const lookup = await getEscalationByEscalationThread(threadTs);
  if (!lookup) return null;
  if (lookup.status === 'expired_now') return lookup;

  const { state } = lookup;

  return {
    status: 'pending',
    context: {
      escalationId: state.escalationId,
      originalChannel: state.originalChannel,
      originalThreadTs: state.originalThreadTs,
      statusMsgTs: state.statusMsgTs,
      humanGuidance: event.text || '',
      behavior: state.behavior,
      context: state.context,
      traceId: state.traceId,
    },
  };
}

/**
 * Handle a human's response to an escalation.
 * park_wait: re-run pipeline with human guidance injected.
 * best_effort_verify: post human's verification to the original thread.
 * `options.skipTeachingCandidate` suppresses teaching-candidate harvesting for
 * resolutions that carry no new human-authored guidance (e.g. a ✅ reaction).
 * `options.refinementHint` puts a previous SQL attempt in front of the SQL
 * generator on the park_wait re-run — required when the guidance references
 * "the proposed SQL" (✅ confirmation), which the generator cannot otherwise
 * see because the proposed SQL only went to the escalation channel.
 */
export async function resumeFromEscalation(
  ctx: EscalationResumeContext,
  client: WebClient,
  tables: TableContext[],
  config: PipelineConfig,
  options?: { skipTeachingCandidate?: boolean; refinementHint?: { previousSql: string } },
): Promise<void> {
  if (ctx.behavior === 'park_wait') {
    await runPipeline({
      question: `${ctx.context.clarifiedQuestion} (Data team guidance: ${ctx.humanGuidance})`,
      channel: ctx.originalChannel,
      threadTs: ctx.originalThreadTs,
      statusMsgTs: ctx.statusMsgTs,
      client,
      tables,
      config,
      refinementHint: options?.refinementHint,
    });
  } else {
    const blocks = buildEscalationResolvedBlocks(ctx.humanGuidance, ctx.behavior);
    await client.chat.postMessage({
      channel: ctx.originalChannel,
      thread_ts: ctx.originalThreadTs,
      text: ctx.humanGuidance,
      blocks: blocks,
    });
  }

  await resolveEscalation(ctx.escalationId);

  // Fire-and-forget: generate teaching candidate from escalation.
  // Skipped when the resolution carries no new human-authored guidance
  // (e.g. a ✅ reaction confirming the bot's own proposed SQL).
  if (!options?.skipTeachingCandidate) {
    const teachingCtx: EscalationTeachingContext = {
      escalationId: ctx.escalationId,
      originalQuestion: ctx.context.userQuestion,
      clarifiedQuestion: ctx.context.clarifiedQuestion,
      humanResponse: ctx.humanGuidance,
      failedSql: ctx.context.previousSql,
      supervisorNotes: ctx.context.supervisorNotes,
      apiKey: config.geminiApiKey,
    };

    generateTeachingCandidate(teachingCtx)
      .then(candidate => saveTeachingCandidate(candidate))
      .catch(err => {
        // Log and swallow — never block escalation resolution
        console.error(`Teaching candidate generation failed for ${ctx.escalationId}:`, err);
      });
  }
}
