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

  it('throws a safe error when the Cloud API request fails before a response', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('raw network detail with access-token'));
    const client = createWhatsAppClient({
      accessToken: 'access-token',
      phoneNumberId: 'phone-1',
      graphApiVersion: 'v23.0',
      fetchImpl,
    });

    let error: unknown;
    try {
      await client.sendText({
        surface: 'whatsapp',
        conversationId: 'whatsapp:15551234567',
        userId: '15551234567',
      }, 'Hello');
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('WhatsApp send failed before receiving a response');
    expect((error as Error).message).not.toContain('raw network detail');
  });

  it('throws a safe error when a successful Graph API response is malformed', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => {
        throw new Error('Unexpected token < in provider HTML');
      },
    });
    const client = createWhatsAppClient({
      accessToken: 'access-token',
      phoneNumberId: 'phone-1',
      graphApiVersion: 'v23.0',
      fetchImpl,
    });

    let error: unknown;
    try {
      await client.sendText({
        surface: 'whatsapp',
        conversationId: 'whatsapp:15551234567',
        userId: '15551234567',
      }, 'Hello');
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('WhatsApp send returned an unreadable response');
    expect((error as Error).message).not.toContain('Unexpected token');
  });

  it('sends a Cloud API interactive reply-button message', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ messages: [{ id: 'wamid.interactive' }] }),
    });
    const client = createWhatsAppClient({
      accessToken: 'access-token',
      phoneNumberId: 'phone-1',
      graphApiVersion: 'v23.0',
      fetchImpl,
    });

    const result = await client.sendInteractive({
      surface: 'whatsapp',
      conversationId: 'whatsapp:15551234567',
      userId: '15551234567',
    }, {
      kind: 'reply_buttons',
      body: 'Was this answer useful?',
      buttons: [
        { id: 'wa:v1:ok:ctx_ok', title: 'Looks right' },
        { id: 'wa:v1:problem:ctx_problem', title: 'Problem' },
      ],
    });

    expect(result).toEqual({ messageId: 'wamid.interactive' });
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://graph.facebook.com/v23.0/phone-1/messages',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: '15551234567',
          type: 'interactive',
          interactive: {
            type: 'button',
            body: { text: 'Was this answer useful?' },
            action: {
              buttons: [
                { type: 'reply', reply: { id: 'wa:v1:ok:ctx_ok', title: 'Looks right' } },
                { type: 'reply', reply: { id: 'wa:v1:problem:ctx_problem', title: 'Problem' } },
              ],
            },
          },
        }),
      }),
    );
  });

  it('sends a Cloud API interactive list message', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ messages: [{ id: 'wamid.list' }] }),
    });
    const client = createWhatsAppClient({
      accessToken: 'access-token',
      phoneNumberId: 'phone-1',
      graphApiVersion: 'v23.0',
      fetchImpl,
    });

    await client.sendInteractive({
      surface: 'whatsapp',
      conversationId: 'whatsapp:15551234567',
      userId: '15551234567',
    }, {
      kind: 'list',
      body: 'What would you like to see?',
      buttonText: 'Open actions',
      sections: [{
        title: 'Answer actions',
        rows: [{ id: 'wa:v1:show_sql:ctx_1', title: 'Show SQL' }],
      }],
    });

    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toMatchObject({
      type: 'interactive',
      interactive: {
        type: 'list',
        body: { text: 'What would you like to see?' },
        action: {
          button: 'Open actions',
          sections: [{
            title: 'Answer actions',
            rows: [{ id: 'wa:v1:show_sql:ctx_1', title: 'Show SQL' }],
          }],
        },
      },
    });
  });

  it('maps interactive fetch failures to a pre-response error', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('network connection dropped'));
    const client = createWhatsAppClient({
      accessToken: 'access-token',
      phoneNumberId: 'phone-1',
      graphApiVersion: 'v23.0',
      fetchImpl,
    });

    await expect(
      client.sendInteractive({
        surface: 'whatsapp',
        conversationId: 'whatsapp:15551234567',
        userId: '15551234567',
      }, {
        kind: 'reply_buttons',
        body: 'Was this answer useful?',
        buttons: [{ id: 'wa:v1:ok:ctx_ok', title: 'Looks right' }],
      }),
    ).rejects.toThrow('WhatsApp send failed before receiving a response');
  });

  it('maps malformed interactive payload responses to an unreadable-response error', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => {
        throw new Error('Unexpected token < in provider HTML');
      },
    });
    const client = createWhatsAppClient({
      accessToken: 'access-token',
      phoneNumberId: 'phone-1',
      graphApiVersion: 'v23.0',
      fetchImpl,
    });

    await expect(
      client.sendInteractive({
        surface: 'whatsapp',
        conversationId: 'whatsapp:15551234567',
        userId: '15551234567',
      }, {
        kind: 'reply_buttons',
        body: 'Was this answer useful?',
        buttons: [{ id: 'wa:v1:ok:ctx_ok', title: 'Looks right' }],
      }),
    ).rejects.toThrow('WhatsApp send returned an unreadable response');
  });

  it('rejects interactive messages with invalid reply-button payloads without fetching', async () => {
    const fetchImpl = vi.fn();
    const client = createWhatsAppClient({
      accessToken: 'access-token',
      phoneNumberId: 'phone-1',
      graphApiVersion: 'v23.0',
      fetchImpl,
    });

    await expect(
      client.sendInteractive({
        surface: 'whatsapp',
        conversationId: 'whatsapp:15551234567',
        userId: '15551234567',
      }, {
        kind: 'reply_buttons',
        body: 'Was this answer useful?',
        buttons: [
          { id: 'wa:v1:ok:ctx_ok', title: 'Looks right' },
          { id: 'wa:v1:problem:ctx_problem', title: 'Problem' },
          { id: 'wa:v1:actions:ctx_actions', title: 'Actions' },
          { id: 'wa:v1:show_sql:ctx_sql', title: 'Show SQL' },
        ],
      }),
    ).rejects.toThrow('Invalid WhatsApp interactive message');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects interactive list messages with no rows without fetching', async () => {
    const fetchImpl = vi.fn();
    const client = createWhatsAppClient({
      accessToken: 'access-token',
      phoneNumberId: 'phone-1',
      graphApiVersion: 'v23.0',
      fetchImpl,
    });

    await expect(
      client.sendInteractive({
        surface: 'whatsapp',
        conversationId: 'whatsapp:15551234567',
        userId: '15551234567',
      }, {
        kind: 'list',
        body: 'What would you like to see?',
        buttonText: 'Open actions',
        sections: [{
          title: 'Answer actions',
          rows: [],
        }],
      }),
    ).rejects.toThrow('Invalid WhatsApp interactive message');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects interactive reply-button messages with overlong button titles', async () => {
    const fetchImpl = vi.fn();
    const client = createWhatsAppClient({
      accessToken: 'access-token',
      phoneNumberId: 'phone-1',
      graphApiVersion: 'v23.0',
      fetchImpl,
    });

    await expect(
      client.sendInteractive({
        surface: 'whatsapp',
        conversationId: 'whatsapp:15551234567',
        userId: '15551234567',
      }, {
        kind: 'reply_buttons',
        body: 'Was this answer useful?',
        buttons: [
          { id: 'wa:v1:ok:ctx_ok', title: 'Looks right and extremely long' },
          { id: 'wa:v1:problem:ctx_problem', title: 'Problem' },
        ],
      }),
    ).rejects.toThrow('Invalid WhatsApp interactive message');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects interactive reply-button messages with duplicate titles', async () => {
    const fetchImpl = vi.fn();
    const client = createWhatsAppClient({
      accessToken: 'access-token',
      phoneNumberId: 'phone-1',
      graphApiVersion: 'v23.0',
      fetchImpl,
    });

    await expect(
      client.sendInteractive({
        surface: 'whatsapp',
        conversationId: 'whatsapp:15551234567',
        userId: '15551234567',
      }, {
        kind: 'reply_buttons',
        body: 'Was this answer useful?',
        buttons: [
          { id: 'wa:v1:ok:ctx_ok', title: 'Looks right' },
          { id: 'wa:v1:problem:ctx_problem', title: 'Looks right' },
        ],
      }),
    ).rejects.toThrow('Invalid WhatsApp interactive message');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects interactive list messages with overlong row title', async () => {
    const fetchImpl = vi.fn();
    const client = createWhatsAppClient({
      accessToken: 'access-token',
      phoneNumberId: 'phone-1',
      graphApiVersion: 'v23.0',
      fetchImpl,
    });

    await expect(
      client.sendInteractive({
        surface: 'whatsapp',
        conversationId: 'whatsapp:15551234567',
        userId: '15551234567',
      }, {
        kind: 'list',
        body: 'What would you like to see?',
        buttonText: 'Open actions',
        sections: [{
          title: 'Answer actions',
          rows: [{ id: 'wa:v1:show_sql:ctx_1', title: 'A row title that is definitely too long' }],
        }],
      }),
    ).rejects.toThrow('Invalid WhatsApp interactive message');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects interactive list messages with overlong row description', async () => {
    const fetchImpl = vi.fn();
    const client = createWhatsAppClient({
      accessToken: 'access-token',
      phoneNumberId: 'phone-1',
      graphApiVersion: 'v23.0',
      fetchImpl,
    });

    await expect(
      client.sendInteractive({
        surface: 'whatsapp',
        conversationId: 'whatsapp:15551234567',
        userId: '15551234567',
      }, {
        kind: 'list',
        body: 'What would you like to see?',
        buttonText: 'Open actions',
        sections: [{
          title: 'Answer actions',
          rows: [{
            id: 'wa:v1:show_sql:ctx_1',
            title: 'Show SQL',
            description:
              'This description is over the limit and should be considered invalid by the validator.',
          }],
        }],
      }),
    ).rejects.toThrow('Invalid WhatsApp interactive message');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
