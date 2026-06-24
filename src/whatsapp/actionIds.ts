export const WHATSAPP_ACTION_KINDS = [
  'ok',
  'problem',
  'actions',
  'reason_wrong_number',
  'reason_wrong_data',
  'reason_not_asked',
  'reason_other',
  'show_reasoning',
  'show_sql',
  'override_table',
  'override_summary',
] as const;

export type WhatsAppActionKind = typeof WHATSAPP_ACTION_KINDS[number];

const KIND_SET = new Set<string>(WHATSAPP_ACTION_KINDS);
const CONTEXT_ID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;

function isValidContextId(contextId: string): boolean {
  return CONTEXT_ID_PATTERN.test(contextId);
}

export function buildWhatsAppActionId(kind: WhatsAppActionKind, contextId: string): string {
  if (!isValidContextId(contextId)) {
    throw new Error('Invalid WhatsApp action context id');
  }
  return `wa:v1:${kind}:${contextId}`;
}

export function parseWhatsAppActionId(
  value: string,
): { kind: WhatsAppActionKind; contextId: string } | null {
  const parts = value.split(':');
  if (parts.length !== 4) return null;
  const [prefix, version, rawKind, contextId] = parts;
  if (
    prefix !== 'wa'
    || version !== 'v1'
    || !KIND_SET.has(rawKind)
    || !isValidContextId(contextId)
  ) {
    return null;
  }
  return { kind: rawKind as WhatsAppActionKind, contextId };
}
