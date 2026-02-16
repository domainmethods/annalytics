import { describe, it, expect, vi, beforeEach } from 'vitest';
import { syncTeachingsToFileSearch } from '../../src/teachings/fileSearchSync.js';
import type { Teaching } from '../../src/teachings/types.js';

const mockUpload = vi.fn();
vi.mock('@google/genai', () => ({
  GoogleGenAI: vi.fn(function () {
    return {
      fileSearchStores: {
        uploadToFileSearchStore: mockUpload,
      },
    };
  }),
}));

vi.mock('../../src/teachings/markdownConverter.js', () => ({
  teachingToMarkdown: (t: Teaching) => `# Teaching: ${t.id}`,
}));

const teaching1: Teaching = {
  id: 'revenue-monthly',
  question_patterns: ['monthly revenue'],
  sanctioned_sql: 'SELECT 1',
  reasoning: 'Revenue reasoning.',
  models_referenced: ['analytics.fct_orders'],
  tags: ['revenue'],
  author: 'test',
  updated: '2026-02-10',
};

const teaching2: Teaching = {
  id: 'churn-definition',
  question_patterns: ['churn'],
  sanctioned_sql: null,
  reasoning: 'Churn reasoning.',
  models_referenced: ['analytics.dim_customers'],
  tags: ['churn'],
  author: 'test',
  updated: '2026-02-10',
};

describe('syncTeachingsToFileSearch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpload.mockResolvedValue({ name: 'op-1', done: true });
  });

  it('uploads each teaching as a separate file to the store', async () => {
    const result = await syncTeachingsToFileSearch(
      [teaching1, teaching2], 'stores/test', 'key',
    );

    expect(result.uploaded).toBe(2);
    expect(result.errors).toHaveLength(0);
    expect(mockUpload).toHaveBeenCalledTimes(2);
  });

  it('sets displayName to teaching ID', async () => {
    await syncTeachingsToFileSearch([teaching1], 'stores/test', 'key');

    expect(mockUpload).toHaveBeenCalledWith(
      expect.objectContaining({
        fileSearchStoreName: 'stores/test',
        config: expect.objectContaining({
          displayName: 'revenue-monthly',
        }),
      }),
    );
  });

  it('handles empty teachings array without error', async () => {
    const result = await syncTeachingsToFileSearch([], 'stores/test', 'key');

    expect(result.uploaded).toBe(0);
    expect(result.errors).toHaveLength(0);
    expect(mockUpload).not.toHaveBeenCalled();
  });

  it('collects errors per teaching without aborting sync', async () => {
    mockUpload
      .mockResolvedValueOnce({ name: 'op-1', done: true })
      .mockRejectedValueOnce(new Error('Upload failed'));

    const result = await syncTeachingsToFileSearch(
      [teaching1, teaching2], 'stores/test', 'key',
    );

    expect(result.uploaded).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('churn-definition');
    expect(result.errors[0]).toContain('Upload failed');
  });
});
