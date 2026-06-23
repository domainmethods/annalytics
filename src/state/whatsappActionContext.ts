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

function toDate(value: Date | FirestoreTimestamp | undefined): Date | undefined {
  if (value === undefined) return undefined;
  return value instanceof Date ? value : value.toDate();
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

  const data = doc.data() as Record<string, unknown>;
  return {
    id: doc.id,
    kind: String(data.kind),
    responseContextKey: String(data.responseContextKey),
    conversationId: String(data.conversationId),
    userId: String(data.userId),
    createdAt: toDate(data.createdAt as Date | FirestoreTimestamp)!,
    expiresAt: toDate(data.expiresAt as Date | FirestoreTimestamp)!,
  };
}

