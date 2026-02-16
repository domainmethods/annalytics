import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  saveDbtRunResults,
  getRunHistoryForModel,
  getLatestRun,
  getRecentFailures,
} from '../../src/state/dbtRunHistory.js';
import type { DbtRunHistoryEntry } from '../../src/state/dbtRunHistory.js';

const mockSet = vi.fn();
const mockGet = vi.fn();
const mockWhere = vi.fn();
const mockOrderBy = vi.fn();
const mockLimit = vi.fn();
const mockBatchSet = vi.fn();
const mockBatchCommit = vi.fn();

const mockDoc = vi.fn(() => ({ set: mockSet, get: mockGet }));

// Query chain: where/orderBy/limit all return objects with the same chaining methods + get
const chainable = () => ({
  where: mockWhere,
  orderBy: mockOrderBy,
  limit: mockLimit,
  get: mockGet,
});

vi.mock('../../src/state/firestore.js', () => ({
  getDb: vi.fn(() => ({
    collection: vi.fn(() => ({
      doc: mockDoc,
      where: mockWhere,
      orderBy: mockOrderBy,
      limit: mockLimit,
    })),
    batch: vi.fn(() => ({
      set: mockBatchSet,
      commit: mockBatchCommit,
    })),
  })),
}));

describe('dbtRunHistory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Set up chainable query methods for each test
    mockWhere.mockReturnValue(chainable());
    mockOrderBy.mockReturnValue(chainable());
    mockLimit.mockReturnValue(chainable());
    mockBatchCommit.mockResolvedValue(undefined);
  });

  describe('saveDbtRunResults + getRunHistoryForModel', () => {
    it('saves entries with batch write and retrieves them for a model', async () => {
      const entries: DbtRunHistoryEntry[] = [
        {
          model: 'dim_customers',
          status: 'success',
          executionTime: 12.5,
          runId: 'run-001',
          runStartedAt: new Date('2025-06-01T10:00:00Z'),
        },
        {
          model: 'fct_orders',
          status: 'error',
          executionTime: 3.2,
          runId: 'run-001',
          runStartedAt: new Date('2025-06-01T10:00:00Z'),
          errorMessage: 'Column not found',
        },
      ];

      await saveDbtRunResults(entries);

      // Batch write: one set call per entry
      expect(mockBatchSet).toHaveBeenCalledTimes(2);
      expect(mockBatchCommit).toHaveBeenCalledTimes(1);

      // First entry doc ID
      const firstCall = mockBatchSet.mock.calls[0];
      expect(firstCall[1]).toEqual(expect.objectContaining({
        model: 'dim_customers',
        status: 'success',
        executionTime: 12.5,
        runId: 'run-001',
        expiresAt: expect.any(Date),
      }));

      // Verify 90-day TTL
      const savedData = firstCall[1];
      const ttlMs = savedData.expiresAt.getTime() - Date.now();
      const ninetyDaysMs = 90 * 24 * 60 * 60 * 1000;
      // Allow 5 second tolerance for test execution time
      expect(ttlMs).toBeGreaterThan(ninetyDaysMs - 5000);
      expect(ttlMs).toBeLessThanOrEqual(ninetyDaysMs);

      // Now test retrieval
      const runStartedAt = new Date('2025-06-01T10:00:00Z');
      mockGet.mockResolvedValue({
        empty: false,
        docs: [{
          data: () => ({
            model: 'dim_customers',
            status: 'success',
            executionTime: 12.5,
            runId: 'run-001',
            runStartedAt: { toDate: () => runStartedAt },
          }),
        }],
      });

      const results = await getRunHistoryForModel('dim_customers');

      expect(mockWhere).toHaveBeenCalledWith('model', '==', 'dim_customers');
      expect(results).toHaveLength(1);
      expect(results[0].model).toBe('dim_customers');
      expect(results[0].runStartedAt).toBeInstanceOf(Date);
      expect(results[0].runStartedAt.getTime()).toBe(runStartedAt.getTime());
    });
  });

  describe('getRunHistoryForModel ordering', () => {
    it('returns model history in DESC order by runStartedAt', async () => {
      const date1 = new Date('2025-06-01T10:00:00Z');
      const date2 = new Date('2025-06-02T10:00:00Z');
      const date3 = new Date('2025-06-03T10:00:00Z');

      mockGet.mockResolvedValue({
        empty: false,
        docs: [
          { data: () => ({ model: 'dim_customers', status: 'success', executionTime: 10, runId: 'run-003', runStartedAt: { toDate: () => date3 } }) },
          { data: () => ({ model: 'dim_customers', status: 'success', executionTime: 11, runId: 'run-002', runStartedAt: { toDate: () => date2 } }) },
          { data: () => ({ model: 'dim_customers', status: 'error', executionTime: 5, runId: 'run-001', runStartedAt: { toDate: () => date1 }, errorMessage: 'failed' }) },
        ],
      });

      const results = await getRunHistoryForModel('dim_customers', 3);

      expect(mockOrderBy).toHaveBeenCalledWith('runStartedAt', 'desc');
      expect(mockLimit).toHaveBeenCalledWith(3);
      expect(results).toHaveLength(3);
      expect(results[0].runStartedAt.getTime()).toBe(date3.getTime());
      expect(results[1].runStartedAt.getTime()).toBe(date2.getTime());
      expect(results[2].runStartedAt.getTime()).toBe(date1.getTime());
    });
  });

  describe('getLatestRun', () => {
    it('returns all entries from the most recent runId', async () => {
      const latestDate = new Date('2025-06-03T10:00:00Z');

      // First query: get the latest entry to discover runId
      mockGet
        .mockResolvedValueOnce({
          empty: false,
          docs: [{
            data: () => ({
              model: 'dim_customers',
              status: 'success',
              executionTime: 10,
              runId: 'run-003',
              runStartedAt: { toDate: () => latestDate },
            }),
          }],
        })
        // Second query: get all entries with that runId
        .mockResolvedValueOnce({
          empty: false,
          docs: [
            { data: () => ({ model: 'dim_customers', status: 'success', executionTime: 10, runId: 'run-003', runStartedAt: { toDate: () => latestDate } }) },
            { data: () => ({ model: 'fct_orders', status: 'success', executionTime: 8, runId: 'run-003', runStartedAt: { toDate: () => latestDate } }) },
            { data: () => ({ model: 'stg_events', status: 'error', executionTime: 2, runId: 'run-003', runStartedAt: { toDate: () => latestDate }, errorMessage: 'timeout' }) },
          ],
        });

      const results = await getLatestRun();

      // First query: order by runStartedAt DESC, limit 1
      expect(mockOrderBy).toHaveBeenCalledWith('runStartedAt', 'desc');
      expect(mockLimit).toHaveBeenCalledWith(1);
      // Second query: where runId matches
      expect(mockWhere).toHaveBeenCalledWith('runId', '==', 'run-003');

      expect(results).toHaveLength(3);
      expect(results.every(r => r.runId === 'run-003')).toBe(true);
    });
  });

  describe('getRecentFailures', () => {
    it('returns only error entries within the specified timeframe', async () => {
      const recentDate = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000); // 2 days ago

      mockGet.mockResolvedValue({
        empty: false,
        docs: [
          { data: () => ({ model: 'dim_customers', status: 'error', executionTime: 5, runId: 'run-001', runStartedAt: { toDate: () => recentDate }, errorMessage: 'Column not found' }) },
          { data: () => ({ model: 'fct_orders', status: 'error', executionTime: 3, runId: 'run-002', runStartedAt: { toDate: () => recentDate }, errorMessage: 'Timeout' }) },
        ],
      });

      const results = await getRecentFailures(7);

      expect(mockWhere).toHaveBeenCalledWith('status', '==', 'error');
      expect(mockWhere).toHaveBeenCalledWith('runStartedAt', '>', expect.any(Date));
      expect(results).toHaveLength(2);
      expect(results.every(r => r.status === 'error')).toBe(true);
      expect(results[0].errorMessage).toBe('Column not found');
    });
  });

  describe('empty results', () => {
    it('returns empty arrays when no documents match', async () => {
      mockGet.mockResolvedValue({ empty: true, docs: [] });

      const modelHistory = await getRunHistoryForModel('nonexistent_model');
      expect(modelHistory).toEqual([]);

      mockGet.mockResolvedValue({ empty: true, docs: [] });
      const latestRun = await getLatestRun();
      expect(latestRun).toEqual([]);

      mockGet.mockResolvedValue({ empty: true, docs: [] });
      const failures = await getRecentFailures();
      expect(failures).toEqual([]);
    });
  });
});
