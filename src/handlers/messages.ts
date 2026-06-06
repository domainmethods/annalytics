import { botHasRepliedInThread } from '../state/responseContext.js';
import { getClarificationState, deleteClarificationState } from '../state/clarificationState.js';

interface MessageEvent {
  channel_type?: string;
  thread_ts?: string;
  text?: string;
}

export interface ClarificationReply {
  clarifiedQuestion: string;
  channel: string;
  threadTs: string;
  clarifyingMessageTs: string;
}

/**
 * Check if a message in a thread is a reply to a pending clarification.
 * Returns the clarification context if so, null otherwise.
 */
export async function checkClarificationReply(
  event: MessageEvent & { channel: string },
): Promise<ClarificationReply | null> {
  const threadTs = event.thread_ts;
  if (!threadTs) return null;

  const state = await getClarificationState(threadTs);
  if (!state) return null;

  // Merge user reply into clarified question
  const clarifiedQuestion = `${state.originalQuestion} (Clarification: ${event.text || ''})`;

  // Delete clarification state — it's been answered
  await deleteClarificationState(state.clarificationId);

  return {
    clarifiedQuestion,
    channel: event.channel,
    threadTs,
    clarifyingMessageTs: state.clarifyingMessageTs,
  };
}

function isDirectMessageSurface(event: MessageEvent): boolean {
  return event.channel_type === 'im' || event.channel_type === 'mpim';
}

export function canMessageEventReachPipeline(event: MessageEvent): boolean {
  return isDirectMessageSurface(event) || Boolean(event.thread_ts);
}

export async function shouldRespond(event: MessageEvent): Promise<boolean> {
  // Always respond in DMs
  if (isDirectMessageSurface(event)) return true;

  // For channel messages: only respond in threads where bot has participated
  if (event.thread_ts) {
    return botHasRepliedInThread(event.thread_ts);
  }

  // Bare channel message without @mention: ignore
  return false;
}
