import type { ChannelMessage, ConversationRef } from '../channels/types.js';
import { whatsappConversationId } from './keys.js';

export interface UnsupportedWhatsAppMessage {
  providerMessageId: string;
  conversation: ConversationRef;
  receivedAt: Date;
  type: string;
}

export interface WhatsAppInteractiveAction {
  providerMessageId: string;
  conversation: ConversationRef;
  receivedAt: Date;
  actionId: string;
  actionTitle: string;
  kind: 'button_reply' | 'list_reply';
}

export interface ParsedWhatsAppWebhook {
  messages: ChannelMessage[];
  unsupported: UnsupportedWhatsAppMessage[];
  actions: WhatsAppInteractiveAction[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : null;
}

function getEntries(payload: unknown): unknown[] {
  const root = asRecord(payload);
  return Array.isArray(root?.entry) ? root.entry : [];
}

function getChanges(entry: unknown): unknown[] {
  const record = asRecord(entry);
  return Array.isArray(record?.changes) ? record.changes : [];
}

function toReceivedAt(timestamp: unknown): Date {
  const seconds = typeof timestamp === 'number'
    ? timestamp
    : typeof timestamp === 'string'
      ? Number(timestamp)
      : NaN;
  return Number.isFinite(seconds) ? new Date(seconds * 1000) : new Date();
}

function conversationForWaId(waId: string): ConversationRef {
  return {
    surface: 'whatsapp',
    conversationId: whatsappConversationId(waId),
    userId: waId,
  };
}

export function parseWhatsAppWebhookPayload(
  payload: unknown,
  configuredPhoneNumberId: string,
): ParsedWhatsAppWebhook {
  const parsed: ParsedWhatsAppWebhook = { messages: [], unsupported: [], actions: [] };

  for (const entry of getEntries(payload)) {
    for (const change of getChanges(entry)) {
      const changeRecord = asRecord(change);
      const value = asRecord(changeRecord?.value);
      const metadata = asRecord(value?.metadata);
      if (metadata?.phone_number_id !== configuredPhoneNumberId) continue;

      const messages = Array.isArray(value?.messages) ? value.messages : [];
      for (const rawMessage of messages) {
        const message = asRecord(rawMessage);
        if (!message) continue;
        const from = typeof message?.from === 'string' ? message.from : '';
        const id = typeof message?.id === 'string' ? message.id : '';
        const type = typeof message?.type === 'string' ? message.type : '';
        if (!from || !id || !type) continue;

        const conversation = conversationForWaId(from);
        const receivedAt = toReceivedAt(message.timestamp);
        if (type === 'interactive') {
          const interactive = asRecord(message.interactive);
          const interactiveType = typeof interactive?.type === 'string' ? interactive.type : '';
          if (interactiveType === 'button_reply' || interactiveType === 'list_reply') {
            const payload = asRecord(interactive?.[interactiveType]);
            const actionId = typeof payload?.id === 'string' ? payload.id : '';
            const actionTitle = typeof payload?.title === 'string' ? payload.title : '';
            if (actionId) {
              parsed.actions.push({
                providerMessageId: id,
                conversation,
                receivedAt,
                actionId,
                actionTitle,
                kind: interactiveType,
              });
            } else {
              parsed.unsupported.push({
                providerMessageId: id,
                conversation,
                receivedAt,
                type: `interactive:${interactiveType}`,
              });
            }
          } else {
            parsed.unsupported.push({
              providerMessageId: id,
              conversation,
              receivedAt,
              type: interactiveType ? `interactive:${interactiveType}` : 'interactive',
            });
          }
          continue;
        }

        if (type !== 'text') {
          parsed.unsupported.push({ providerMessageId: id, conversation, receivedAt, type });
          continue;
        }

        const text = asRecord(message.text);
        const body = typeof text?.body === 'string' ? text.body.trim() : '';
        if (!body) continue;

        parsed.messages.push({
          surface: 'whatsapp',
          providerMessageId: id,
          conversation,
          text: body,
          receivedAt,
        });
      }
    }
  }

  return parsed;
}
