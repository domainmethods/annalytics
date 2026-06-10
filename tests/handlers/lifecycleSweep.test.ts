import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response, Router } from 'express';
import type { WebClient } from '@slack/web-api';

vi.mock('../../src/handlers/escalationLifecycle.js', () => ({
  checkOverdueEscalations: vi.fn(),
}));

vi.mock('../../src/handlers/notificationDelivery.js', () => ({
  deliverPendingNotifications: vi.fn(),
}));

import { checkOverdueEscalations, type EscalationConfig } from '../../src/handlers/escalationLifecycle.js';
import { deliverPendingNotifications } from '../../src/handlers/notificationDelivery.js';
import { registerLifecycleSweep } from '../../src/handlers/lifecycleSweep.js';

const mockSweep = vi.mocked(checkOverdueEscalations);
const mockDeliverPendingNotifications = vi.mocked(deliverPendingNotifications);

const SWEEP_SECRET = 'test-sweep-secret-xyz';

const mockClient = { chat: {} } as unknown as WebClient;
const escalationConfig: EscalationConfig = {
  mode: 'channel',
  channelId: 'C123',
  reminderIntervalMinutes: 30,
  timeoutHours: 4,
};

function buildReq(overrides: Partial<{ headers: Record<string, string> }> = {}): Request {
  return {
    headers: { authorization: `Bearer ${SWEEP_SECRET}` },
    ...overrides,
  } as unknown as Request;
}

function buildRes(): { res: Response; status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> } {
  const json = vi.fn();
  const status = vi.fn(() => ({ json }));
  const res = { status, json } as unknown as Response;
  return { res, status, json };
}

// Capture the registered route handler
let routeHandler: (req: Request, res: Response) => Promise<void>;

const mockRouter = {
  post: vi.fn((path: string, handler: (req: Request, res: Response) => Promise<void>) => {
    if (path === '/api/lifecycle-sweep') {
      routeHandler = handler;
    }
  }),
} as unknown as Router;

