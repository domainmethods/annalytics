import { timingSafeEqual } from 'node:crypto';
import type { Router, Request, Response } from 'express';
import type { WebClient } from '@slack/web-api';
import type { EscalationConfig } from './escalationLifecycle.js';
import { checkOverdueEscalations } from './escalationLifecycle.js';

/**
 * Registers POST /api/lifecycle-sweep — lets Cloud Scheduler drive escalation
 * reminders/timeouts on wall-clock time instead of piggybacking on Slack event traffic.
 *
 * Deps are getter-injected because the Slack WebClient doesn't exist until the
 * Bolt App is constructed, which happens after route registration in app.ts.
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
    // Auth check (timing-safe comparison)
    const authHeader = req.headers.authorization;
    const expected = `Bearer ${sweepSecret}`;
    if (!authHeader || authHeader.length !== expected.length ||
        !timingSafeEqual(Buffer.from(authHeader), Buffer.from(expected))) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    try {
      const result = await checkOverdueEscalations(deps.getClient(), deps.getEscalationConfig());
      res.status(200).json(result);
    } catch (err) {
      console.error('Lifecycle sweep failed:', (err as Error).message);
      res.status(500).json({ error: 'Sweep failed' });
    }
  });
}
