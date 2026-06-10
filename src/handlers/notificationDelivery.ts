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

function notificationText(n: PendingNotification): string {
  return n.userId
    ? `✅ <@${n.userId}> your feedback on this answer was reviewed by the data team and is now part of my knowledge. Future answers to questions like this will use it.`
    : '✅ An update from the data team: the guidance from this thread is now part of my knowledge. Future answers to questions like this will use it.';
}

/**
 * Drains the pending_notifications queue: posts each to its originating thread,
 * marking delivered only after the post succeeds. A failed post leaves the doc
 * pending for the next sweep — at-least-once delivery, deduplicated by the
 * idempotent notif_<candidateId> doc id at enqueue time.
 */
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
