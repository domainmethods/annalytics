import type { App } from '@slack/bolt';
import type { WebClient } from '@slack/web-api';
import type { ReactionAddedEvent } from '@slack/types';
import type { AppConfig } from '../config.js';
import type { TableContext } from '../dbt/types.js';
import { getEscalationByEscalationThread } from '../state/escalationState.js';
import { resumeFromEscalation } from './escalationResponse.js';
import { toPipelineConfig } from '../pipeline.js';

const CONFIRM_REACTION = 'white_check_mark'; // ✅ U+2705

/**
 * Wire the `reaction_added` event to {@link handleEscalationReaction}.
 * Mirrors `registerMessageHandler` so the orchestration lives in a
 * testable function instead of an inline closure in app.ts.
 */
export function registerEscalationReaction(
  app: App,
  getConfig: () => AppConfig,
  getTables: () => TableContext[],
) {
  app.event('reaction_added', async ({ event, client }) => {
    await handleEscalationReaction({ event, client, config: getConfig(), getTables });
  });
}

export interface HandleEscalationReactionParams {
  event: ReactionAddedEvent;
  client: WebClient;
  config: AppConfig;
  getTables: () => TableContext[];
}

/**
 * Honor the escalation card's "React with ✅ if my guess is correct" promise.
 *
 * A ✅ reaction on a pending escalation card resolves the escalation as a
 * confirmation of the bot's own proposed SQL. Because the reaction carries no
 * new human-authored guidance, teaching-candidate harvesting is skipped.
 * Idempotency comes from `getEscalationByEscalationThread`, which only returns
 * states still `awaiting_human` — a second ✅ after resolution is a no-op.
 */
export async function handleEscalationReaction({
  event,
  client,
  config,
  getTables,
}: HandleEscalationReactionParams): Promise<void> {
  if (event.reaction !== CONFIRM_REACTION) return;
  if (event.item.type !== 'message') return;

  // Cheap pre-filter in channel mode; dm mode relies on the precise ts lookup
  // (reaction volume is low) plus the post-lookup channel sanity check.
  if (
    config.escalation.mode === 'channel'
    && config.escalation.channelId
    && event.item.channel !== config.escalation.channelId
  ) return;

  const state = await getEscalationByEscalationThread(event.item.ts);
  if (!state) return; // not an escalation card, or already resolved/timed out
  if (state.escalationChannel !== event.item.channel) return;

  if (!state.context.previousSql) {
    await client.chat.postMessage({
      channel: state.escalationChannel,
      thread_ts: state.escalationTs,
      text: "There's no proposed SQL on this one — please reply with guidance instead.",
    });
    return;
  }

  const humanGuidance = state.behavior === 'park_wait'
    ? 'The data team confirmed the proposed SQL is correct.'
    : 'Confirmed correct via ✅ reaction.';

  await resumeFromEscalation(
    {
      escalationId: state.escalationId,
      originalChannel: state.originalChannel,
      originalThreadTs: state.originalThreadTs,
      statusMsgTs: state.statusMsgTs,
      humanGuidance,
      behavior: state.behavior,
      context: state.context,
      traceId: state.traceId,
    },
    client,
    getTables(),
    toPipelineConfig(config),
    {
      skipTeachingCandidate: true,
      // The guidance references "the proposed SQL", which only ever went to
      // the escalation channel — pass it as a refinement hint so the
      // park_wait re-run generates from the SQL the analyst actually
      // confirmed (best_effort_verify ignores the hint; it never re-runs).
      refinementHint: { previousSql: state.context.previousSql },
    },
  );
}
