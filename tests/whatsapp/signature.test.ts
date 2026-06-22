import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyWhatsAppSignature } from '../../src/whatsapp/signature.js';

function sign(secret: string, body: Buffer): string {
  return `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;
}

describe('verifyWhatsAppSignature', () => {
  it('accepts a valid Meta signature', () => {
    const body = Buffer.from('{"object":"whatsapp_business_account"}');
    expect(verifyWhatsAppSignature({
      appSecret: 'app-secret',
      rawBody: body,
      signatureHeader: sign('app-secret', body),
    })).toBe(true);
  });

  it('rejects a missing signature', () => {
    expect(verifyWhatsAppSignature({
      appSecret: 'app-secret',
      rawBody: Buffer.from('{}'),
      signatureHeader: undefined,
    })).toBe(false);
  });

  it('rejects a signature with the wrong secret', () => {
    const body = Buffer.from('{"a":1}');
    expect(verifyWhatsAppSignature({
      appSecret: 'app-secret',
      rawBody: body,
      signatureHeader: sign('other-secret', body),
    })).toBe(false);
  });

  it('rejects a malformed signature without throwing', () => {
    expect(verifyWhatsAppSignature({
      appSecret: 'app-secret',
      rawBody: Buffer.from('{}'),
      signatureHeader: 'sha256=not-hex',
    })).toBe(false);
  });
});
