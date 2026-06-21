import type { ChannelClient } from '../channels/types.js';

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

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : null;
}

function firstMessageId(payload: unknown): string | null {
  const root = asRecord(payload);
  const messages = Array.isArray(root?.messages) ? root.messages : [];
  const firstMessage = asRecord(messages[0]);
  return typeof firstMessage?.id === 'string' ? firstMessage.id : null;
}

export function createWhatsAppClient(config: WhatsAppClientConfig): ChannelClient {
  const fetchImpl = config.fetchImpl ?? globalThis.fetch;
  const url = `https://graph.facebook.com/${config.graphApiVersion}/${config.phoneNumberId}/messages`;

  return {
    async sendText(conversation, text) {
      const response = await fetchImpl(url, {
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
      });

      if (!response.ok) {
        throw new Error(`WhatsApp send failed with status ${response.status ?? 'unknown'}`);
      }

      const messageId = firstMessageId(await response.json());
      if (!messageId) {
        throw new Error('WhatsApp send succeeded without a message id');
      }

      return { messageId };
    },
  };
}
