import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSet = vi.fn();
const mockGet = vi.fn();
const mockDocGet = vi.fn();
const mockDoc = vi.fn().mockReturnValue({ set: mockSet, get: mockDocGet });
const mockWhere = vi.fn();
const mockLimit = vi.fn();
const mockSelect = vi.fn();
const mockOrderBy = vi.fn();

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

import {
  saveResponseContext,
  botHasRepliedInThread,
  getResponseContext,
  getLatestResponseContext,
  getResponseContextsSince,
  responseContextDocumentId,
} from '../../src/state/responseContext.js';

const sampleContext = () => ({
  responseId: 'r1',
  threadTs: 'thread-1',
  statusMsgTs: 'msg-1',
  clarifiedQuestion: 'test',
  assumptions: [],
  reasoningChain: '',
  generatedSql: 'SELECT 1',
  tablesUsed: [],
  confidence: 'high' as const,
  queryResults: { rowCount: 0, columnNames: [], bytesProcessed: 0 },
  pipelineDurationMs: 100,
  traceId: 'trace-1',
  createdAt: new Date(),
});

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
    await saveResponseContext(sampleContext());
    expect(mockDoc).toHaveBeenCalledWith('thread-1_msg-1');
    expect(mockSet).toHaveBeenCalled();
  });

  it('URL-encodes WhatsApp status message ids in Firestore doc ids', async () => {
    mockSet.mockResolvedValue(undefined);
    await saveResponseContext({
      ...sampleContext(),
      threadTs: 'whatsapp:15551234567',
      statusMsgTs: 'outbound/A+B=',
      surface: 'whatsapp',
    });

    expect(mockDoc).toHaveBeenCalledWith('whatsapp:15551234567_outbound%2FA%2BB%3D');
    expect(mockSet).toHaveBeenCalled();
  });

  it('exports the encoded WhatsApp response context document id', () => {
    expect(responseContextDocumentId({
      surface: 'whatsapp',
      responseId: 'trace-1',
      threadTs: 'whatsapp:15551234567',
      statusMsgTs: 'wamid.outbound/A+B=',
      clarifiedQuestion: 'What was revenue?',
      assumptions: [],
      reasoningChain: '',
      generatedSql: 'SELECT 1',
      explanation: 'Revenue was 1.',
      tablesUsed: [],
      confidence: 'high',
      clarificationConfidence: 'high',
      primaryAgentConfidence: 'high',
      queryResults: { rowCount: 1, columnNames: ['revenue'], bytesProcessed: 0 },
      pipelineDurationMs: 10,
      traceId: 'trace-1',
      createdAt: new Date('2026-06-23T00:00:00.000Z'),
      groundingCitations: [],
      teachingsUsed: [],
      supervisorNotes: '',
      supervisorConfidence: 'high',
      supervisorDecision: 'required',
      pipelineMode: 'full_quality_loop',
    })).toBe('whatsapp:15551234567_wamid.outbound%2FA%2BB%3D');
  });

  it('writes expiresAt as a Date 90 days after createdAt by default', async () => {
    mockSet.mockResolvedValue(undefined);
    await saveResponseContext(sampleContext());

    const written = mockSet.mock.calls[0][0];
    // Firestore rejects undefined properties — expiresAt must always be a Date.
    expect(written.expiresAt).toBeInstanceOf(Date);
    expect(written.expiresAt).not.toBeUndefined();
    expect(written.createdAt).toBeInstanceOf(Date);

    const ninetyDaysMs = 90 * 24 * 60 * 60 * 1000;
    // expiresAt and createdAt must derive from the same captured instant.
    expect(written.expiresAt.getTime() - written.createdAt.getTime()).toBe(ninetyDaysMs);
  });

  it('honors RESPONSE_CONTEXT_RETENTION_DAYS env override', async () => {
    vi.stubEnv('RESPONSE_CONTEXT_RETENTION_DAYS', '30');
    vi.resetModules();
    try {
      // Retention is parsed at module load — re-import to pick up the stub.
      const fresh = await import('../../src/state/responseContext.js');
      mockSet.mockResolvedValue(undefined);
      await fresh.saveResponseContext(sampleContext());

      const written = mockSet.mock.calls[0][0];
      expect(written.expiresAt).toBeInstanceOf(Date);
      const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
      expect(written.expiresAt.getTime() - written.createdAt.getTime()).toBe(thirtyDaysMs);
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });

  it('falls back to 90 days when the env override is not a positive number', async () => {
    vi.stubEnv('RESPONSE_CONTEXT_RETENTION_DAYS', 'not-a-number');
    vi.resetModules();
    try {
      const fresh = await import('../../src/state/responseContext.js');
      mockSet.mockResolvedValue(undefined);
      await fresh.saveResponseContext(sampleContext());

      const written = mockSet.mock.calls[0][0];
      const ninetyDaysMs = 90 * 24 * 60 * 60 * 1000;
      expect(written.expiresAt.getTime() - written.createdAt.getTime()).toBe(ninetyDaysMs);
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
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

describe('getResponseContext', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWhere.mockReturnValue({ limit: mockLimit });
    mockLimit.mockReturnValue({ select: mockSelect });
    mockSelect.mockReturnValue({ get: mockGet });
  });

  it('returns context when doc exists', async () => {
    mockDocGet.mockResolvedValue({
      exists: true,
      data: () => ({
        responseId: 'r1',
        threadTs: 'thread-1',
        statusMsgTs: 'msg-1',
        generatedSql: 'SELECT 1',
      }),
    });

    const result = await getResponseContext('thread-1_msg-1');

    expect(result).not.toBeNull();
    expect(result!.responseId).toBe('r1');
    expect(mockDoc).toHaveBeenCalledWith('thread-1_msg-1');
  });

  it('returns null when doc does not exist', async () => {
    mockDocGet.mockResolvedValue({ exists: false });

    const result = await getResponseContext('nonexistent_key');

    expect(result).toBeNull();
  });
});

describe('getLatestResponseContext', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWhere.mockReturnValue({ orderBy: mockOrderBy });
    mockOrderBy.mockReturnValue({ limit: mockLimit });
    mockLimit.mockReturnValue({ get: mockGet });
  });

  it('returns most recent context for thread', async () => {
    mockGet.mockResolvedValue({
      empty: false,
      docs: [{
        data: () => ({
          responseId: 'r2',
          threadTs: 'thread-1',
          statusMsgTs: 'msg-2',
          generatedSql: 'SELECT 2',
        }),
      }],
    });

    const result = await getLatestResponseContext('thread-1');

    expect(result).not.toBeNull();
    expect(result!.responseId).toBe('r2');
    expect(mockWhere).toHaveBeenCalledWith('threadTs', '==', 'thread-1');
    expect(mockOrderBy).toHaveBeenCalledWith('createdAt', 'desc');
  });
});

