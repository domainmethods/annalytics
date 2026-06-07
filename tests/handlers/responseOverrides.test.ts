import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/state/responseContext.js');
vi.mock('../../src/validation/pipeline.js');
vi.mock('../../src/execution/runner.js');

const mockGenerateContent = vi.fn();
vi.mock('@google/genai', () => ({
  GoogleGenAI: vi.fn(function () {
    return { models: { generateContent: mockGenerateContent } };
  }),
}));

import { getResponseContext } from '../../src/state/responseContext.js';
import { validateSql } from '../../src/validation/pipeline.js';
import { executeQuery } from '../../src/execution/runner.js';
import {
  handleTableOverride,
  handleSummaryOverride,
  handleCsvOverride,
  formatValue,
} from '../../src/handlers/responseOverrides.js';

const mockGetCtx = vi.mocked(getResponseContext);
const mockValidate = vi.mocked(validateSql);
const mockExecute = vi.mocked(executeQuery);

const mockClient = {
  chat: { update: vi.fn() },
  filesUploadV2: vi.fn(),
} as any;

const overrideConfig = {
  maxBytesProcessed: 10_000_000,
  queryTimeoutMs: 30_000,
  maxResultRows: 1000,
  geminiApiKey: 'test-key',
};

const baseCtx = {
  responseId: 'resp-1',
  threadTs: 'thread-1',
  statusMsgTs: 'status-1',
  clarifiedQuestion: 'What is revenue?',
  assumptions: [],
  reasoningChain: '',
  generatedSql: 'SELECT SUM(amount) FROM orders',
  explanation: 'Total revenue',
  tablesUsed: ['orders'],
  confidence: 'high' as const,
  primaryAgentConfidence: 'high' as const,
  queryResults: { rowCount: 1, columnNames: ['total'], bytesProcessed: 1024 },
  pipelineDurationMs: 2000,
  traceId: 'trace-abc',
  createdAt: new Date(),
  groundingCitations: [],
  teachingsUsed: [],
  supervisorVerdict: 'pass' as const,
  supervisorNotes: '',
};

const queryResult = {
  rows: [{ region: 'US', revenue: 1000 }, { region: 'EU', revenue: 500 }],
  columnNames: ['region', 'revenue'],
  totalRows: 2,
  bytesProcessed: 2048,
  truncated: false,
};

describe('handleTableOverride', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetCtx.mockResolvedValue(baseCtx);
    mockValidate.mockResolvedValue({ valid: true, layer: 'all', bytesProcessed: 2048 });
    mockExecute.mockResolvedValue(queryResult);
    mockClient.chat.update.mockResolvedValue({});
  });

  it('re-executes SQL and updates message with table blocks', async () => {
    await handleTableOverride('thread-1_status-1', 'C-CHAN', 'msg-ts', mockClient, overrideConfig);

    expect(mockGetCtx).toHaveBeenCalledWith('thread-1_status-1');
    expect(mockValidate).toHaveBeenCalledWith('SELECT SUM(amount) FROM orders', 10_000_000);
    expect(mockExecute).toHaveBeenCalledWith('SELECT SUM(amount) FROM orders', {
      maxRows: 1000,
      timeoutMs: 30_000,
      maxBytes: 10_000_000,
    });
    expect(mockClient.chat.update).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'C-CHAN',
        ts: 'msg-ts',
      }),
    );
    // Blocks should contain table content
    const updateCall = mockClient.chat.update.mock.calls[0][0];
    const text = JSON.stringify(updateCall.blocks);
    expect(text).toContain('region');
    expect(text).toContain('revenue');
  });
});

describe('handleSummaryOverride', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetCtx.mockResolvedValue(baseCtx);
    mockValidate.mockResolvedValue({ valid: true, layer: 'all', bytesProcessed: 2048 });
    mockExecute.mockResolvedValue(queryResult);
    mockClient.chat.update.mockResolvedValue({});
    mockGenerateContent.mockResolvedValue({
      text: 'US leads with $1000, followed by EU at $500.',
    });
  });

  it('re-executes SQL, calls Flash for summary, and updates message', async () => {
    await handleSummaryOverride('thread-1_status-1', 'C-CHAN', 'msg-ts', mockClient, overrideConfig);

    // Should show "Generating summary..." first
    expect(mockClient.chat.update).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Generating summary...' }),
    );

    // Should call Gemini Flash
    expect(mockGenerateContent).toHaveBeenCalled();
    const callArgs = mockGenerateContent.mock.calls[0][0];
    expect(callArgs.model).toBe('gemini-flash-latest');

    // Final update should contain the summary
    const lastUpdate = mockClient.chat.update.mock.calls[mockClient.chat.update.mock.calls.length - 1][0];
    const text = JSON.stringify(lastUpdate.blocks);
    expect(text).toContain('US leads');
  });
});

