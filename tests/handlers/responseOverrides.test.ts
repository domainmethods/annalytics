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

vi.mock('../../src/logging.js', () => ({
  rootLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

import { getSlackResponseContext } from '../../src/state/responseContext.js';
import { validateSql } from '../../src/validation/pipeline.js';
import { executeQuery } from '../../src/execution/runner.js';
import {
  handleTableOverride,
  handleSummaryOverride,
  handleCsvOverride,
  csvField,
  formatValue,
} from '../../src/handlers/responseOverrides.js';
import { rootLogger } from '../../src/logging.js';
import { buildTableBlocks } from '../../src/slack/blocks.js';
import { verifyComposition } from '../../src/execution/composition.js';

const mockGetCtx = vi.mocked(getSlackResponseContext);
const mockValidate = vi.mocked(validateSql);
const mockExecute = vi.mocked(executeQuery);

const mockClient = {
  chat: { update: vi.fn(), postMessage: vi.fn(), postEphemeral: vi.fn() },
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

    expect(mockGetCtx).toHaveBeenCalledWith('C-CHAN', 'thread-1_status-1');
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
    expect(callArgs.model).toBe('gemini-3-flash-preview');

    // Final update should contain the summary
    const lastUpdate = mockClient.chat.update.mock.calls[mockClient.chat.update.mock.calls.length - 1][0];
    const text = JSON.stringify(lastUpdate.blocks);
    expect(text).toContain('US leads');
  });
});

describe('override handlers preserve assumptions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockValidate.mockResolvedValue({ valid: true, layer: 'all', bytesProcessed: 2048 });
    mockExecute.mockResolvedValue(queryResult);
    mockClient.chat.update.mockResolvedValue({});
    mockGenerateContent.mockResolvedValue({ text: 'a summary' });
  });

  it('preserves assumptions + refine button when re-rendering as a table', async () => {
    mockGetCtx.mockResolvedValue({ ...baseCtx, assumptions: ['order_status = completed'] });
    await handleTableOverride('thread-1_status-1', 'C-CHAN', 'msg-ts', mockClient, overrideConfig);
    const updated = JSON.stringify(mockClient.chat.update.mock.calls.at(-1)[0].blocks);
    expect(updated).toContain('order_status = completed');
    expect(updated).toContain('refine_assumptions');
  });

  it('preserves assumptions + refine button when re-rendering as a summary', async () => {
    mockGetCtx.mockResolvedValue({ ...baseCtx, assumptions: ['order_status = completed'] });
    await handleSummaryOverride('thread-1_status-1', 'C-CHAN', 'msg-ts', mockClient, overrideConfig);
    const updated = JSON.stringify(mockClient.chat.update.mock.calls.at(-1)[0].blocks);
    expect(updated).toContain('order_status = completed');
    expect(updated).toContain('refine_assumptions');
  });
});

