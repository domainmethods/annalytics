import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  getCachedSchema,
  cacheSchema,
} from '../../src/state/informationSchemaCache.js';
import type { TableContext } from '../../src/dbt/types.js';

const mockDoc = vi.fn();
const mockSet = vi.fn();
const mockGet = vi.fn();

vi.mock('../../src/state/firestore.js', () => ({
  getDb: vi.fn(() => ({
    collection: vi.fn(() => ({
      doc: mockDoc,
    })),
  })),
}));

const sampleTable: TableContext = {
  name: 'raw_dataset.raw_events',
  schema: 'raw_dataset',
  description: 'Raw events table',
  materialization: 'unknown',
  columns: [
    { name: 'event_id', description: 'Unique event identifier', dataType: 'STRING', meta: {} },
    { name: 'created_at', description: 'Event timestamp', dataType: 'TIMESTAMP', meta: {} },
  ],
  sampleDDL: 'CREATE TABLE `raw_dataset.raw_events` (\n  event_id STRING,\n  created_at TIMESTAMP\n);',
  dependsOn: [],
  tags: ['no-dbt-metadata'],
};

describe('informationSchemaCache', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDoc.mockReturnValue({
      set: mockSet,
      get: mockGet,
    });
    mockSet.mockResolvedValue(undefined);
  });

  describe('getCachedSchema', () => {
    it('returns cached TableContext when cache hit and not expired', async () => {
      const futureDate = new Date(Date.now() + 12 * 60 * 60 * 1000); // 12h from now
      const cachedDate = new Date(Date.now() - 12 * 60 * 60 * 1000); // 12h ago
      mockGet.mockResolvedValue({
        exists: true,
        data: () => ({
          tableContext: sampleTable,
          cachedAt: { toDate: () => cachedDate },
          expiresAt: { toDate: () => futureDate },
        }),
      });

      const result = await getCachedSchema('raw_dataset.raw_events');

      expect(result).toEqual(sampleTable);
      expect(mockDoc).toHaveBeenCalledWith('raw_dataset.raw_events');
    });

    it('returns null on cache miss (document does not exist)', async () => {
      mockGet.mockResolvedValue({
        exists: false,
      });

      const result = await getCachedSchema('raw_dataset.raw_events');

      expect(result).toBeNull();
      expect(mockDoc).toHaveBeenCalledWith('raw_dataset.raw_events');
    });

    it('returns null when cache entry is expired', async () => {
      const pastDate = new Date(Date.now() - 1000); // 1s ago
      const cachedDate = new Date(Date.now() - 25 * 60 * 60 * 1000); // 25h ago
      mockGet.mockResolvedValue({
        exists: true,
        data: () => ({
          tableContext: sampleTable,
          cachedAt: { toDate: () => cachedDate },
          expiresAt: { toDate: () => pastDate },
        }),
      });

      const result = await getCachedSchema('raw_dataset.raw_events');

      expect(result).toBeNull();
    });
  });

  describe('cacheSchema', () => {
    it('writes cache entry with correct TTL', async () => {
      await cacheSchema('raw_dataset.raw_events', sampleTable);

      expect(mockDoc).toHaveBeenCalledWith('raw_dataset.raw_events');
      expect(mockSet).toHaveBeenCalledWith(
        expect.objectContaining({
          tableContext: sampleTable,
          cachedAt: expect.any(Date),
          expiresAt: expect.any(Date),
        }),
      );

      const savedData = mockSet.mock.calls[0][0];
      const ttlMs = savedData.expiresAt.getTime() - savedData.cachedAt.getTime();
      expect(ttlMs).toBe(24 * 60 * 60 * 1000);
    });
  });
});
