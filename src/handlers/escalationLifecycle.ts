import type { WebClient } from '@slack/web-api';
import type { EscalationState } from '../types.js';
import {
  getAllPendingEscalations,
  claimReminder,
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
// One sweep at a time per instance; a slow sweep must not overlap the next tick.
let sweepInFlight = false;

/**
 * Most Slack actions (reminders + timeouts) one sweep performs. Due escalations
 * are handled most-overdue first and the rest roll to the next sweep, so a
 * backlog drains in order instead of starving later records (#54). With the
 * 10-minute Cloud Scheduler sweep this covers 600 due escalations an hour.
 */
export const MAX_SWEEP_ACTIONS = 100;

/** Reset throttle state — for testing only */
export function _resetThrottle(): void {
  lastCheckTime = 0;
  sweepInFlight = false;
}

/** Outcome of a single lifecycle sweep — returned for observability (e.g. the sweep endpoint). */
export interface LifecycleSweepResult {
  throttled: boolean;
  pending: number;   // awaiting_human escalations examined
  reminded: number;
  timedOut: number;
  deferred: number;  // due escalations left for the next sweep by MAX_SWEEP_ACTIONS
}

type DueAction = { kind: 'timeout' | 'remind'; esc: EscalationState; dueAt: number };

export async function checkOverdueEscalations(
  client: WebClient,
  config: EscalationConfig,
): Promise<LifecycleSweepResult> {
  if (sweepInFlight || Date.now() - lastCheckTime < CHECK_INTERVAL_MS) {
    return { throttled: true, pending: 0, reminded: 0, timedOut: 0, deferred: 0 };
  }
  lastCheckTime = Date.now();
  sweepInFlight = true;
  try {
    return await sweep(client, config);
  } finally {
    sweepInFlight = false;
  }
}

async function sweep(client: WebClient, config: EscalationConfig): Promise<LifecycleSweepResult> {
  const escalations = await getAllPendingEscalations();
  const result: LifecycleSweepResult = {
    throttled: false,
    pending: escalations.length,
    reminded: 0,
    timedOut: 0,
    deferred: 0,
  };
  if (escalations.length === 0) return result;

  const now = new Date();
  const reminderIntervalMs = config.reminderIntervalMinutes * 60000;
  const reminderThreshold = new Date(now.getTime() - reminderIntervalMs);

  // Only due records compete for the per-sweep budget, so not-yet-due ones can
  // never crowd out an overdue escalation. Expired first, then by how long ago
  // the reminder fell due.
  const due: DueAction[] = [];
  for (const esc of escalations) {
    if (esc.expiresAt < now) {
      due.push({ kind: 'timeout', esc, dueAt: esc.expiresAt.getTime() });
      continue;
    }
    // Overdue reminder: fall back to createdAt if no reminder sent yet
    const lastActionTime = esc.lastReminderAt || esc.createdAt;
    if (lastActionTime < reminderThreshold) {
      due.push({ kind: 'remind', esc, dueAt: lastActionTime.getTime() + reminderIntervalMs });
    }
  }
  due.sort((a, b) => (a.kind === b.kind ? a.dueAt - b.dueAt : a.kind === 'timeout' ? -1 : 1));
  result.deferred = Math.max(0, due.length - MAX_SWEEP_ACTIONS);

  for (const { kind, esc } of due.slice(0, MAX_SWEEP_ACTIONS)) {
    if (kind === 'timeout') {
      // Expired: mark timed_out and notify the user
      if (!await timeoutEscalation(esc.escalationId)) continue;
      await notifyEscalationTimeout(esc, client);
      result.timedOut += 1;
      continue;
    }

    // Claim before posting so an overlapping sweep cannot post the same reminder.
    if (!await claimReminder(esc.escalationId, reminderThreshold)) continue;
    try {
      await client.chat.postMessage({
        channel: esc.escalationChannel,
        thread_ts: esc.escalationTs,
        text: `Reminder: still waiting on "${esc.context.userQuestion}"`,
        blocks: buildEscalationReminderBlocks({
          escalationId: esc.escalationId,
          originalQuestion: esc.context.userQuestion,
          elapsed: formatElapsed(esc.createdAt),
        }),
      });
      result.reminded += 1;
    } catch (err) {
      // The claim stands, so this reminder waits one interval rather than
      // risking a duplicate; the rest of the sweep still runs.
      console.error(`Escalation reminder failed for ${esc.escalationId}:`, (err as Error).message);
    }
  }

  return result;
}