describe('override handlers keep the best-effort verification warning (#47)', () => {
  const bestEffortCtx = { ...baseCtx, supervisorVerdict: 'exhausted' as const, supervisorNotes: 'Unsure about the join' };
  const lastBlocks = () => JSON.stringify(mockClient.chat.update.mock.calls.at(-1)[0].blocks);

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetCtx.mockResolvedValue(bestEffortCtx);
    mockValidate.mockResolvedValue({ valid: true, layer: 'all', bytesProcessed: 2048 });
    mockExecute.mockResolvedValue(queryResult);
    mockClient.chat.update.mockResolvedValue({});
    mockGenerateContent.mockResolvedValue({ text: 'a summary' });
  });

  it('keeps the warning when re-rendering as a table', async () => {
    await handleTableOverride('thread-1_status-1', 'C-CHAN', 'msg-ts', mockClient, overrideConfig);
    expect(lastBlocks()).toContain('The data team is verifying it');
    expect(lastBlocks()).toContain('Unsure about the join');
    expect(lastBlocks()).toContain('region');
  });

  it('keeps the warning while summarizing and on the summary', async () => {
    await handleSummaryOverride('thread-1_status-1', 'C-CHAN', 'msg-ts', mockClient, overrideConfig);
    const progress = mockClient.chat.update.mock.calls[0][0];
    expect(progress.text).toBe('Generating summary...');
    expect(JSON.stringify(progress.blocks)).toContain('The data team is verifying it');
    expect(lastBlocks()).toContain('The data team is verifying it');
    expect(lastBlocks()).toContain('a summary');
  });

  it('keeps the warning on the summary fallback table', async () => {
    mockGenerateContent.mockRejectedValue(new Error('Flash down'));
    await handleSummaryOverride('thread-1_status-1', 'C-CHAN', 'msg-ts', mockClient, overrideConfig);
    expect(lastBlocks()).toContain("Couldn't generate a summary");
    expect(lastBlocks()).toContain('The data team is verifying it');
  });

  it('keeps the warning when the summary comes back empty', async () => {
    mockGenerateContent.mockResolvedValue({ text: '' });
    await handleSummaryOverride('thread-1_status-1', 'C-CHAN', 'msg-ts', mockClient, overrideConfig);
    expect(lastBlocks()).toContain("Couldn't generate a summary");
    expect(lastBlocks()).toContain('The data team is verifying it');
  });

  it('adds no warning to a verified answer', async () => {
    mockGetCtx.mockResolvedValue(baseCtx);
    await handleTableOverride('thread-1_status-1', 'C-CHAN', 'msg-ts', mockClient, overrideConfig);
    expect(lastBlocks()).not.toContain('verifying');
    await handleSummaryOverride('thread-1_status-1', 'C-CHAN', 'msg-ts', mockClient, overrideConfig);
    expect(lastBlocks()).not.toContain('verifying');
    expect(mockClient.chat.update.mock.calls.find((c: any[]) => c[0].text === 'Generating summary...')[0].blocks).toBeUndefined();
  });
});

const csvCurrentBlocks = [
  { type: 'section', text: { type: 'mrkdwn', text: 'answer' } },
  { type: 'actions', elements: [{ type: 'button', action_id: 'override_csv_trace-abc' }] },
];

describe('handleCsvOverride', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetCtx.mockResolvedValue(baseCtx);
    mockValidate.mockResolvedValue({ valid: true, layer: 'all', bytesProcessed: 2048 });
    mockExecute.mockResolvedValue(queryResult);
    mockClient.filesUploadV2.mockResolvedValue({});
    mockClient.chat.update.mockResolvedValue({});
  });

  it('re-executes SQL and uploads CSV file', async () => {
    await handleCsvOverride('thread-1_status-1', 'C-CHAN', 'thread-1', 'msg-ts', 'U-CLICK', csvCurrentBlocks, mockClient, overrideConfig);

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

  it('exports unsafe INT64 strings verbatim in scalar and nested cells', async () => {
    mockExecute.mockResolvedValue({
      ...queryResult,
      rows: [{ id: '9007199254740993', nested: { ids: [42, '-9223372036854775808'] } }],
      columnNames: ['id', 'nested'],
      totalRows: 1,
    });

    await handleCsvOverride('thread-1_status-1', 'C-CHAN', 'thread-1', 'msg-ts', 'U-CLICK', [], mockClient, overrideConfig);

    const uploadCall = mockClient.filesUploadV2.mock.calls[0][0];
    expect(Buffer.from(uploadCall.file).toString()).toBe(
      'id,nested\n9007199254740993,"{""ids"":[42,""-9223372036854775808""]}"',
    );
  });
});

