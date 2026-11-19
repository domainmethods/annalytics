/**
 * Slack timestamps are unique only within a conversation, so thread state is
 * identified by the conversation (channel) together with the thread timestamp.
 * WhatsApp uses its conversation id for both.
 */

/** Document key for state keyed directly by thread (e.g. the thread lock). */
export function conversationThreadKey(channel: string, threadTs: string): string {
  return `${channel}:${threadTs}`;
}

/**
 * How many same-timestamp candidates a thread lookup reads before filtering by
 * conversation. Timestamp collisions across conversations are rare, so this only
 * has to outlast a handful of foreign records; a miss is a safe "no state".
 */
export const THREAD_SCOPE_SCAN_LIMIT = 20;

/**
 * True only when a record names this conversation. Legacy records without an
 * owner never match, so they can't leak into another conversation.
 */
export function ownedByConversation(owner: unknown, channel: string): boolean {
  return owner === channel;
}
