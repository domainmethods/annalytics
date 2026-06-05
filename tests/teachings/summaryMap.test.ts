import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildKnowledgeSummaries, buildSummaries, getKnowledgeSummaries, getTeachingSummaries, _resetCache } from '../../src/teachings/summaryMap.js';
import type { ReferenceCard } from '../../src/references/types.js';
import type { Teaching } from '../../src/teachings/types.js';

const mockGet = vi.fn();
vi.mock('../../src/state/firestore.js', () => ({
  getDb: vi.fn(() => ({
    doc: vi.fn(() => ({ get: mockGet })),
  })),
}));

const revenueTeaching: Teaching = {
  id: 'revenue-monthly',
  question_patterns: ['monthly revenue'],
  sanctioned_sql: 'SELECT 1',
  reasoning: 'Revenue always uses fct_orders with order_status = completed.\nNever include cancelled orders.',
  models_referenced: ['analytics.fct_orders'],
  tags: ['revenue', 'finance'],
  author: 'test',
  updated: '2026-02-10',
};

const churnTeaching: Teaching = {
  id: 'churn-definition',
  question_patterns: ['churn'],
  sanctioned_sql: null,
  reasoning: 'A customer is considered churned if no orders in 90 days.',
  models_referenced: ['analytics.dim_customers', 'analytics.fct_orders'],
  tags: ['churn', 'customers'],
  author: 'test',
  updated: '2026-02-10',
};

const revenueCard: ReferenceCard = {
  id: 'revenue-canonical-definition',
  title: 'Canonical Revenue Definition',
  domain: 'revenue',
  grain: 'order',
  canonical_table: 'analytics.fct_orders',
  canonical_metric: 'total_amount',
  required_filters: ["order_status = 'completed'"],
  exclusions: ['cancelled orders'],
  avoid_tables: [],
  aliases: ['revenue', 'sales'],
  routing_triggers: ['total revenue'],
  owner: 'finance',
  freshness_sla: 'daily',
  related_teachings: [],
  updated: '2026-06-04',
};

describe('buildSummaries', () => {
  it('extracts term, definition, and canonical_table from teachings', () => {
    const summaries = buildSummaries([revenueTeaching, churnTeaching]);

    expect(summaries).toHaveLength(2);
    expect(summaries[0]).toEqual({
      term: 'revenue',
      definition: 'Revenue always uses fct_orders with order_status = completed.',
      canonical_table: 'analytics.fct_orders',
    });
  });

  it('uses first tag as term', () => {
    const summaries = buildSummaries([churnTeaching]);

    expect(summaries[0].term).toBe('churn');
  });

  it('uses first model as canonical_table', () => {
    const summaries = buildSummaries([churnTeaching]);

    expect(summaries[0].canonical_table).toBe('analytics.dim_customers');
  });
});

describe('buildKnowledgeSummaries', () => {
  it('combines teaching and ReferenceCard summaries for intake classification', () => {
    const summaries = buildKnowledgeSummaries([revenueTeaching], [revenueCard]);

    expect(summaries).toEqual([
      {
        term: 'revenue',
        definition: 'Revenue always uses fct_orders with order_status = completed.',
        canonical_table: 'analytics.fct_orders',
        kind: 'teaching',
        id: 'revenue-monthly',
        aliases: ['monthly revenue'],
      },
      expect.objectContaining({
        term: 'Canonical Revenue Definition',
        canonical_table: 'analytics.fct_orders',
        canonical_metric: 'total_amount',
        kind: 'reference_card',
        id: 'revenue-canonical-definition',
        aliases: ['revenue', 'sales'],
        routing_triggers: ['total revenue'],
      }),
    ]);
  });
});

describe('getTeachingSummaries', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetCache();
  });

  it('returns cached summaries when lastUpdatedAt has not changed', async () => {
    const timestamp = new Date('2026-02-10');
    const summaries = [{ term: 'revenue', definition: 'def', canonical_table: 'tbl' }];

    mockGet.mockResolvedValue({
      exists: true,
      data: () => ({
        summaries,
        lastUpdatedAt: { toDate: () => timestamp },
      }),
    });

    const first = await getTeachingSummaries();
    const second = await getTeachingSummaries();

    expect(first).toEqual(summaries);
    expect(second).toEqual(summaries);
    expect(mockGet).toHaveBeenCalledTimes(2);
  });

  it('refreshes cache when Firestore has newer lastUpdatedAt', async () => {
    const oldTimestamp = new Date('2026-02-10');
    const newTimestamp = new Date('2026-02-12');
    const oldSummaries = [{ term: 'old', definition: 'old def', canonical_table: 'old_tbl' }];
    const newSummaries = [{ term: 'new', definition: 'new def', canonical_table: 'new_tbl' }];

    mockGet.mockResolvedValueOnce({
      exists: true,
      data: () => ({
        summaries: oldSummaries,
        lastUpdatedAt: { toDate: () => oldTimestamp },
      }),
    });

    const first = await getTeachingSummaries();
    expect(first).toEqual(oldSummaries);

    mockGet.mockResolvedValueOnce({
      exists: true,
      data: () => ({
        summaries: newSummaries,
        lastUpdatedAt: { toDate: () => newTimestamp },
      }),
    });

    const second = await getTeachingSummaries();
    expect(second).toEqual(newSummaries);
  });

  it('falls back to legacy teaching summaries when knowledge summaries are absent', async () => {
    const timestamp = new Date('2026-02-10');
    const summaries = [{ term: 'revenue', definition: 'def', canonical_table: 'tbl' }];

    mockGet
      .mockResolvedValueOnce({ exists: false })
      .mockResolvedValueOnce({
        exists: true,
        data: () => ({
          summaries,
          lastUpdatedAt: { toDate: () => timestamp },
        }),
      });

    await expect(getKnowledgeSummaries()).resolves.toEqual(summaries);
  });
});
