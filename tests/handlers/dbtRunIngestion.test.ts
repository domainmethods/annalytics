import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response, Router } from 'express';

vi.mock('../../src/state/dbtRunHistory.js', () => ({
  saveDbtRunResults: vi.fn().mockResolvedValue(undefined),
}));

import { saveDbtRunResults } from '../../src/state/dbtRunHistory.js';
import { registerDbtRunIngestion } from '../../src/handlers/dbtRunIngestion.js';

const mockSave = vi.mocked(saveDbtRunResults);

const WEBHOOK_SECRET = 'test-secret-abc123';

function buildReq(overrides: Partial<{ headers: Record<string, string>; body: unknown }> = {}): Request {
  return {
    headers: { authorization: `Bearer ${WEBHOOK_SECRET}` },
    body: {
      metadata: {
        generated_at: '2026-02-15T10:00:00Z',
        invocation_id: 'run_abc123',
      },
      results: [
        {
          unique_id: 'model.project.dim_customers',
          status: 'pass',
          execution_time: 12.5,
          message: '',
        },
        {
          unique_id: 'model.project.fct_orders',
          status: 'fail',
          execution_time: 3.2,
          message: 'Database error: relation does not exist',
        },
      ],
    },
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
    if (path === '/api/dbt-run-results') {
      routeHandler = handler;
    }
  }),
} as unknown as Router;

