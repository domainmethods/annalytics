import { describe, expect, it, vi } from 'vitest';
import { createWhatsAppClient } from '../../src/whatsapp/client.js';

describe('createWhatsAppClient', () => {
  it('sends a Cloud API text message and returns the provider message id', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ messages: [{ id: 'wamid.outbound' }] }),
    });
    const client = createWhatsAppClient({
      accessToken: 'access-token',
      phoneNumberId: 'phone-1',
      graphApiVersion: 'v23.0',
      fetchImpl,
    });

    const result = await client.sendText({
      surface: 'whatsapp',
      conversationId: 'whatsapp:15551234567',
      userId: '15551234567',
    }, 'Hello');

    expect(result).toEqual({ messageId: 'wamid.outbound' });
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://graph.facebook.com/v23.0/phone-1/messages',
      expect.objectContaining({
        method: 'POST',
        headers: {
          Authorization: 'Bearer access-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: '15551234567',
          type: 'text',
          text: { body: 'Hello' },
        }),
      }),
    );
  });

  it('throws a safe error when Graph API returns a provider failure', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: { message: 'real provider detail' } }),
    });
    const client = createWhatsAppClient({
      accessToken: 'access-token',
      phoneNumberId: 'phone-1',
      graphApiVersion: 'v23.0',
      fetchImpl,
    });

    await expect(client.sendText({
      surface: 'whatsapp',
      conversationId: 'whatsapp:15551234567',
      userId: '15551234567',
    }, 'Hello')).rejects.toThrow('WhatsApp send failed with status 400');
  });
});
