import type { WebClient } from '@slack/web-api';
import {
  getAllPendingEscalations,
  updateReminderTime,
  timeoutEscalation,
} from '../state/escalationState.js';
import { buildEscalationReminderBlocks } from '../slack/escalationBlocks.js';
import { notifyEscalationTimeout } from '../slack/escalationTimeout.js';

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

/** Outcome of a single lifecycle sweep — returned for observability (e.g. the sweep endpoint). */
export interface LifecycleSweepResult {
  throttled: boolean;
  pending: number;   // awaiting_human escalations examined
  reminded: number;
  timedOut: number;
}

export async function checkOverdueEscalations(
  client: WebClient,
  config: EscalationConfig,
): Promise<LifecycleSweepResult> {
  if (Date.now() - lastCheckTime < CHECK_INTERVAL_MS) {
    return { throttled: true, pending: 0, reminded: 0, timedOut: 0 };
  }
  lastCheckTime = Date.now();

  const escalations = await getAllPendingEscalations();
  const result: LifecycleSweepResult = {
    throttled: false,
    pending: escalations.length,
    reminded: 0,
    timedOut: 0,
  };
  if (escalations.length === 0) return result;

  const now = new Date();

  for (const esc of escalations) {
    // Expired: mark timed_out and notify the user
    if (esc.expiresAt < now) {
      await timeoutEscalation(esc.escalationId);
      await notifyEscalationTimeout(esc, client);
      result.timedOut += 1;
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
      result.reminded += 1;
    }
  }

  return result;
}
