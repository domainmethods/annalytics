import { describe, expect, it } from 'vitest';
import { parseWhatsAppWebhookPayload } from '../../src/whatsapp/payload.js';

const textPayload = {
  object: 'whatsapp_business_account',
  entry: [{
    id: 'waba-1',
    changes: [{
      field: 'messages',
      value: {
        messaging_product: 'whatsapp',
        metadata: {
          display_phone_number: '15550000000',
          phone_number_id: 'phone-1',
        },
        contacts: [{
          profile: { name: 'Ada' },
          wa_id: '15551234567',
        }],
        messages: [{
          from: '15551234567',
          id: 'wamid.1',
          timestamp: '1780000000',
          type: 'text',
          text: { body: 'Show revenue yesterday' },
        }],
      },
    }],
  }],
};

describe('parseWhatsAppWebhookPayload', () => {
  it('normalizes text messages for the configured phone number', () => {
    const result = parseWhatsAppWebhookPayload(textPayload, 'phone-1');

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toMatchObject({
      surface: 'whatsapp',
      providerMessageId: 'wamid.1',
      text: 'Show revenue yesterday',
      conversation: {
        surface: 'whatsapp',
        conversationId: 'whatsapp:15551234567',
        userId: '15551234567',
      },
    });
    expect(result.messages[0].receivedAt.toISOString()).toBe('2026-05-28T20:26:40.000Z');
    expect(result.unsupported).toEqual([]);
  });

  it('ignores status-only payloads', () => {
    const result = parseWhatsAppWebhookPayload({
      object: 'whatsapp_business_account',
      entry: [{
        changes: [{
          field: 'messages',
          value: {
            metadata: { phone_number_id: 'phone-1' },
            statuses: [{ id: 'wamid.status', status: 'delivered' }],
          },
        }],
      }],
    }, 'phone-1');

    expect(result.messages).toEqual([]);
    expect(result.unsupported).toEqual([]);
  });

  it('ignores payloads for another phone number id', () => {
    const result = parseWhatsAppWebhookPayload(textPayload, 'phone-2');
    expect(result.messages).toEqual([]);
    expect(result.unsupported).toEqual([]);
  });

  it('preserves numeric timestamps when providers send numbers', () => {
    const payload = structuredClone(textPayload);
    payload.entry[0].changes[0].value.messages[0].timestamp = 1780000000 as any;

    const result = parseWhatsAppWebhookPayload(payload, 'phone-1');

    expect(result.messages[0].receivedAt).toEqual(new Date(1780000000 * 1000));
  });

  it('returns unsupported notices for non-text inbound messages', () => {
    const payload = structuredClone(textPayload);
    payload.entry[0].changes[0].value.messages[0] = {
      from: '15551234567',
      id: 'wamid.image',
      timestamp: '1780000000',
      type: 'image',
      image: { id: 'media-1' },
    } as any;

    const result = parseWhatsAppWebhookPayload(payload, 'phone-1');

    expect(result.messages).toEqual([]);
    expect(result.unsupported).toEqual([{
      providerMessageId: 'wamid.image',
      conversation: {
        surface: 'whatsapp',
        conversationId: 'whatsapp:15551234567',
        userId: '15551234567',
      },
      receivedAt: new Date(1780000000 * 1000),
      type: 'image',
    }]);
  });

  it('parses interactive button replies as actions', () => {
    const payload = structuredClone(textPayload);
    payload.entry[0].changes[0].value.messages[0] = {
      from: '15551234567',
      id: 'wamid.button',
      timestamp: '1780000000',
      type: 'interactive',
      interactive: {
        type: 'button_reply',
        button_reply: { id: 'wa:v1:ok:ctx_ok', title: 'Looks right' },
      },
    } as any;

    const result = parseWhatsAppWebhookPayload(payload, 'phone-1');

    expect(result.messages).toEqual([]);
    expect(result.unsupported).toEqual([]);
    expect(result.actions).toEqual([{
      providerMessageId: 'wamid.button',
      conversation: {
        surface: 'whatsapp',
        conversationId: 'whatsapp:15551234567',
        userId: '15551234567',
      },
      receivedAt: new Date(1780000000 * 1000),
      actionId: 'wa:v1:ok:ctx_ok',
      actionTitle: 'Looks right',
      kind: 'button_reply',
    }]);
  });

  it('parses interactive list replies as actions', () => {
    const payload = structuredClone(textPayload);
    payload.entry[0].changes[0].value.messages[0] = {
      from: '15551234567',
      id: 'wamid.list',
      timestamp: '1780000000',
      type: 'interactive',
      interactive: {
        type: 'list_reply',
        list_reply: { id: 'wa:v1:show_sql:ctx_sql', title: 'Show SQL' },
      },
    } as any;

    const result = parseWhatsAppWebhookPayload(payload, 'phone-1');

    expect(result.actions).toEqual([expect.objectContaining({
      providerMessageId: 'wamid.list',
      actionId: 'wa:v1:show_sql:ctx_sql',
      actionTitle: 'Show SQL',
      kind: 'list_reply',
    })]);
  });
});