describe('registerLifecycleSweep', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSweep.mockResolvedValue({ throttled: false, pending: 2, reminded: 1, timedOut: 0 });
    mockDeliverPendingNotifications.mockResolvedValue({ delivered: 0, failed: 0 });
    registerLifecycleSweep(mockRouter, SWEEP_SECRET, {
      getClient: () => mockClient,
      getEscalationConfig: () => escalationConfig,
    });
  });

  it('registers POST /api/lifecycle-sweep on the router', () => {
    expect(mockRouter.post).toHaveBeenCalledWith('/api/lifecycle-sweep', expect.any(Function));
  });

  describe('POST /api/lifecycle-sweep', () => {
    it('returns 401 when Authorization header is missing and does not sweep', async () => {
      const req = buildReq({ headers: {} });
      const { res, status, json } = buildRes();

      await routeHandler(req, res);

      expect(status).toHaveBeenCalledWith(401);
      expect(json).toHaveBeenCalledWith({ error: 'Unauthorized' });
      expect(mockSweep).not.toHaveBeenCalled();
    });

    it('returns 401 for a wrong secret of the same length', async () => {
      const wrongSameLength = SWEEP_SECRET.replace(/^./, SWEEP_SECRET[0] === 'x' ? 'y' : 'x');
      expect(wrongSameLength).toHaveLength(SWEEP_SECRET.length);
      const req = buildReq({ headers: { authorization: `Bearer ${wrongSameLength}` } });
      const { res, status, json } = buildRes();

      await routeHandler(req, res);

      expect(status).toHaveBeenCalledWith(401);
      expect(json).toHaveBeenCalledWith({ error: 'Unauthorized' });
      expect(mockSweep).not.toHaveBeenCalled();
    });

    it('returns 401 (no throw) for a header with equal string length but different byte length', async () => {
      // 'ÿ' (U+00FF) is 1 UTF-16 code unit but 2 UTF-8 bytes: string lengths match
      // `Bearer ${SWEEP_SECRET}`, byte lengths do not. A string-length pre-check would
      // let this reach timingSafeEqual with unequal buffers → RangeError → process crash.
      const sameStringLength = `Bearer ${SWEEP_SECRET.slice(0, -1)}ÿ`;
      expect(sameStringLength).toHaveLength(`Bearer ${SWEEP_SECRET}`.length);
      expect(Buffer.from(sameStringLength).length).not.toBe(Buffer.from(`Bearer ${SWEEP_SECRET}`).length);
      const req = buildReq({ headers: { authorization: sameStringLength } });
      const { res, status, json } = buildRes();

      await expect(routeHandler(req, res)).resolves.not.toThrow();

      expect(status).toHaveBeenCalledWith(401);
      expect(json).toHaveBeenCalledWith({ error: 'Unauthorized' });
      expect(mockSweep).not.toHaveBeenCalled();
    });

    it('returns 401 for a wrong secret of a different length', async () => {
      const req = buildReq({ headers: { authorization: 'Bearer short' } });
      const { res, status, json } = buildRes();

      await routeHandler(req, res);

      expect(status).toHaveBeenCalledWith(401);
      expect(json).toHaveBeenCalledWith({ error: 'Unauthorized' });
      expect(mockSweep).not.toHaveBeenCalled();
    });

    it('returns 200 with the sweep result and calls the sweep with injected deps', async () => {
      const req = buildReq();
      const { res, status, json } = buildRes();

      await routeHandler(req, res);

      expect(status).toHaveBeenCalledWith(200);
      expect(json).toHaveBeenCalledWith(
        expect.objectContaining({
          throttled: false,
          pending: 2,
          reminded: 1,
          timedOut: 0,
          notificationsDelivered: 0,
          notificationsFailed: 0,
        }),
      );
      expect(mockSweep).toHaveBeenCalledTimes(1);
      expect(mockSweep).toHaveBeenCalledWith(mockClient, escalationConfig);
    });

    it('delivers pending notifications and merges counts into the response', async () => {
      mockSweep.mockResolvedValueOnce({ throttled: false, pending: 0, reminded: 0, timedOut: 0 });
      mockDeliverPendingNotifications.mockResolvedValueOnce({ delivered: 2, failed: 1 });
      const req = buildReq();
      const { res, status, json } = buildRes();

      await routeHandler(req, res);

      expect(status).toHaveBeenCalledWith(200);
      expect(mockDeliverPendingNotifications).toHaveBeenCalledWith(mockClient);
      expect(json).toHaveBeenCalledWith(
        expect.objectContaining({
          notificationsDelivered: 2,
          notificationsFailed: 1,
        }),
      );
    });

    it('delivers notifications even when sweep is throttled', async () => {
      mockSweep.mockResolvedValueOnce({ throttled: true, pending: 0, reminded: 0, timedOut: 0 });
      mockDeliverPendingNotifications.mockResolvedValueOnce({ delivered: 1, failed: 0 });
      const req = buildReq();
      const { res, status, json } = buildRes();

      await routeHandler(req, res);

      expect(status).toHaveBeenCalledWith(200);
      expect(mockDeliverPendingNotifications).toHaveBeenCalledWith(mockClient);
      expect(json).toHaveBeenCalledWith(
        expect.objectContaining({
          throttled: true,
          notificationsDelivered: 1,
          notificationsFailed: 0,
        }),
      );
    });

    it('returns 500 with a generic error when notification delivery throws', async () => {
      mockSweep.mockResolvedValueOnce({ throttled: false, pending: 0, reminded: 0, timedOut: 0 });
      mockDeliverPendingNotifications.mockRejectedValueOnce(new Error('Firestore query failed'));
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const req = buildReq();
      const { res, status, json } = buildRes();

      await routeHandler(req, res);

      expect(status).toHaveBeenCalledWith(500);
      expect(json).toHaveBeenCalledWith({ error: 'Sweep failed' });
      consoleSpy.mockRestore();
    });

    it('returns 500 with a generic error when the sweep throws, leaking no internals', async () => {
      mockSweep.mockRejectedValueOnce(new Error('Firestore exploded at projects/secret-id/databases'));
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const req = buildReq();
      const { res, status, json } = buildRes();

      await routeHandler(req, res);

      expect(status).toHaveBeenCalledWith(500);
      expect(json).toHaveBeenCalledWith({ error: 'Sweep failed' });
      expect(json).toHaveBeenCalledTimes(1);
      consoleSpy.mockRestore();
    });
  });
});
