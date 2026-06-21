import { describe, expect, it } from 'vitest';
import {
  whatsappConversationId,
  whatsappDedupeId,
  whatsappClarificationId,
  whatsappResponseContextId,
} from '../../src/whatsapp/keys.js';

describe('whatsapp key helpers', () => {
  it('prefixes conversation ids with the WhatsApp surface', () => {
    expect(whatsappConversationId('15551234567')).toBe('whatsapp:15551234567');
  });

  it('encodes provider message ids for dedupe docs', () => {
    expect(whatsappDedupeId('wamid.A/B+C=')).toBe('whatsapp:wamid.A%2FB%2BC%3D');
  });

  it('uses a surface-qualified clarification id', () => {
    expect(whatsappClarificationId('15551234567')).toBe('clarify_whatsapp:15551234567');
  });

  it('uses outbound message id for response context when available', () => {
    expect(whatsappResponseContextId({
      waId: '15551234567',
      inboundProviderMessageId: 'inbound-1',
      outboundMessageId: 'outbound/A+B=',
    })).toBe('whatsapp:15551234567_outbound%2FA%2BB%3D');
  });

  it('falls back to inbound provider message id for response context', () => {
    expect(whatsappResponseContextId({
      waId: '15551234567',
      inboundProviderMessageId: 'inbound/A+B=',
    })).toBe('whatsapp:15551234567_inbound%2FA%2BB%3D');
  });

  it('matches the state-layer WhatsApp response context document id format', () => {
    const waId = '15551234567';
    const outboundMessageId = 'outbound/A+B=';

    expect(whatsappResponseContextId({
      waId,
      inboundProviderMessageId: 'inbound-1',
      outboundMessageId,
    })).toBe(`whatsapp:${waId}_${encodeURIComponent(outboundMessageId)}`);
  });
});
