import { timingSafeEqual } from 'node:crypto';
import type { Router, Request, Response } from 'express';
import type { WebClient } from '@slack/web-api';
import type { EscalationConfig } from './escalationLifecycle.js';
import { checkOverdueEscalations } from './escalationLifecycle.js';
import { deliverPendingNotifications } from './notificationDelivery.js';

/**
 * Registers POST /api/lifecycle-sweep — lets Cloud Scheduler drive escalation
 * reminders/timeouts on wall-clock time instead of piggybacking on Slack event traffic.
 *
 * Deps are getter-injected because the Slack WebClient doesn't exist until the
 * Bolt App is constructed, so this route is registered after App construction
 * in app.ts; getter injection keeps the dependency lazy regardless of ordering.
 *
 * Note: `throttled: true` in the response means "no information" (the shared
 * 60s throttle skipped the sweep), not "zero pending".
 */
export function registerLifecycleSweep(
  router: Router,
  sweepSecret: string,
  deps: { getClient: () => WebClient; getEscalationConfig: () => EscalationConfig },
): void {
  router.post('/api/lifecycle-sweep', async (req: Request, res: Response) => {
    // Auth check (timing-safe comparison). Compare byte lengths, not string lengths:
    // a multi-byte char (e.g. 'ÿ') can match the string length while Buffer.from()
    // yields a different byte length, and timingSafeEqual throws on unequal buffers.
    const provided = Buffer.from(req.headers.authorization ?? '');
    const expected = Buffer.from(`Bearer ${sweepSecret}`);
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    try {
      const client = deps.getClient();
      const result = await checkOverdueEscalations(client, deps.getEscalationConfig());
      const notificationResult = await deliverPendingNotifications(client);
      res.status(200).json({
        ...result,
        notificationsDelivered: notificationResult.delivered,
        notificationsFailed: notificationResult.failed,
      });
    } catch (err) {
      console.error('Lifecycle sweep failed:', (err as Error).message);
      res.status(500).json({ error: 'Sweep failed' });
    }
  });
}
