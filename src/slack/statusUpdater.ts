import type { WebClient } from '@slack/web-api';

export function createStatusUpdater(client: WebClient, channel: string, statusMsgTs: string) {
  return async (text: string): Promise<void> => {
    await client.chat.update({ channel, ts: statusMsgTs, text });
  };
}