describe('handleCsvOverride with BigQuery Date objects', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetCtx.mockResolvedValue(baseCtx);
    mockValidate.mockResolvedValue({ valid: true, layer: 'all', bytesProcessed: 2048 });
    mockClient.filesUploadV2.mockResolvedValue({});
    mockClient.chat.update.mockResolvedValue({});
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

    await handleCsvOverride('thread-1_status-1', 'C-CHAN', 'thread-1', 'msg-ts', 'U-CLICK', csvCurrentBlocks, mockClient, overrideConfig);

    const uploadCall = mockClient.filesUploadV2.mock.calls[0][0];
    const csv = Buffer.from(uploadCall.file).toString();
    expect(csv).toContain('name,created_at');
    expect(csv).toContain('Alice,2025-01-15');
    expect(csv).toContain('Bob,2025-02-20');
    // Should NOT contain [object Object]
    expect(csv).not.toContain('[object Object]');
  });

  it('keeps every field of a STRUCT with a value field (#67)', async () => {
    mockExecute.mockResolvedValue({
      rows: [{ day: { value: '2025-01-15' }, duration: { value: 4, unit: 'hours' } }],
      columnNames: ['day', 'duration'],
      totalRows: 1,
      bytesProcessed: 1024,
      truncated: false,
    });

    await handleCsvOverride('thread-1_status-1', 'C-CHAN', 'thread-1', 'msg-ts', 'U-CLICK', csvCurrentBlocks, mockClient, overrideConfig);

    const csv = Buffer.from(mockClient.filesUploadV2.mock.calls[0][0].file).toString();
    expect(csv.split('\n')[1]).toBe('2025-01-15,"{""value"":4,""unit"":""hours""}"');
  });
});

/** Minimal RFC 4180 reader: CR, LF or CRLF outside quotes ends a record, as in
 *  common spreadsheet/CSV readers. */
function parseCsv(text: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { record.push(field); field = ''; }
    else if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      record.push(field); records.push(record); record = []; field = '';
    } else field += ch;
  }
  record.push(field); records.push(record);
  return records;
}

describe('handleCsvOverride line breaks inside cells (#71)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetCtx.mockResolvedValue(baseCtx);
    mockValidate.mockResolvedValue({ valid: true, layer: 'all', bytesProcessed: 2048 });
    mockClient.filesUploadV2.mockResolvedValue({});
    mockClient.chat.update.mockResolvedValue({});
  });

  it('round-trips a bare carriage return, a line feed and CRLF without splitting the row', async () => {
    const rows = [
      { id: '1', note: 'A\rB' },
      { id: '2', note: 'C\nD' },
      { id: '3', note: 'E\r\nF, "G"' },
    ];
    mockExecute.mockResolvedValue({ rows, columnNames: ['id', 'note'], totalRows: 3, bytesProcessed: 1024, truncated: false });

    await handleCsvOverride('thread-1_status-1', 'C-CHAN', 'thread-1', 'msg-ts', 'U-CLICK', csvCurrentBlocks, mockClient, overrideConfig);

    const csv = Buffer.from(mockClient.filesUploadV2.mock.calls[0][0].file).toString();
    expect(parseCsv(csv)).toEqual([
      ['id', 'note'],
      ['1', 'A\rB'],
      ['2', 'C\nD'],
      ['3', 'E\r\nF, "G"'],
    ]);
  });
});

describe('csvField', () => {
  it('quotes only fields that need it', () => {
    expect(csvField('plain')).toBe('plain');
    expect(csvField('A\rB')).toBe('"A\rB"');
    expect(csvField('a "b" c')).toBe('"a ""b"" c"');
  });
});

describe('handleCsvOverride upload failure', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('logs override.csv.failed with the raw error message when the upload fails', async () => {
    mockGetCtx.mockResolvedValue(baseCtx);
    mockValidate.mockResolvedValue({ valid: true, layer: 'all', bytesProcessed: 2048 });
    mockExecute.mockResolvedValue(queryResult);
    mockClient.filesUploadV2.mockRejectedValue(new Error('An API error occurred: missing_scope'));

    await handleCsvOverride('thread-1_status-1', 'C-CHAN', 'thread-1', 'msg-ts', 'U-CLICK', [], mockClient, overrideConfig);

    expect(vi.mocked(rootLogger.error)).toHaveBeenCalled();
    const [meta, msg] = vi.mocked(rootLogger.error).mock.calls[0];
    expect(msg).toBe('override.csv.failed');
    expect((meta as any).error).toContain('missing_scope');
    // Raw Slack API errors carry no traceId, so extractTraceId returns 'unknown' here.
    expect((meta as any).traceId).toBe('unknown');
  });
});

