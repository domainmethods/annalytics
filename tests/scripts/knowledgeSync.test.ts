import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runKnowledgeSync } from '../../scripts/knowledgeSync.js';

async function writeReferenceCard(root: string): Promise<void> {
  await mkdir(join(root, 'references'), { recursive: true });
  await writeFile(join(root, 'references', 'revenue.yml'), `
reference_cards:
  - id: revenue-canonical-definition
    title: Canonical Revenue Definition
    domain: revenue
    grain: order
    canonical_table: analytics.fct_orders
    canonical_metric: total_amount
    aliases: [revenue]
    routing_triggers: [total revenue]
    owner: finance-analytics
    freshness_sla: daily
    updated: "2026-06-04"
`);
}

async function writeTeaching(root: string): Promise<void> {
  await mkdir(join(root, 'teachings'), { recursive: true });
  await writeFile(join(root, 'teachings', 'revenue.yml'), `
teachings:
  - id: revenue-monthly
    question_patterns: [monthly revenue]
    sanctioned_sql: null
    reasoning: Use completed orders.
    models_referenced: [analytics.fct_orders]
    tags: [revenue]
    author: finance
    updated: "2026-06-04"
`);
}

describe('runKnowledgeSync', () => {
  it('syncs reference cards to File Search and skips summary sync when project config is absent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'annalytics-knowledge-sync-'));
    await writeReferenceCard(root);
    const syncDocuments = vi.fn().mockResolvedValue({
      uploaded: 1,
      verified: 1,
      active: 1,
      deleted: 0,
      errors: [],
    });
    const persistTeachingSummaries = vi.fn();
    const logger = silentLogger();

    const result = await runKnowledgeSync({
      rootDir: root,
      env: {
        FILE_SEARCH_STORE_ID: 'fileSearchStores/revenue',
        GEMINI_API_KEY: 'gemini-key',
      },
      syncDocuments,
      persistTeachingSummaries,
      logger,
    });

    expect(syncDocuments).toHaveBeenCalledTimes(1);
    expect(syncDocuments.mock.calls[0][1]).toBe('fileSearchStores/revenue');
    expect(persistTeachingSummaries).not.toHaveBeenCalled();
    expect(logger.log).toHaveBeenCalledWith('Uploaded: 1, Verified: 1, Active: 1, Deleted: 0, Errors: 0');
    expect(logger.warn).toHaveBeenCalledWith('Skipping Firestore knowledge summary sync: GCP_PROJECT_ID is not set');
    expect(result.summarySync).toBe('skipped_no_project');
  });

  it('persists ReferenceCard summaries when project config is present', async () => {
    const root = await mkdtemp(join(tmpdir(), 'annalytics-knowledge-sync-'));
    await writeReferenceCard(root);
    const syncDocuments = vi.fn().mockResolvedValue({
      uploaded: 1,
      verified: 1,
      active: 1,
      deleted: 0,
      errors: [],
    });
    const persistKnowledgeSummaries = vi.fn();
    const logger = silentLogger();

    const result = await runKnowledgeSync({
      rootDir: root,
      env: {
        FILE_SEARCH_STORE_ID: 'fileSearchStores/revenue',
        GEMINI_API_KEY: 'gemini-key',
        GCP_PROJECT_ID: 'analytics-project',
      },
      syncDocuments,
      persistKnowledgeSummaries,
      logger,
    });

    expect(persistKnowledgeSummaries).toHaveBeenCalledTimes(1);
    expect(persistKnowledgeSummaries.mock.calls[0][0]).toBe('analytics-project');
    expect(persistKnowledgeSummaries.mock.calls[0][1][0]).toEqual(expect.objectContaining({
      kind: 'reference_card',
      id: 'revenue-canonical-definition',
      canonical_table: 'analytics.fct_orders',
    }));
    expect(logger.log).toHaveBeenCalledWith('Updated knowledge summary map: 1 entries');
    expect(result.summarySync).toBe('persisted');
  });

  it('warns instead of failing when optional Firestore summary sync fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'annalytics-knowledge-sync-'));
    await writeReferenceCard(root);
    await writeTeaching(root);
    const syncDocuments = vi.fn().mockResolvedValue({
      uploaded: 2,
      verified: 2,
      active: 2,
      deleted: 0,
      errors: [],
    });
    const persistKnowledgeSummaries = vi.fn().mockRejectedValue(new Error('Firestore API disabled'));
    const logger = silentLogger();

    const result = await runKnowledgeSync({
      rootDir: root,
      env: {
        FILE_SEARCH_STORE_ID: 'fileSearchStores/revenue',
        GEMINI_API_KEY: 'gemini-key',
        GCP_PROJECT_ID: 'analytics-project',
      },
      syncDocuments,
      persistKnowledgeSummaries,
      logger,
    });

    expect(syncDocuments).toHaveBeenCalledTimes(1);
    expect(persistKnowledgeSummaries).toHaveBeenCalledTimes(1);
    expect(result.summarySync).toBe('failed_optional');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Skipping Firestore knowledge summary sync'),
    );
  });

  it('fails when File Search sync counts do not converge', async () => {
    const root = await mkdtemp(join(tmpdir(), 'annalytics-knowledge-sync-'));
    await writeReferenceCard(root);
    const syncDocuments = vi.fn().mockResolvedValue({
      uploaded: 1,
      verified: 1,
      active: 0,
      deleted: 0,
      errors: [],
    });
    const persistKnowledgeSummaries = vi.fn();
    const logger = silentLogger();

    await expect(runKnowledgeSync({
      rootDir: root,
      env: {
        FILE_SEARCH_STORE_ID: 'fileSearchStores/revenue',
        GEMINI_API_KEY: 'gemini-key',
        GCP_PROJECT_ID: 'analytics-project',
      },
      syncDocuments,
      persistKnowledgeSummaries,
      logger,
    })).rejects.toThrow('File Search sync did not converge');

    expect(persistKnowledgeSummaries).not.toHaveBeenCalled();
  });

  it('still fails when required File Search config is missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'annalytics-knowledge-sync-'));
    await writeReferenceCard(root);

    await expect(runKnowledgeSync({
      rootDir: root,
      env: { GEMINI_API_KEY: 'gemini-key' },
      logger: silentLogger(),
    })).rejects.toThrow('Missing FILE_SEARCH_STORE_ID or GEMINI_API_KEY');
  });
});

function silentLogger() {
  return {
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}