describe('getResponseContextsSince', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWhere.mockReturnValue({ orderBy: mockOrderBy });
    mockOrderBy.mockReturnValue({ limit: mockLimit });
    mockLimit.mockReturnValue({ get: mockGet });
  });

  it('queries response_context filtered by a correct createdAt cutoff and maps docs', async () => {
    mockGet.mockResolvedValue({
      size: 1,
      docs: [{ data: () => ({ traceId: 't1', tablesUsed: ['analytics.fct_orders'] }) }],
    });

    const windowDays = 30;
    const windowMs = windowDays * 24 * 60 * 60 * 1000;
    const before = Date.now();
    const rows = await getResponseContextsSince(windowDays);
    const after = Date.now();

    expect(mockWhere).toHaveBeenCalledWith('createdAt', '>=', expect.any(Date));
    const since = mockWhere.mock.calls[0][2] as Date;
    // The cutoff must be `now - windowMs`, computed at call time. Bound it by the
    // before/after wall-clock readings so a units bug (hours vs days, missing *1000)
    // would fall outside the range and fail.
    expect(since.getTime()).toBeGreaterThanOrEqual(before - windowMs);
    expect(since.getTime()).toBeLessThanOrEqual(after - windowMs);

    expect(rows).toHaveLength(1);
    expect(rows[0].traceId).toBe('t1');
  });

  it('bounds the scan with a default limit of 5000', async () => {
    mockGet.mockResolvedValue({ size: 0, docs: [] });

    await getResponseContextsSince(30);

    expect(mockOrderBy).toHaveBeenCalledWith('createdAt', 'desc');
    expect(mockLimit).toHaveBeenCalledWith(5000);
  });

  it('honors a caller-provided limit override', async () => {
    mockGet.mockResolvedValue({ size: 0, docs: [] });

    await getResponseContextsSince(30, 250);

    expect(mockLimit).toHaveBeenCalledWith(250);
  });

  it('warns about truncation when the result size equals the limit', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      mockGet.mockResolvedValue({
        size: 2,
        docs: [
          { data: () => ({ traceId: 't1' }) },
          { data: () => ({ traceId: 't2' }) },
        ],
      });

      const rows = await getResponseContextsSince(30, 2);

      expect(rows).toHaveLength(2);
      expect(warnSpy).toHaveBeenCalledWith(
        'response_context window scan hit limit 2; results truncated',
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('does not warn when the result size is under the limit', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      mockGet.mockResolvedValue({
        size: 1,
        docs: [{ data: () => ({ traceId: 't1' }) }],
      });

      await getResponseContextsSince(30, 2);

      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });
});
