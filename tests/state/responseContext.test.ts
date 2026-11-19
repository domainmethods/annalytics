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
  RESPONSE_CONTEXT_BYTE_BUDGET,
  saveResponseContext,
  botHasRepliedInThread,
  getResponseContext,
  getLatestResponseContext,
  getResponseContextsSince,
  responseContextDocumentId,
  getSlackResponseContext,
} from '../../src/state/responseContext.js';

const sampleContext = () => ({
  channel: 'C1',
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
    mockWhere.mockReturnValue({ select: mockSelect });
    mockSelect.mockReturnValue({ limit: mockLimit });
    mockLimit.mockReturnValue({ get: mockGet });
  });

  it('bounds a large schema for both surfaces', async () => {
    for (const surface of ['slack', 'whatsapp'] as const) {
      await saveResponseContext({ ...sampleContext(), surface,
        retrievedSchema: Array.from({ length: 200 }, (_, i) => ({
          name: `table_${i}`, description: '', columns: Array.from({ length: 40 }, (_, j) => ({
            name: `column_${j}`, description: 'é'.repeat(140), dataType: 'STRING', // multibyte: budget counts UTF-8 bytes
          })),
        })),
      });
      const saved = mockSet.mock.calls.at(-1)![0];
      expect(Buffer.byteLength(JSON.stringify(saved.retrievedSchema))).toBeLessThanOrEqual(RESPONSE_CONTEXT_BYTE_BUDGET);
      expect(saved.retrievedSchema.some((t: { columns: unknown[] }) => t.columns.length > 0)).toBe(true);
      expect(saved.retrievedSchema).toHaveLength(200);
      expect(saved.schemaDetailsTrimmed).toBe(true);
      expect(saved.generatedSql).toBe('SELECT 1');
      expect(saved.surface).toBe(surface);
    }
  });

  it('saves Slack answers at the conversation-scoped key', async () => {
    mockSet.mockResolvedValue(undefined);
    await saveResponseContext(sampleContext());
    expect(mockDoc).toHaveBeenCalledWith('C1:thread-1_msg-1');
    expect(mockSet).toHaveBeenCalled();
  });

  it('refuses to save a Slack answer without its channel (would hit the shared legacy key)', async () => {
    const { channel: _omit, ...unowned } = sampleContext();
    await expect(saveResponseContext(unowned)).rejects.toThrow('must record its channel');
    expect(mockSet).not.toHaveBeenCalled();
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

  it('rejects invalid retention instead of silently falling back', async () => {
    vi.stubEnv('RESPONSE_CONTEXT_RETENTION_DAYS', 'not-a-number');
    vi.resetModules();
    await expect(import('../../src/state/responseContext.js')).rejects.toThrow('RESPONSE_CONTEXT_RETENTION_DAYS');
    vi.unstubAllEnvs();
    vi.resetModules();
  });

});

describe('botHasRepliedInThread', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWhere.mockReturnValue({ select: mockSelect });
    mockSelect.mockReturnValue({ limit: mockLimit });
    mockLimit.mockReturnValue({ get: mockGet });
  });

  it('returns true when response context exists for the conversation', async () => {
    mockGet.mockResolvedValue({ empty: false, docs: [{ data: () => ({ channel: 'C_ONE' }) }] });
    const result = await botHasRepliedInThread('C_ONE', 'thread-1');
    expect(result).toBe(true);
    expect(mockLimit).toHaveBeenCalledWith(20);
    expect(mockSelect).toHaveBeenCalledWith('channel');
  });

  it('returns false when no response context exists', async () => {
    mockGet.mockResolvedValue({ empty: true, docs: [] });
    const result = await botHasRepliedInThread('C_ONE', 'thread-1');
    expect(result).toBe(false);
  });
});

describe('getResponseContext', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWhere.mockReturnValue({ select: mockSelect });
    mockSelect.mockReturnValue({ limit: mockLimit });
    mockLimit.mockReturnValue({ get: mockGet });
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

  it('returns null when the response context Date expiry has passed', async () => {
    mockDocGet.mockResolvedValue({
      exists: true,
      data: () => ({
        responseId: 'r1',
        threadTs: 'thread-1',
        statusMsgTs: 'msg-1',
        generatedSql: 'SELECT 1',
        expiresAt: new Date(Date.now() - 60 * 60 * 1000),
      }),
    });

    const result = await getResponseContext('thread-1_msg-1');

    expect(result).toBeNull();
    expect(mockDoc).toHaveBeenCalledWith('thread-1_msg-1');
  });

  it('returns context when the response context Firestore timestamp expiry is still valid', async () => {
    mockDocGet.mockResolvedValue({
      exists: true,
      data: () => ({
        responseId: 'r1',
        threadTs: 'thread-1',
        statusMsgTs: 'msg-1',
        generatedSql: 'SELECT 1',
        expiresAt: { toDate: () => new Date(Date.now() + 60 * 60 * 1000) },
      }),
    });

    const result = await getResponseContext('thread-1_msg-1');

    expect(result).not.toBeNull();
    expect(result!.responseId).toBe('r1');
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
          channel: 'C_ONE',
          threadTs: 'thread-1',
          statusMsgTs: 'msg-2',
          generatedSql: 'SELECT 2',
        }),
      }],
    });

    const result = await getLatestResponseContext('C_ONE', 'thread-1');

    expect(result).not.toBeNull();
    expect(result!.responseId).toBe('r2');
    expect(mockWhere).toHaveBeenCalledWith('threadTs', '==', 'thread-1');
    expect(mockOrderBy).toHaveBeenCalledWith('createdAt', 'desc');
  });
});