describe('handleCsvOverride idempotency', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetCtx.mockResolvedValue(baseCtx);
    mockValidate.mockResolvedValue({ valid: true, layer: 'all', bytesProcessed: 2048 });
    mockExecute.mockResolvedValue(queryResult);
    mockClient.filesUploadV2.mockResolvedValue({});
    mockClient.chat.update.mockResolvedValue({});
  });

  it('on success, re-renders without the CSV button and marks it exported', async () => {
    const currentBlocks = [
      { type: 'section', text: { type: 'mrkdwn', text: 'answer' } },
      { type: 'actions', elements: [{ type: 'button', action_id: 'override_csv_trace-abc' }] },
    ];
    await handleCsvOverride('thread-1_status-1', 'C-CHAN', 'thread-1', 'msg-ts', 'U-CLICK', currentBlocks, mockClient, overrideConfig);
    expect(mockClient.filesUploadV2).toHaveBeenCalledTimes(1);
    expect(mockClient.chat.update).toHaveBeenCalledTimes(1);
    const updated = JSON.stringify(mockClient.chat.update.mock.calls[0][0].blocks);
    expect(updated).not.toContain('override_csv_');   // CSV button gone
    expect(updated).toContain('CSV exported');          // marker present
  });

  it('preserves a refine-assumptions actions block while dropping only the CSV/override actions', async () => {
    const currentBlocks = [
      { type: 'context', elements: [{ type: 'mrkdwn', text: '🔍 *Assumptions:* x' }] },
      { type: 'actions', elements: [{ type: 'button', action_id: 'refine_assumptions', text: { type: 'plain_text', text: 'Wrong assumptions? Click to refine' } }] },
      { type: 'section', text: { type: 'mrkdwn', text: 'table here' } },
      { type: 'actions', elements: [
        { type: 'button', action_id: 'thumbs_up_trace-abc' },
        { type: 'button', action_id: 'override_csv_trace-abc' },
      ] },
    ];
    await handleCsvOverride('thread-1_status-1', 'C-CHAN', 'thread-1', 'msg-ts', 'U-CLICK', currentBlocks as any, mockClient, overrideConfig);
    const updated = JSON.stringify(mockClient.chat.update.mock.calls[0][0].blocks);
    expect(updated).toContain('refine_assumptions');   // refine button survives
    expect(updated).not.toContain('override_csv_');     // CSV button dropped
    expect(updated).toContain('CSV exported');          // marker present
  });

  it('keeps Table and Summary buttons (only CSV is removed) for a multi-row result', async () => {
    const currentBlocks = [
      { type: 'section', text: { type: 'mrkdwn', text: 'table here' } },
      { type: 'actions', elements: [{ type: 'button', action_id: 'override_csv_trace-abc' }] },
    ];
    await handleCsvOverride('thread-1_status-1', 'C-CHAN', 'thread-1', 'msg-ts', 'U-CLICK', currentBlocks as any, mockClient, overrideConfig);
    const updated = JSON.stringify(mockClient.chat.update.mock.calls[0][0].blocks);
    expect(updated).toContain('override_table_');
    expect(updated).toContain('override_summary_');
    expect(updated).not.toContain('override_csv_');
  });

  it('on failure, posts an ephemeral error to the clicking user (not the public thread)', async () => {
    mockClient.filesUploadV2.mockRejectedValue(new Error('missing_scope'));
    await handleCsvOverride('thread-1_status-1', 'C-CHAN', 'thread-1', 'msg-ts', 'U-CLICK', [], mockClient, overrideConfig);
    expect(mockClient.chat.postEphemeral).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'C-CHAN', user: 'U-CLICK' }),
    );
    expect(mockClient.chat.postMessage).not.toHaveBeenCalled();
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

  it('logs the failure with a trace id when re-execution fails', async () => {
    await handleTableOverride('thread-1_status-1', 'C-CHAN', 'msg-ts', mockClient, overrideConfig);
    expect(vi.mocked(rootLogger.error)).toHaveBeenCalled();
    const [meta, msg] = vi.mocked(rootLogger.error).mock.calls[0];
    expect(msg).toBe('override.table.failed');
    expect((meta as any).traceId).toBe('trace-abc');
  });
});

