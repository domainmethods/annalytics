import { getDb, FieldValue } from './firestore.js';

const PENDING_SLACK_EVENT_TTL_MS = 30_000;
const VISIBLE_SLACK_EVENT_TTL_MS = 24 * 60 * 60 * 1000;
const ALREADY_EXISTS = 6;

export function extractSlackEventId(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const eventId = (body as { event_id?: unknown }).event_id;
  return typeof eventId === 'string' && eventId.length > 0 ? eventId : undefined;
}

function eventDocId(eventId: string): string {
  return encodeURIComponent(eventId);
}

function eventRef(eventId: string) {
  return getDb().collection('slack_event_dedupe').doc(eventDocId(eventId));
}

function toDate(value: unknown): Date | undefined {
  if (value instanceof Date) return value;
  if (
    typeof value === 'object'
    && value !== null
    && typeof (value as { toDate?: unknown }).toDate === 'function'
  ) {
    return (value as { toDate: () => Date }).toDate();
  }
  return undefined;
}

export async function claimSlackEvent(eventId: string | undefined): Promise<boolean> {
  if (!eventId) return true;

  const ref = eventRef(eventId);
  try {
    await ref.create({
      eventId,
      state: 'pending',
      seenAt: FieldValue.serverTimestamp(),
      expiresAt: new Date(Date.now() + PENDING_SLACK_EVENT_TTL_MS),
    });
    return true;
  } catch (e: any) {
    if (e.code === ALREADY_EXISTS) {
      const doc = await ref.get();
      const expiresAt = doc.exists ? toDate(doc.data()?.expiresAt) : undefined;
      if (!doc.exists || (expiresAt && expiresAt < new Date())) {
        if (doc.exists) await ref.delete();
        return claimSlackEvent(eventId);
      }
      return false;
    }
    throw e;
  }
}

export async function markSlackEventVisible(eventId: string | undefined): Promise<void> {
  if (!eventId) return;

  await eventRef(eventId).set({
    state: 'visible',
    visibleAt: FieldValue.serverTimestamp(),
    expiresAt: new Date(Date.now() + VISIBLE_SLACK_EVENT_TTL_MS),
  }, { merge: true });
}

export async function releaseSlackEventClaim(eventId: string | undefined): Promise<void> {
  if (!eventId) return;

  await eventRef(eventId).delete();
}
