import { timingSafeEqual } from 'node:crypto';
import type { Router, Request, Response } from 'express';
import type { DbtRunHistoryEntry } from '../state/dbtRunHistory.js';
import { saveDbtRunResults } from '../state/dbtRunHistory.js';

function mapStatus(status: string): DbtRunHistoryEntry['status'] {
  if (status === 'pass') return 'success';
  if (status === 'fail' || status === 'error') return 'error';
  return 'skipped';
}

export function registerDbtRunIngestion(router: Router, webhookSecret: string): void {
  router.post('/api/dbt-run-results', async (req: Request, res: Response) => {
    // 1. Auth check (timing-safe comparison)
    const authHeader = req.headers.authorization;
    const expected = `Bearer ${webhookSecret}`;
    if (!authHeader || authHeader.length !== expected.length ||
        !timingSafeEqual(Buffer.from(authHeader), Buffer.from(expected))) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    // 2. Validate body
    const { metadata, results } = req.body || {};
    if (!Array.isArray(results) || !metadata?.generated_at) {
      res.status(400).json({ error: 'Invalid run_results.json format' });
      return;
    }

    // 3. Parse each result into DbtRunHistoryEntry
    const runStartedAt = new Date(metadata.generated_at as string);
    const runId = (metadata.invocation_id as string) || (metadata.generated_at as string);

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
