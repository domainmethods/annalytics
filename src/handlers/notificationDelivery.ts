import type { WebClient } from '@slack/web-api';
import {
  getPendingNotifications,
  markNotificationDelivered,
  type PendingNotification,
} from '../state/pendingNotifications.js';

export interface NotificationDeliveryResult {
  delivered: number;
  failed: number;
}

function notificationText(notification: PendingNotification): string {
  if (notification.userId) {
    return `Heads up <@${notification.userId}>: your feedback was reviewed and is now part of my knowledge.`;
  }

  return 'Heads up: guidance from this thread is now part of my knowledge.';
}

export async function deliverPendingNotifications(
  client: WebClient,
): Promise<NotificationDeliveryResult> {
  const notifications = await getPendingNotifications();
  const result: NotificationDeliveryResult = { delivered: 0, failed: 0 };

  for (const notification of notifications) {
    try {
      await client.chat.postMessage({
        channel: notification.channel,
        thread_ts: notification.threadTs,
        text: notificationText(notification),
      });

      await markNotificationDelivered(notification.id);
      result.delivered += 1;
    } catch {
      result.failed += 1;
    }
  }

  return result;
}
