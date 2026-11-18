import type { AddressInfo } from 'node:net';
import { ExpressReceiver } from '@slack/bolt';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerDbtRunIngestion } from '../../src/handlers/dbtRunIngestion.js';
import { saveDbtRunResults } from '../../src/state/dbtRunHistory.js';

vi.mock('../../src/state/dbtRunHistory.js', () => ({
  saveDbtRunResults: vi.fn().mockResolvedValue(undefined),
}));

const WEBHOOK_SECRET = 'test-webhook-secret';
const BODY_LIMIT_BYTES = 5 * 1024 * 1024;
const artifact = JSON.stringify({
  metadata: {
    generated_at: '2026-02-15T10:00:00Z',
    invocation_id: 'synthetic-run',
  },
  results: [{ unique_id: 'model.example.orders', status: 'success', execution_time: 1.25 }],
});

describe('POST /api/dbt-run-results through ExpressReceiver', () => {
  const receiver = new ExpressReceiver({ signingSecret: 'test-signing-secret' });
  let endpoint: string;

  beforeAll(async () => {
    registerDbtRunIngestion(receiver.router, WEBHOOK_SECRET);
    const server = await receiver.start({ host: '127.0.0.1', port: 0 });
    const { port } = server.address() as AddressInfo;
    endpoint = `http://127.0.0.1:${port}/api/dbt-run-results`;
  });

  afterAll(() => receiver.stop());
  beforeEach(() => vi.clearAllMocks());

  function post(body: string, authorization = `Bearer ${WEBHOOK_SECRET}`) {
    return fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization },
      body,
      signal: AbortSignal.timeout(3_000),
    });
  }

  it('ingests a valid artifact at the 5 MiB limit', async () => {
    const response = await post(artifact.padEnd(BODY_LIMIT_BYTES, ' '));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ processed: 1 });
    expect(saveDbtRunResults).toHaveBeenCalledExactlyOnceWith([
      expect.objectContaining({
        model: 'orders',
        executionTime: 1.25,
        runId: 'synthetic-run',
        runStartedAt: new Date('2026-02-15T10:00:00Z'),
      }),
    ]);
  });

  it('returns a safe 400 for malformed JSON', async () => {
    const response = await post('{"metadata":');

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Invalid run_results.json format' });
    expect(saveDbtRunResults).not.toHaveBeenCalled();
  });

  it('returns a safe 400 when a result is missing its unique ID', async () => {
    const response = await post(JSON.stringify({
      metadata: { generated_at: '2026-02-15T10:00:00Z' },
      results: [{ status: 'success', execution_time: 1.25 }],
    }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Invalid run_results.json format' });
    expect(saveDbtRunResults).not.toHaveBeenCalled();
  });

  it('returns 401 before parsing a request with an invalid token', async () => {
    const response = await post('{"metadata":', 'Bearer wrong-token');

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'Unauthorized' });
    expect(saveDbtRunResults).not.toHaveBeenCalled();
  });

  it('returns a safe 413 for an artifact above the 5 MiB limit', async () => {
    const response = await post(artifact.padEnd(BODY_LIMIT_BYTES + 1, ' '));

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: 'run_results.json payload too large' });
    expect(saveDbtRunResults).not.toHaveBeenCalled();
  });
});
