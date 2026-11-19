import { timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import express, { type Router, type Request, type Response } from 'express';
import type { DbtRunHistoryEntry } from '../state/dbtRunHistory.js';
import { saveDbtRunResults } from '../state/dbtRunHistory.js';

function mapStatus(status: string): DbtRunHistoryEntry['status'] {
  if (status === 'success' || status === 'pass') return 'success';
  if (status === 'no-op' || status === 'reused') return status;
  if (status === 'warn') return 'warn';
  if (status === 'skipped') return 'skipped';
  // Failed, partially completed, and unknown or missing outcomes must remain visible in failure queries.
  return 'error';
}

export function registerDbtRunIngestion(router: Router, webhookSecret: string): void {
  const parseJson = promisify(express.json({ limit: '5mb' }));

  router.post('/api/dbt-run-results', async (req: Request, res: Response) => {
    // 1. Auth check (timing-safe comparison). Compare byte lengths, not string lengths:
    // a multi-byte char (e.g. 'ÿ') can match the string length while Buffer.from()
    // yields a different byte length, and timingSafeEqual throws on unequal buffers.
    const provided = Buffer.from(req.headers.authorization ?? '');
    const expected = Buffer.from(`Bearer ${webhookSecret}`);
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    // 2. Parse and validate the body. Bolt only parses requests on its Slack endpoint.
    try {
      await parseJson(req, res);
    } catch (err) {
      const status = (err as { status?: number }).status ?? 400;
      res.status(status).json({
        error: status === 413 ? 'run_results.json payload too large' : 'Invalid run_results.json format',
      });
      return;
    }

    const { metadata, results } = req.body || {};
    const generatedAt = metadata?.generated_at;
    if (
      typeof generatedAt !== 'string' || !generatedAt ||
      !Array.isArray(results) ||
      results.some((result) => typeof result?.unique_id !== 'string')
    ) {
      res.status(400).json({ error: 'Invalid run_results.json format' });
      return;
    }

    // 3. Parse each result into DbtRunHistoryEntry
    const runStartedAt = new Date(generatedAt);
    const runId = (metadata.invocation_id as string) || generatedAt;

    const entries: DbtRunHistoryEntry[] = results.map((result: Record<string, unknown>) => {
      const uniqueId = result.unique_id as string;
      const model = uniqueId.split('.').pop()!;
      const mappedStatus = mapStatus(result.status as string);

      const entry: DbtRunHistoryEntry = {
        model,
        status: mappedStatus,
        executionTime: result.execution_time as number,
        runId,
        runStartedAt,
      };

      if (mappedStatus === 'error' && result.message) {
        entry.errorMessage = result.message as string;
      }

      return entry;
    });

    // 4. Persist
    try {
      await saveDbtRunResults(entries);
    } catch (err) {
      console.error('Failed to persist dbt run results:', (err as Error).message);
      res.status(500).json({ error: 'Failed to persist run results' });
      return;
    }

    // 5. Respond
    res.status(200).json({ processed: entries.length });
  });
}