describe('handleCsvOverride', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetCtx.mockResolvedValue(baseCtx);
    mockValidate.mockResolvedValue({ valid: true, layer: 'all', bytesProcessed: 2048 });
    mockExecute.mockResolvedValue(queryResult);
    mockClient.filesUploadV2.mockResolvedValue({});
  });

  it('re-executes SQL and uploads CSV file', async () => {
    await handleCsvOverride('thread-1_status-1', 'C-CHAN', 'thread-1', mockClient, overrideConfig);

    expect(mockExecute).toHaveBeenCalled();
    expect(mockClient.filesUploadV2).toHaveBeenCalledWith(
      expect.objectContaining({
        filename: 'query_results.csv',
        channel_id: 'C-CHAN',
        thread_ts: 'thread-1',
      }),
    );

    // CSV content should have header and data rows
    const uploadCall = mockClient.filesUploadV2.mock.calls[0][0];
    const csv = Buffer.from(uploadCall.file).toString();
    expect(csv).toContain('region,revenue');
    expect(csv).toContain('US,1000');
    expect(csv).toContain('EU,500');
  });
});

describe('handleCsvOverride with BigQuery Date objects', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetCtx.mockResolvedValue(baseCtx);
    mockValidate.mockResolvedValue({ valid: true, layer: 'all', bytesProcessed: 2048 });
    mockClient.filesUploadV2.mockResolvedValue({});
  });

  it('serializes BigQuery Date objects via .value property', async () => {
    mockExecute.mockResolvedValue({
      rows: [
        { name: 'Alice', created_at: { value: '2025-01-15' } },
        { name: 'Bob', created_at: { value: '2025-02-20' } },
      ],
      columnNames: ['name', 'created_at'],
      totalRows: 2,
      bytesProcessed: 1024,
      truncated: false,
    });

    await handleCsvOverride('thread-1_status-1', 'C-CHAN', 'thread-1', mockClient, overrideConfig);

    const uploadCall = mockClient.filesUploadV2.mock.calls[0][0];
    const csv = Buffer.from(uploadCall.file).toString();
    expect(csv).toContain('name,created_at');
    expect(csv).toContain('Alice,2025-01-15');
    expect(csv).toContain('Bob,2025-02-20');
    // Should NOT contain [object Object]
    expect(csv).not.toContain('[object Object]');
  });
});

describe('formatValue', () => {
  it('handles primitives', () => {
    expect(formatValue('hello')).toBe('hello');
    expect(formatValue(42)).toBe('42');
    expect(formatValue(true)).toBe('true');
  });

  it('handles null and undefined', () => {
    expect(formatValue(null)).toBe('');
    expect(formatValue(undefined)).toBe('');
  });

  it('handles BigQuery Date objects with .value', () => {
    expect(formatValue({ value: '2025-01-15' })).toBe('2025-01-15');
  });

  it('falls back to JSON for objects without .value', () => {
    expect(formatValue({ foo: 'bar' })).toBe('{"foo":"bar"}');
  });

  it('formats a real JS Date as an ISO string (not quoted JSON)', () => {
    const d = new Date('2025-01-15T00:00:00.000Z');
    expect(formatValue(d)).toBe('2025-01-15T00:00:00.000Z');
  });
});

describe('re-execution failure', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetCtx.mockResolvedValue(baseCtx);
    mockValidate.mockResolvedValue({ valid: false, layer: 'L1', error: 'DML detected' });
    mockClient.chat.update.mockResolvedValue({});
  });

  it('updates message with friendly error when validation fails', async () => {
    await handleTableOverride('thread-1_status-1', 'C-CHAN', 'msg-ts', mockClient, overrideConfig);

    expect(mockExecute).not.toHaveBeenCalled();
    expect(mockClient.chat.update).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'C-CHAN',
        ts: 'msg-ts',
        text: expect.stringContaining('trace-abc'),
      }),
    );
  });
});
