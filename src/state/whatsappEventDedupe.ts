import { getDb, FieldValue } from './firestore.js';

const PENDING_WHATSAPP_EVENT_TTL_MS = 30_000;
const ALREADY_EXISTS = 6;

function eventDocId(eventId: string): string {
  return `whatsapp:${encodeURIComponent(eventId)}`;
}

function eventRef(eventId: string) {
  return getDb().collection('whatsapp_event_dedupe').doc(eventDocId(eventId));
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

export async function claimWhatsAppEvent(eventId: string): Promise<boolean> {
  const ref = eventRef(eventId);
  try {
    await ref.create({
      eventId,
      state: 'pending',
      seenAt: FieldValue.serverTimestamp(),
      expiresAt: new Date(Date.now() + PENDING_WHATSAPP_EVENT_TTL_MS),
    });
    return true;
  } catch (e: any) {
    if (e.code === ALREADY_EXISTS) {
      const doc = await ref.get();
      const expiresAt = doc.exists ? toDate(doc.data()?.expiresAt) : undefined;
      if (!doc.exists || (expiresAt && expiresAt < new Date())) {
        if (doc.exists) await ref.delete();
        return claimWhatsAppEvent(eventId);
      }
      return false;
    }
    throw e;
  }
}

export async function releaseWhatsAppEventClaim(eventId: string): Promise<void> {
  await eventRef(eventId).delete();
}
