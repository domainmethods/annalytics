export type ConversationSurface = 'slack' | 'whatsapp';

export interface ConversationRef {
  surface: ConversationSurface;
  conversationId: string;
  userId: string;
}

export interface ChannelMessage {
  surface: ConversationSurface;
  providerMessageId: string;
  conversation: ConversationRef;
  text: string;
  receivedAt: Date;
}

export interface ChannelClient {
  sendText(conversation: ConversationRef, text: string): Promise<{ messageId: string }>;
  updateText?(messageId: string, text: string): Promise<void>;
  fetchContext?(conversation: ConversationRef, limit: number): Promise<ChannelMessage[]>;
}
