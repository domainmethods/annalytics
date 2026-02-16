import type { WebClient } from '@slack/web-api';
import {
  getAllPendingEscalations,
  updateReminderTime,
  timeoutEscalation,
} from '../state/escalationState.js';
import { buildEscalationReminderBlocks } from '../slack/escalationBlocks.js';

export interface EscalationConfig {
  mode: 'channel' | 'dm';
  channelId?: string;
  analystUserId?: string;
  reminderIntervalMinutes: number;
  timeoutHours: number;
}

function formatElapsed(createdAt: Date): string {
  const minutes = Math.floor((Date.now() - createdAt.getTime()) / 60000);
  if (minutes < 60) return `${minutes} minutes`;
  const hours = Math.floor(minutes / 60);
  return hours === 1 ? '1 hour' : `${hours} hours`;
}

// Throttle: run at most once per minute to avoid excessive Firestore reads
let lastCheckTime = 0;
const CHECK_INTERVAL_MS = 60_000;

/** Reset throttle state — for testing only */
export function _resetThrottle(): void {
  lastCheckTime = 0;
}

export async function checkOverdueEscalations(
  client: WebClient,
  config: EscalationConfig,
): Promise<void> {
  if (Date.now() - lastCheckTime < CHECK_INTERVAL_MS) return;
  lastCheckTime = Date.now();

  const escalations = await getAllPendingEscalations();
  if (escalations.length === 0) return;

  const now = new Date();

  for (const esc of escalations) {
    // Expired: mark timed_out and notify the user
    if (esc.expiresAt < now) {
      await timeoutEscalation(esc.escalationId);

      const text = esc.behavior === 'park_wait'
        ? "I wasn't able to get an answer from the data team in time. Try asking again or reach out directly."
        : "The data team hasn't weighed in yet, but the answer I showed earlier is my best estimate.";

      await client.chat.postMessage({
        channel: esc.originalChannel,
        thread_ts: esc.originalThreadTs,
        text,
      });
      continue;
    }

    // Overdue reminder: fall back to createdAt if no reminder sent yet
    const reminderThreshold = new Date(now.getTime() - config.reminderIntervalMinutes * 60000);
    const lastActionTime = esc.lastReminderAt || esc.createdAt;
    if (lastActionTime < reminderThreshold) {
      const blocks = buildEscalationReminderBlocks({
        escalationId: esc.escalationId,
        originalQuestion: esc.context.userQuestion,
        elapsed: formatElapsed(esc.createdAt),
      });

      await client.chat.postMessage({
        channel: esc.escalationChannel,
        thread_ts: esc.escalationTs,
        text: `Reminder: still waiting on "${esc.context.userQuestion}"`,
        blocks,
      });

      await updateReminderTime(esc.escalationId);
    }
  }
}
