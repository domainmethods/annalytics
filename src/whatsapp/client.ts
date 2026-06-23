import type { ChannelClient, ConversationRef } from '../channels/types.js';
import type { WhatsAppInteractiveMessage } from './interactive.js';

interface WhatsAppClientConfig {
  accessToken: string;
  phoneNumberId: string;
  graphApiVersion: string;
  fetchImpl?: FetchImpl;
}

interface FetchResponse {
  ok: boolean;
  status?: number;
  json(): Promise<unknown>;
}

type FetchImpl = (url: string, init: {
  method: 'POST';
  headers: Record<string, string>;
  body: string;
}) => Promise<FetchResponse>;

export interface WhatsAppClient extends ChannelClient {
  sendInteractive(
    conversation: ConversationRef,
    message: WhatsAppInteractiveMessage,
  ): Promise<{ messageId: string }>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : null;
}

function firstMessageId(payload: unknown): string | null {
  const root = asRecord(payload);
  const messages = Array.isArray(root?.messages) ? root.messages : [];
  const firstMessage = asRecord(messages[0]);
  return typeof firstMessage?.id === 'string' ? firstMessage.id : null;
}

function interactivePayload(message: WhatsAppInteractiveMessage): Record<string, unknown> {
  if (message.kind === 'reply_buttons') {
    return {
      type: 'button',
      body: { text: message.body },
      ...(message.footer ? { footer: { text: message.footer } } : {}),
      action: {
        buttons: message.buttons.map((button) => ({
          type: 'reply',
          reply: { id: button.id, title: button.title },
        })),
      },
    };
  }

  return {
    type: 'list',
    body: { text: message.body },
    ...(message.footer ? { footer: { text: message.footer } } : {}),
    action: {
      button: message.buttonText,
      sections: message.sections.map((section) => ({
        title: section.title,
        rows: section.rows.map((row) => ({
          id: row.id,
          title: row.title,
          ...(row.description ? { description: row.description } : {}),
        })),
      })),
    },
  };
}

function withErrorHandling(operation: () => Promise<FetchResponse>): Promise<{ messageId: string }> {
  let response: FetchResponse;
  return operation()
    .then(async (result) => {
      response = result;
      if (!response.ok) {
        throw new Error(`WhatsApp send failed with status ${response.status ?? 'unknown'}`);
      }
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw new Error('WhatsApp send returned an unreadable response');
      }

      const messageId = firstMessageId(payload);
      if (!messageId) {
        throw new Error('WhatsApp send succeeded without a message id');
      }

      return { messageId };
    })
    .catch((error) => {
      if (error instanceof Error && error.message.startsWith('WhatsApp send failed with status')) {
        throw error;
      }
      if (error instanceof Error && error.message.startsWith('WhatsApp send returned an unreadable response')) {
        throw error;
      }
      if (error instanceof Error && error.message === 'WhatsApp send succeeded without a message id') {
        throw error;
      }
      throw new Error('WhatsApp send failed before receiving a response');
    });
}

export function createWhatsAppClient(config: WhatsAppClientConfig): WhatsAppClient {
  const fetchImpl = config.fetchImpl ?? globalThis.fetch;
  const url = `https://graph.facebook.com/${config.graphApiVersion}/${config.phoneNumberId}/messages`;

  return {
    async sendText(conversation, text) {
      return withErrorHandling(() => fetchImpl(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: conversation.userId,
          type: 'text',
          text: { body: text },
        }),
      }));
    },
    async sendInteractive(conversation, message) {
      return withErrorHandling(() => fetchImpl(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: conversation.userId,
          type: 'interactive',
          interactive: interactivePayload(message),
        }),
      }));
    },
  };
}