describe('registerDbtRunIngestion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registerDbtRunIngestion(mockRouter, WEBHOOK_SECRET);
  });

  it('registers POST /api/dbt-run-results on the router', () => {
    expect(mockRouter.post).toHaveBeenCalledWith('/api/dbt-run-results', expect.any(Function));
  });

  describe('POST /api/dbt-run-results', () => {
    it('returns 200 with processed count for a valid request', async () => {
      const req = buildReq();
      const { res, status, json } = buildRes();

      await routeHandler(req, res);

      expect(status).toHaveBeenCalledWith(200);
      expect(json).toHaveBeenCalledWith({ processed: 2 });
      expect(mockSave).toHaveBeenCalledTimes(1);
    });

    it('returns 401 when Authorization header is missing', async () => {
      const req = buildReq({ headers: {} });
      const { res, status, json } = buildRes();

      await routeHandler(req, res);

      expect(status).toHaveBeenCalledWith(401);
      expect(json).toHaveBeenCalledWith({ error: 'Unauthorized' });
      expect(mockSave).not.toHaveBeenCalled();
    });

    it('returns 401 when Bearer token is invalid', async () => {
      const req = buildReq({ headers: { authorization: 'Bearer wrong-token' } });
      const { res, status, json } = buildRes();

      await routeHandler(req, res);

      expect(status).toHaveBeenCalledWith(401);
      expect(json).toHaveBeenCalledWith({ error: 'Unauthorized' });
      expect(mockSave).not.toHaveBeenCalled();
    });

    it('returns 401 (no throw) for a header with equal string length but different byte length', async () => {
      // 'ÿ' (U+00FF) is 1 UTF-16 code unit but 2 UTF-8 bytes: string lengths match
      // `Bearer ${WEBHOOK_SECRET}`, byte lengths do not. A string-length pre-check would
      // let this reach timingSafeEqual with unequal buffers → RangeError → process crash.
      const sameStringLength = `Bearer ${WEBHOOK_SECRET.slice(0, -1)}ÿ`;
      expect(sameStringLength).toHaveLength(`Bearer ${WEBHOOK_SECRET}`.length);
      expect(Buffer.from(sameStringLength).length).not.toBe(Buffer.from(`Bearer ${WEBHOOK_SECRET}`).length);
      const req = buildReq({ headers: { authorization: sameStringLength } });
      const { res, status, json } = buildRes();

      await expect(routeHandler(req, res)).resolves.not.toThrow();

      expect(status).toHaveBeenCalledWith(401);
      expect(json).toHaveBeenCalledWith({ error: 'Unauthorized' });
      expect(mockSave).not.toHaveBeenCalled();
    });

    it('returns 401 when Authorization header uses wrong scheme', async () => {
      const req = buildReq({ headers: { authorization: `Basic ${WEBHOOK_SECRET}` } });
      const { res, status, json } = buildRes();

      await routeHandler(req, res);

      expect(status).toHaveBeenCalledWith(401);
      expect(json).toHaveBeenCalledWith({ error: 'Unauthorized' });
      expect(mockSave).not.toHaveBeenCalled();
    });

    it('returns 400 when body is missing results array', async () => {
      const req = buildReq({
        body: {
          metadata: { generated_at: '2026-02-15T10:00:00Z', invocation_id: 'run_abc123' },
        },
      });
      const { res, status, json } = buildRes();

      await routeHandler(req, res);

      expect(status).toHaveBeenCalledWith(400);
      expect(json).toHaveBeenCalledWith({ error: 'Invalid run_results.json format' });
      expect(mockSave).not.toHaveBeenCalled();
    });

    it('returns 400 when body is missing metadata.generated_at', async () => {
      const req = buildReq({
        body: {
          metadata: {},
          results: [{ unique_id: 'model.project.dim_customers', status: 'pass', execution_time: 1.0 }],
        },
      });
      const { res, status, json } = buildRes();

      await routeHandler(req, res);

      expect(status).toHaveBeenCalledWith(400);
      expect(json).toHaveBeenCalledWith({ error: 'Invalid run_results.json format' });
      expect(mockSave).not.toHaveBeenCalled();
    });

    it('correctly parses run_results.json — model name extraction, status mapping, fields', async () => {
      const req = buildReq({
        body: {
          metadata: {
            generated_at: '2026-02-15T10:00:00Z',
            invocation_id: 'run_xyz789',
          },
          results: [
            {
              unique_id: 'model.my_project.dim_customers',
              status: 'pass',
              execution_time: 12.5,
              message: '',
            },
            {
              unique_id: 'model.my_project.fct_orders',
              status: 'fail',
              execution_time: 3.2,
              message: 'Database error: relation does not exist',
            },
            {
              unique_id: 'model.my_project.stg_events',
              status: 'error',
              execution_time: 0.1,
              message: 'Compilation error',
            },
            {
              unique_id: 'model.my_project.dim_products',
              status: 'warn',
              execution_time: 5.0,
              message: '',
            },
          ],
        },
      });
      const { res, status } = buildRes();

      await routeHandler(req, res);

      expect(status).toHaveBeenCalledWith(200);
      expect(mockSave).toHaveBeenCalledTimes(1);

      const entries = mockSave.mock.calls[0][0];
      expect(entries).toHaveLength(4);

      // Model name extraction from unique_id (last segment after '.')
      expect(entries[0].model).toBe('dim_customers');
      expect(entries[1].model).toBe('fct_orders');
      expect(entries[2].model).toBe('stg_events');
      expect(entries[3].model).toBe('dim_products');

      // Status mapping: 'pass' → 'success', 'fail'/'error' → 'error', else → 'skipped'
      expect(entries[0].status).toBe('success');
      expect(entries[1].status).toBe('error');
      expect(entries[2].status).toBe('error');
      expect(entries[3].status).toBe('skipped');

      // executionTime
      expect(entries[0].executionTime).toBe(12.5);
      expect(entries[1].executionTime).toBe(3.2);

      // runStartedAt — Date from metadata.generated_at
      expect(entries[0].runStartedAt).toEqual(new Date('2026-02-15T10:00:00Z'));

      // runId derived from invocation_id
      expect(entries[0].runId).toBe('run_xyz789');
      expect(entries[1].runId).toBe('run_xyz789');

      // errorMessage only when status is error
      expect(entries[0].errorMessage).toBeUndefined();
      expect(entries[1].errorMessage).toBe('Database error: relation does not exist');
      expect(entries[2].errorMessage).toBe('Compilation error');
      expect(entries[3].errorMessage).toBeUndefined();
    });

    it('returns 500 when Firestore persist fails', async () => {
      mockSave.mockRejectedValueOnce(new Error('Firestore unavailable'));
      const req = buildReq();
      const { res, status, json } = buildRes();

      await routeHandler(req, res);

      expect(status).toHaveBeenCalledWith(500);
      expect(json).toHaveBeenCalledWith({ error: 'Failed to persist run results' });
    });

    it('uses generated_at for runId when invocation_id is missing', async () => {
      const req = buildReq({
        body: {
          metadata: {
            generated_at: '2026-02-15T10:00:00Z',
          },
          results: [
            {
              unique_id: 'model.project.dim_customers',
              status: 'pass',
              execution_time: 1.0,
              message: '',
            },
          ],
        },
      });
      const { res, status } = buildRes();

      await routeHandler(req, res);

      expect(status).toHaveBeenCalledWith(200);
      const entries = mockSave.mock.calls[0][0];
      expect(entries[0].runId).toBe('2026-02-15T10:00:00Z');
    });
  });
});
