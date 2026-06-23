import { randomUUID } from 'node:crypto';
import { getDb } from './firestore.js';

const COLLECTION = 'whatsapp_action_context';
const RETENTION_MS = 24 * 60 * 60 * 1000;

type FirestoreTimestamp = { toDate: () => Date };

export interface CreateWhatsAppActionContextInput {
  kind: string;
  responseContextKey: string;
  conversationId: string;
  userId: string;
  idFactory?: () => string;
}

export interface StoredWhatsAppActionContext {
  id: string;
  kind: string;
  responseContextKey: string;
  conversationId: string;
  userId: string;
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

export async function createWhatsAppActionContext(
  input: CreateWhatsAppActionContextInput,
): Promise<string> {
  const id = input.idFactory?.() ?? randomUUID();
  const now = new Date();
  await getDb()
    .collection(COLLECTION)
    .doc(id)
    .set({
      kind: input.kind,
      responseContextKey: input.responseContextKey,
      conversationId: input.conversationId,
      userId: input.userId,
      createdAt: now,
      expiresAt: new Date(now.getTime() + RETENTION_MS),
    });

  return id;
}

export async function getWhatsAppActionContext(
  id: string,
): Promise<StoredWhatsAppActionContext | null> {
  const doc = await getDb().collection(COLLECTION).doc(id).get();
  if (!doc.exists) return null;

  const data = doc.data();
  if (!isRecord(data)) return null;
  if (
    typeof data.kind !== 'string'
    || typeof data.responseContextKey !== 'string'
    || typeof data.conversationId !== 'string'
    || typeof data.userId !== 'string'
  ) {
    return null;
  }

  const createdAt = toDate(data.createdAt);
  const expiresAt = toDate(data.expiresAt);
  if (createdAt === null || expiresAt === null) return null;
  if (expiresAt.getTime() <= Date.now()) return null;

  return {
    id: doc.id,
    kind: data.kind,
    responseContextKey: data.responseContextKey,
    conversationId: data.conversationId,
    userId: data.userId,
    createdAt,
    expiresAt,
  };
}