describe('missing response context', () => {
  const viewer = { userId: 'U1', threadTs: 'thread-root' };

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetCtx.mockResolvedValue(null);
    mockClient.chat.postEphemeral.mockResolvedValue({ ok: true });
  });

  it.each([
    ['table', handleTableOverride],
    ['summary', handleSummaryOverride],
  ] as const)('%s override leaves the delivered answer untouched and tells only the viewer', async (_name, handler) => {
    await handler('thread-1_msg-1', 'C1', 'msg-1', mockClient, overrideConfig, viewer);

    expect(mockClient.chat.update).not.toHaveBeenCalled();
    expect(mockExecute).not.toHaveBeenCalled();
    expect(mockClient.chat.postEphemeral).toHaveBeenCalledWith(expect.objectContaining({
      channel: 'C1',
      user: 'U1',
      thread_ts: 'thread-root',
      text: expect.stringContaining('Response context is unavailable'),
    }));
  });

  it('does not touch the answer when no viewer is known', async () => {
    await handleTableOverride('thread-1_msg-1', 'C1', 'msg-1', mockClient, overrideConfig);
    expect(mockClient.chat.update).not.toHaveBeenCalled();
    expect(mockClient.chat.postEphemeral).not.toHaveBeenCalled();
  });
});

describe('override re-renders hide the button for the view on screen', () => {
  const lastBlocksJson = () => JSON.stringify(mockClient.chat.update.mock.calls.at(-1)[0].blocks);

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetCtx.mockResolvedValue(baseCtx);
    mockValidate.mockResolvedValue({ valid: true, layer: 'all', bytesProcessed: 2048 });
    mockExecute.mockResolvedValue(queryResult);
    mockClient.chat.update.mockResolvedValue({});
    mockClient.filesUploadV2.mockResolvedValue({});
    mockGenerateContent.mockResolvedValue({ text: 'a summary' });
  });

  it('Table override: no Table button, keeps Summary, and leads with the computed caption', async () => {
    await handleTableOverride('thread-1_status-1', 'C-CHAN', 'msg-ts', mockClient, overrideConfig);
    const updated = lastBlocksJson();
    expect(updated).not.toContain('override_table_');
    expect(updated).toContain('override_summary_');
    expect(updated).toContain('*US* has the highest revenue (1000), followed by EU (500).');
  });

  it('Table override: falls back to the persisted headline when the lead-in is ineligible', async () => {
    mockGetCtx.mockResolvedValue({ ...baseCtx, headline: 'Revenue by region' });
    mockExecute.mockResolvedValue({ ...queryResult, truncated: true });
    await handleTableOverride('thread-1_status-1', 'C-CHAN', 'msg-ts', mockClient, overrideConfig);
    const updated = lastBlocksJson();
    expect(updated).toContain('Revenue by region');
    expect(updated).not.toContain('has the highest');
  });

  it('Summary override: no Summary button, keeps Table, and tags the summary view', async () => {
    await handleSummaryOverride('thread-1_status-1', 'C-CHAN', 'msg-ts', mockClient, overrideConfig);
    const updated = lastBlocksJson();
    expect(updated).not.toContain('override_summary_');
    expect(updated).toContain('override_table_');
    expect(updated).toContain('anna_view_summary');
  });

  it('Summary fallback renders a table, so it hides Table and keeps Summary', async () => {
    mockGenerateContent.mockResolvedValue({ text: '' });
    await handleSummaryOverride('thread-1_status-1', 'C-CHAN', 'msg-ts', mockClient, overrideConfig);
    const updated = lastBlocksJson();
    expect(updated).toContain("Couldn't generate a summary");
    expect(updated).not.toContain('override_table_');
    expect(updated).toContain('override_summary_');
  });

  it('CSV export keeps the current view: no Table button under a tagged table', async () => {
    const currentBlocks = [
      { type: 'table', block_id: 'anna_view_table', rows: [] },
      { type: 'actions', elements: [{ type: 'button', action_id: 'override_csv_trace-abc' }] },
    ];
    await handleCsvOverride('thread-1_status-1', 'C-CHAN', 'thread-1', 'msg-ts', 'U-CLICK', currentBlocks as any, mockClient, overrideConfig);
    const updated = JSON.stringify(mockClient.chat.update.mock.calls[0][0].blocks);
    expect(updated).not.toContain('override_table_');
    expect(updated).toContain('override_summary_');
    expect(updated).not.toContain('override_csv_');
  });
});