describe('conversation scoping', () => {
  const ctx = (responseId: string, channel?: string) => ({
    data: () => ({ responseId, threadTs: 'same.ts', ...(channel === undefined ? {} : { channel }) }),
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockWhere.mockReturnValue({ orderBy: mockOrderBy, select: mockSelect });
    mockOrderBy.mockReturnValue({ limit: mockLimit });
    mockSelect.mockReturnValue({ limit: mockLimit });
    mockLimit.mockReturnValue({ get: mockGet });
  });

  it('botHasRepliedInThread only counts replies in the same conversation', async () => {
    mockGet.mockResolvedValue({ docs: [ctx('a', 'C_TWO')] });
    expect(await botHasRepliedInThread('C_ONE', 'same.ts')).toBe(false);
    expect(await botHasRepliedInThread('C_TWO', 'same.ts')).toBe(true);
  });

  it('botHasRepliedInThread ignores legacy records without a channel', async () => {
    mockGet.mockResolvedValue({ docs: [ctx('legacy')] });
    expect(await botHasRepliedInThread('C_ONE', 'same.ts')).toBe(false);
  });

  it('getLatestResponseContext returns the context of the requested conversation', async () => {
    mockGet.mockResolvedValue({ docs: [ctx('two', 'C_TWO'), ctx('one', 'C_ONE')] });
    expect((await getLatestResponseContext('C_ONE', 'same.ts'))?.responseId).toBe('one');
    expect((await getLatestResponseContext('C_TWO', 'same.ts'))?.responseId).toBe('two');
    expect(mockLimit).toHaveBeenCalledWith(20);
  });

  it('getLatestResponseContext does not leak another conversation context', async () => {
    mockGet.mockResolvedValue({ docs: [ctx('two', 'C_TWO')] });
    expect(await getLatestResponseContext('C_ONE', 'same.ts')).toBeNull();
  });

  it('getLatestResponseContext never returns a legacy record without a channel', async () => {
    mockGet.mockResolvedValue({ docs: [ctx('legacy')] });
    expect(await getLatestResponseContext('C_ONE', 'same.ts')).toBeNull();
  });
});

describe('responseContextDocumentId scoping', () => {
  it('prefixes Slack ids with the channel when set', () => {
    expect(responseContextDocumentId({ ...sampleContext(), channel: 'C1', threadTs: 'ts', statusMsgTs: 'status' } as any)).toBe('C1:ts_status');
  });

  it('keeps the legacy id for a Slack context without a channel', () => {
    expect(responseContextDocumentId({ ...sampleContext(), channel: undefined, threadTs: 'ts', statusMsgTs: 'status' } as any)).toBe('ts_status');
  });

  it('leaves WhatsApp ids unchanged even when a channel is present', () => {
    expect(responseContextDocumentId({
      ...sampleContext(), surface: 'whatsapp', channel: 'C1', threadTs: 'whatsapp:1', statusMsgTs: 'wamid.A',
    } as any)).toBe('whatsapp:1_wamid.A');
  });

  it('saveResponseContext writes a Slack answer to the channel-scoped doc', async () => {
    vi.clearAllMocks();
    mockSet.mockResolvedValue(undefined);
    await saveResponseContext({ ...sampleContext(), channel: 'C1' } as any);
    expect(mockDoc).toHaveBeenCalledWith('C1:thread-1_msg-1');
  });
});

describe('getSlackResponseContext', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDoc.mockReturnValue({ set: mockSet, get: mockDocGet });
  });

  it('returns the channel-scoped doc when present', async () => {
    mockDocGet.mockResolvedValueOnce({ exists: true, data: () => ({ responseId: 'scoped', channel: 'C1' }) });
    const result = await getSlackResponseContext('C1', 'ts_status');
    expect(result?.responseId).toBe('scoped');
    expect(mockDoc).toHaveBeenCalledTimes(1);
    expect(mockDoc).toHaveBeenCalledWith('C1:ts_status');
  });

  it('falls back to the legacy bare-id doc when it has no channel', async () => {
    mockDocGet
      .mockResolvedValueOnce({ exists: false })
      .mockResolvedValueOnce({ exists: true, data: () => ({ responseId: 'legacy' }) });
    const result = await getSlackResponseContext('C1', 'ts_status');
    expect(result?.responseId).toBe('legacy');
    expect(mockDoc).toHaveBeenNthCalledWith(2, 'ts_status');
  });

  it('returns null for a legacy-id doc that belongs to a channel', async () => {
    mockDocGet
      .mockResolvedValueOnce({ exists: false })
      .mockResolvedValueOnce({ exists: true, data: () => ({ responseId: 'other', channel: 'C2' }) });
    expect(await getSlackResponseContext('C1', 'ts_status')).toBeNull();
  });

  it('returns null when neither doc exists', async () => {
    mockDocGet.mockResolvedValue({ exists: false });
    expect(await getSlackResponseContext('C1', 'ts_status')).toBeNull();
  });

  it('returns null when the scoped doc has expired', async () => {
    mockDocGet.mockResolvedValueOnce({
      exists: true,
      data: () => ({ responseId: 'old', channel: 'C1', expiresAt: new Date(Date.now() - 60_000) }),
    });
    expect(await getSlackResponseContext('C1', 'ts_status')).toBeNull();
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
