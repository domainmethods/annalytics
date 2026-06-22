import crypto from 'node:crypto';

export interface VerifyWhatsAppSignatureInput {
  appSecret: string;
  rawBody: Buffer;
  signatureHeader?: string;
}

export function verifyWhatsAppSignature(input: VerifyWhatsAppSignatureInput): boolean {
  if (!input.signatureHeader?.startsWith('sha256=')) return false;
  const providedHex = input.signatureHeader.slice('sha256='.length);
  if (!/^[a-f0-9]{64}$/i.test(providedHex)) return false;

  const expected = crypto
    .createHmac('sha256', input.appSecret)
    .update(input.rawBody)
    .digest('hex');

  const provided = Buffer.from(providedHex, 'hex');
  const expectedBuffer = Buffer.from(expected, 'hex');
  if (provided.length !== expectedBuffer.length) return false;

  return crypto.timingSafeEqual(provided, expectedBuffer);
}