describe('override re-renders with verified shares (ANSWER_SHARES_ENABLED)', () => {
  const DISTINCT_SQL = 'SELECT ch, COUNT(DISTINCT session_key) AS n FROM `proj.ds.sessions` GROUP BY ch';
  const COUNT_SQL = 'SELECT ch, COUNT(*) AS n FROM `proj.ds.sessions` GROUP BY ch';
  const sharesResult = {
    rows: [{ ch: 'Direct', n: 198 }, { ch: 'Organic', n: 120 }, { ch: 'Unassigned', n: 42 }],
    columnNames: ['ch', 'n'],
    columnTypes: ['STRING', 'INT64'],
    totalRows: 3,
    bytesProcessed: 2048,
    truncated: false,
  };
  const sharesOn = { ...overrideConfig, answerSharesEnabled: true };
  const keyedCtx = { ...baseCtx, generatedSql: DISTINCT_SQL, compositionUniqueKeys: ['proj.ds.sessions.session_key'] };
  const lastBlocks = () => mockClient.chat.update.mock.calls.at(-1)[0].blocks as any[];
  const tableCells = () => lastBlocks().find((b) => b.type === 'table').rows.map((r: any[]) => r.map((c) => c.text));
  const compositionLogs = () => vi.mocked(rootLogger.info).mock.calls.filter(([, msg]) => msg === 'answer.composition');

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetCtx.mockResolvedValue(keyedCtx);
    mockValidate.mockResolvedValue({ valid: true, layer: 'all', bytesProcessed: 2048 });
    mockExecute.mockResolvedValue(sharesResult);
    mockClient.chat.update.mockResolvedValue({});
    mockClient.filesUploadV2.mockResolvedValue({});
    mockGenerateContent.mockResolvedValue({ text: 'a summary' });
  });

  it('Table override renders the same Share column and Total row as the original answer', async () => {
    await handleTableOverride('thread-1_status-1', 'C-CHAN', 'msg-ts', mockClient, sharesOn);
    const original = buildTableBlocks(
      sharesResult.rows, sharesResult.columnNames,
      verifyComposition({ sql: DISTINCT_SQL, result: sharesResult, maxDisplayRows: 20, uniqueKeys: ['proj.ds.sessions.session_key'] }) as any,
    );
    expect(lastBlocks().find((b) => b.type === 'table')).toEqual(original[0]);
    expect(tableCells()[0]).toEqual(['ch', 'n', 'Share']);
    expect(tableCells().at(-1)).toEqual(['Total', '360', '100%']);
    expect(lastBlocks()[0].text.text).toContain('55%');
    expect(compositionLogs()[0][0]).toMatchObject({ event: 'answer.composition', eligible: true, measureKind: 'count', usedUniqueKeyCount: 1, surface: 'override_table', traceId: 'trace-abc' });
  });

  it('Table override on a legacy context without compositionUniqueKeys renders rank-only for COUNT(DISTINCT)', async () => {
    const { compositionUniqueKeys: _omit, ...legacy } = keyedCtx;
    mockGetCtx.mockResolvedValue(legacy);
    await handleTableOverride('thread-1_status-1', 'C-CHAN', 'msg-ts', mockClient, sharesOn);
    expect(tableCells()[0]).toEqual(['ch', 'n']);
    expect(JSON.stringify(lastBlocks())).not.toContain('%');
    expect(lastBlocks()[0].text.text).toContain('has the highest');
  });

  it('Table override with the flag off renders the Phase 1 table even with stored keys', async () => {
    await handleTableOverride('thread-1_status-1', 'C-CHAN', 'msg-ts', mockClient, overrideConfig);
    expect(tableCells()[0]).toEqual(['ch', 'n']);
    expect(compositionLogs()).toHaveLength(0);
  });

  it('Table override: a 21-row result gets no Share column and no lead-in share', async () => {
    mockGetCtx.mockResolvedValue({ ...baseCtx, generatedSql: COUNT_SQL });
    const rows = Array.from({ length: 21 }, (_, i) => ({ ch: `c${i}`, n: 100 - i }));
    mockExecute.mockResolvedValue({ ...sharesResult, rows, totalRows: 21 });
    await handleTableOverride('thread-1_status-1', 'C-CHAN', 'msg-ts', mockClient, sharesOn);
    expect(compositionLogs()[0][0]).toMatchObject({ eligible: false, reason: 'row_count' });
    expect(JSON.stringify(lastBlocks())).not.toContain('"Share"');
    expect(JSON.stringify(lastBlocks())).not.toContain('%');
  });

  it('Summary fallback table carries Share and Total', async () => {
    mockGenerateContent.mockResolvedValue({ text: '' });
    await handleSummaryOverride('thread-1_status-1', 'C-CHAN', 'msg-ts', mockClient, sharesOn);
    expect(JSON.stringify(lastBlocks())).toContain("Couldn't generate a summary");
    expect(tableCells()[0]).toEqual(['ch', 'n', 'Share']);
    expect(tableCells().at(-1)).toEqual(['Total', '360', '100%']);
    expect(compositionLogs()[0][0]).toMatchObject({ event: 'answer.composition', surface: 'override_summary_fallback', traceId: 'trace-abc' });
  });

  it('Summary LLM path is unchanged by the flag (same prompt, same blocks, no Share)', async () => {
    await handleSummaryOverride('thread-1_status-1', 'C-CHAN', 'msg-ts', mockClient, overrideConfig);
    const offPrompt = mockGenerateContent.mock.calls[0][0];
    const offBlocks = lastBlocks();
    vi.clearAllMocks();
    mockGetCtx.mockResolvedValue(keyedCtx);
    mockValidate.mockResolvedValue({ valid: true, layer: 'all', bytesProcessed: 2048 });
    mockExecute.mockResolvedValue(sharesResult);
    mockClient.chat.update.mockResolvedValue({});
    mockGenerateContent.mockResolvedValue({ text: 'a summary' });
    await handleSummaryOverride('thread-1_status-1', 'C-CHAN', 'msg-ts', mockClient, sharesOn);
    expect(mockGenerateContent.mock.calls[0][0]).toEqual(offPrompt);
    expect(lastBlocks()).toEqual(offBlocks);
    expect(JSON.stringify(lastBlocks())).not.toContain('Share');
    expect(compositionLogs()).toHaveLength(0);
  });

  it('CSV export never contains a Share column', async () => {
    await handleCsvOverride('thread-1_status-1', 'C-CHAN', 'thread-1', 'msg-ts', 'U-CLICK', [], mockClient, sharesOn);
    const csv = mockClient.filesUploadV2.mock.calls[0][0].file.toString('utf-8');
    expect(csv.split('\n')[0]).toBe('ch,n');
    expect(csv).not.toContain('Share');
    expect(csv).not.toContain('%');
  });
});
