import type { Query, QueryDocumentSnapshot } from '@google-cloud/firestore';

/**
 * Slack timestamps are unique only within a conversation, so thread state is
 * identified by the conversation (channel) together with the thread timestamp.
 * WhatsApp uses its conversation id for both.
 */

/** Document key for state keyed directly by thread (e.g. the thread lock). */
export function conversationThreadKey(channel: string, threadTs: string): string {
  return `${channel}:${threadTs}`;
}

/** Page size for {@link findOwnedDoc}'s scan over same-timestamp candidates. */
export const THREAD_SCOPE_PAGE_SIZE = 20;

/**
 * True only when a record names this conversation. Legacy records without an
 * owner never match, so they can't leak into another conversation.
 */
export function ownedByConversation(owner: unknown, channel: string): boolean {
  return owner === channel;
}

/**
 * First document of `query` (in its order) whose `ownerField` names the
 * conversation. `owner` may list several equivalent identifiers for one
 * conversation (a Slack DM is addressable by its D… id or the other user's id).
 *
 * Pages through every candidate rather than stopping at a fixed limit: guards
 * (pending clarification/escalation, participation) must not miss their own
 * conversation's state behind foreign or legacy records sharing the timestamp.
 * Uses only the query's existing filters and ordering, so no new index.
 * Deliberately uncapped: every query filters on one thread timestamp, so the
 * candidate set is one thread's records, and a cap would reintroduce misses.
 */
export async function findOwnedDoc(
  query: Query,
  ownerField: string,
  owner: string | readonly string[],
): Promise<QueryDocumentSnapshot | null> {
  const owners: readonly string[] = typeof owner === 'string' ? [owner] : owner;
  let page = query.limit(THREAD_SCOPE_PAGE_SIZE);
  for (;;) {
    const snapshot = await page.get();
    const doc = snapshot.docs.find(d => owners.some(o => ownedByConversation(d.data()[ownerField], o)));
    if (doc) return doc;
    if (snapshot.docs.length < THREAD_SCOPE_PAGE_SIZE) return null;
    page = query.startAfter(snapshot.docs[snapshot.docs.length - 1]).limit(THREAD_SCOPE_PAGE_SIZE);
  }
}
