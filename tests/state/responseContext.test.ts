import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSet = vi.fn();
const mockGet = vi.fn();
const mockDoc = vi.fn().mockReturnValue({ set: mockSet });
const mockWhere = vi.fn();
const mockLimit = vi.fn();
const mockSelect = vi.fn();

vi.mock('../../src/state/firestore.js', () => ({
  getDb: () => ({
    collection: () => ({
      doc: mockDoc,
      where: mockWhere,
    }),
  }),
}));

mockWhere.mockReturnValue({ limit: mockLimit });
mockLimit.mockReturnValue({ select: mockSelect });
mockSelect.mockReturnValue({ get: mockGet });

import { saveResponseContext, botHasRepliedInThread } from '../../src/state/responseContext.js';

describe('saveResponseContext', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Re-setup chain mocks after clearAllMocks
    mockWhere.mockReturnValue({ limit: mockLimit });
    mockLimit.mockReturnValue({ select: mockSelect });
    mockSelect.mockReturnValue({ get: mockGet });
  });

  it('saves with composite key threadTs_statusMsgTs', async () => {
    mockSet.mockResolvedValue(undefined);
    await saveResponseContext({
      responseId: 'r1',
      threadTs: 'thread-1',
      statusMsgTs: 'msg-1',
      clarifiedQuestion: 'test',
      assumptions: [],
      reasoningChain: '',
      generatedSql: 'SELECT 1',
      tablesUsed: [],
      confidence: 'high',
      queryResults: { rowCount: 0, columnNames: [], bytesProcessed: 0 },
      pipelineDurationMs: 100,
      traceId: 'trace-1',
      createdAt: new Date(),
    });
    expect(mockDoc).toHaveBeenCalledWith('thread-1_msg-1');
    expect(mockSet).toHaveBeenCalled();
  });
});

describe('botHasRepliedInThread', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWhere.mockReturnValue({ limit: mockLimit });
    mockLimit.mockReturnValue({ select: mockSelect });
    mockSelect.mockReturnValue({ get: mockGet });
  });

  it('returns true when response context exists', async () => {
    mockGet.mockResolvedValue({ empty: false });
    const result = await botHasRepliedInThread('thread-1');
    expect(result).toBe(true);
  });

  it('returns false when no response context exists', async () => {
    mockGet.mockResolvedValue({ empty: true });
    const result = await botHasRepliedInThread('thread-1');
    expect(result).toBe(false);
  });
});
