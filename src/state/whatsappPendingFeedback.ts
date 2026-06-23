import { getDb } from './firestore.js';

const COLLECTION = 'whatsapp_pending_feedback_notes';
const RETENTION_MS = 30 * 60 * 1000;

type FirestoreTimestamp = { toDate: () => Date };

export interface SaveWhatsAppPendingFeedbackInput {
  conversationId: string;
  userId: string;
  responseContextKey: string;
  traceId: string;
  clarifiedQuestion?: string;
}

export interface WhatsAppPendingFeedback extends SaveWhatsAppPendingFeedbackInput {
  createdAt: Date;
  expiresAt: Date;
}

function toDate(value: unknown): Date | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (
    typeof value === 'object'
    && value !== null
    && 'toDate' in value
    && typeof (value as { toDate?: unknown }).toDate === 'function'
  ) {
    const candidate = (value as FirestoreTimestamp).toDate();
    return candidate instanceof Date && Number.isFinite(candidate.getTime()) ? candidate : null;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

export async function saveWhatsAppPendingFeedback(
  input: SaveWhatsAppPendingFeedbackInput,
): Promise<void> {
  const now = new Date();
  const payload = {
    conversationId: input.conversationId,
    userId: input.userId,
    responseContextKey: input.responseContextKey,
    traceId: input.traceId,
    ...(input.clarifiedQuestion ? { clarifiedQuestion: input.clarifiedQuestion } : {}),
    createdAt: now,
    expiresAt: new Date(now.getTime() + RETENTION_MS),
  };

  await getDb().collection(COLLECTION).doc(input.conversationId).set(payload);
}

export async function getWhatsAppPendingFeedback(
  conversationId: string,
): Promise<WhatsAppPendingFeedback | null> {
  const doc = await getDb().collection(COLLECTION).doc(conversationId).get();
  if (!doc.exists) return null;

  const data = doc.data();
  if (!isRecord(data)) return null;
  if (
    typeof data.conversationId !== 'string'
    || typeof data.userId !== 'string'
    || typeof data.responseContextKey !== 'string'
    || typeof data.traceId !== 'string'
  ) {
    return null;
  }
  if (data.clarifiedQuestion !== undefined && typeof data.clarifiedQuestion !== 'string') {
    return null;
  }

  const createdAt = toDate(data.createdAt);
  const expiresAt = toDate(data.expiresAt);
  if (createdAt === null || expiresAt === null) return null;
  if (expiresAt.getTime() <= Date.now()) return null;

  return {
    conversationId: data.conversationId,
    userId: data.userId,
    responseContextKey: data.responseContextKey,
    traceId: data.traceId,
    ...(data.clarifiedQuestion ? { clarifiedQuestion: data.clarifiedQuestion } : {}),
    createdAt,
    expiresAt,
  };
}

export async function deleteWhatsAppPendingFeedback(conversationId: string): Promise<void> {
  await getDb().collection(COLLECTION).doc(conversationId).delete();
}
