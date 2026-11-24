import { botHasRepliedInThread } from '../state/responseContext.js';
import { claimClarificationState } from '../state/clarificationState.js';

interface MessageEvent {
  channel_type?: string;
  thread_ts?: string;
  text?: string;
}

export interface ClarificationReply {
  clarifiedQuestion: string;
  /** The user's wording plus their answer, for supervisor review (#44). */
  originalQuestion: string;
  channel: string;
  threadTs: string;
  clarifyingMessageTs: string;
  /** The questions that were asked. Absent when the saved state did not keep them. */
  clarifyingQuestions?: string[];
}

/**
 * Check if a message in a thread is a reply to a pending clarification, and
 * take the clarification if so. Returns its context, or null when there is
 * none to take: only one reply gets it, so a second reply that arrives at the
 * same moment is handled as an ordinary thread message.
 */
export async function checkClarificationReply(
  event: MessageEvent & { channel: string },
): Promise<ClarificationReply | null> {
  const threadTs = event.thread_ts;
  if (!threadTs) return null;

  const state = await claimClarificationState(event.channel, threadTs);
  if (!state) return null;

  // Merge user reply into clarified question
  const answer = ` (Clarification: ${event.text || ''})`;
  const clarifiedQuestion = `${state.originalQuestion}${answer}`;
  // Legacy docs (and unrewritten questions) carry no separate user wording.
  const originalQuestion = `${state.supervisorQuestion ?? state.originalQuestion}${answer}`;

  return {
    clarifiedQuestion,
    originalQuestion,
    channel: event.channel,
    threadTs,
    clarifyingMessageTs: state.clarifyingMessageTs,
    clarifyingQuestions: state.clarifyingQuestions,
  };
}

function isDirectMessageSurface(event: MessageEvent): boolean {
  return event.channel_type === 'im' || event.channel_type === 'mpim';
}

export function canMessageEventReachPipeline(event: MessageEvent): boolean {
  return isDirectMessageSurface(event) || Boolean(event.thread_ts);
}

export async function shouldRespond(event: MessageEvent & { channel: string }): Promise<boolean> {
  // Always respond in DMs
  if (isDirectMessageSurface(event)) return true;

  // For channel messages: only respond in threads where bot has participated
  if (event.thread_ts) {
    return botHasRepliedInThread(event.channel, event.thread_ts);
  }

  // Bare channel message without @mention: ignore
  return false;
}
