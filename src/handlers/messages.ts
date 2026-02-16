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

export async function shouldRespond(event: MessageEvent): Promise<boolean> {
  // Always respond in DMs
  if (event.channel_type === 'im') return true;

  // For channel messages: only respond in threads where bot has participated
  if (event.thread_ts) {
    return botHasRepliedInThread(event.thread_ts);
  }

  // Bare channel message without @mention: ignore
  return false;
}
