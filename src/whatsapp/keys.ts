export function whatsappConversationId(waId: string): string {
  return `whatsapp:${waId}`;
}

export function whatsappDedupeId(providerMessageId: string): string {
  return `whatsapp:${encodeURIComponent(providerMessageId)}`;
}

export function whatsappClarificationId(waId: string): string {
  return `clarify_whatsapp:${waId}`;
}

export function whatsappResponseContextId(input: {
  waId: string;
  inboundProviderMessageId: string;
  outboundMessageId?: string;
}): string {
  const messageId = input.outboundMessageId ?? input.inboundProviderMessageId;
  return `whatsapp:${input.waId}_${encodeURIComponent(messageId)}`;
}
