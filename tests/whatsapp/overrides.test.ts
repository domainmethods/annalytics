import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { QueryResult, ResponseContext } from '../../src/types.js';

vi.mock('../../src/validation/pipeline.js', () => ({ validateSql: vi.fn() }));
vi.mock('../../src/execution/runner.js', () => ({ executeQuery: vi.fn() }));
vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    models = {};
  },
}));
vi.mock('../../src/agents/modelGateway.js', () => ({ generateForNode: vi.fn() }));

import { generateForNode } from '../../src/agents/modelGateway.js';
import { executeQuery } from '../../src/execution/runner.js';
import { validateSql } from '../../src/validation/pipeline.js';
import {
  renderWhatsAppSummaryOverride,
  renderWhatsAppTableOverride,
} from '../../src/whatsapp/overrides.js';

const mockGenerateForNode = vi.mocked(generateForNode);
const mockExecuteQuery = vi.mocked(executeQuery);
const mockValidateSql = vi.mocked(validateSql);

const config = {
  geminiApiKey: 'gemini-key',
  maxBytesProcessed: 1_000_000,
  queryTimeoutMs: 30_000,
  maxResultRows: 25,
};

const responseContext: ResponseContext = {
  surface: 'whatsapp',
  responseId: 'trace-wa-1',
  threadTs: 'whatsapp:15551234567',
  statusMsgTs: 'wamid.answer',
  clarifiedQuestion: 'What was revenue by channel?',
  assumptions: ['Only completed orders.'],
  reasoningChain: 'Grouped revenue by acquisition channel.',
  generatedSql: 'SELECT channel, revenue FROM t',
  explanation: 'Revenue by channel.',
  tablesUsed: ['t'],
  confidence: 'high',
  clarificationConfidence: 'high',
  primaryAgentConfidence: 'high',
  supervisorConfidence: 'high',
  queryResults: {
    rowCount: 2,
    columnNames: ['channel', 'revenue'],
    bytesProcessed: 512,
  },
  pipelineDurationMs: 42,
  traceId: 'trace-wa-1',
  createdAt: new Date('2026-06-23T00:00:00.000Z'),
  groundingCitations: [],
  teachingsUsed: [],
  supervisorVerdict: 'pass',
  supervisorNotes: 'Valid.',
};

const queryResult: QueryResult = {
  rows: [
    { channel: 'paid', revenue: 1000 },
    { channel: 'organic', revenue: 500 },
  ],
  columnNames: ['channel', 'revenue'],
  totalRows: 2,
  bytesProcessed: 512,
  truncated: false,
};

describe('WhatsApp override renderers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockValidateSql.mockResolvedValue({ valid: true, layer: 'all', bytesProcessed: 512 });
    mockExecuteQuery.mockResolvedValue(queryResult);
  });

  it('revalidates and re-executes SQL before rendering a table override', async () => {
    const text = await renderWhatsAppTableOverride(responseContext, config);

    expect(mockValidateSql).toHaveBeenCalledWith(
      'SELECT channel, revenue FROM t',
      1_000_000,
    );
    expect(mockExecuteQuery).toHaveBeenCalledWith('SELECT channel, revenue FROM t', {
      maxRows: 25,
      timeoutMs: 30_000,
      maxBytes: 1_000_000,
    });
    expect(text).toContain('Revenue by channel.');
    expect(text).toContain('paid');
  });

  it('re-executes SQL and uses summaryOverride before rendering a summary override', async () => {
    mockGenerateForNode.mockResolvedValue({
      text: 'Paid channel revenue was the largest, followed by organic.',
    } as Awaited<ReturnType<typeof generateForNode>>);

    const text = await renderWhatsAppSummaryOverride(responseContext, config);

    expect(mockValidateSql).toHaveBeenCalledWith(
      'SELECT channel, revenue FROM t',
      1_000_000,
    );
    expect(mockExecuteQuery).toHaveBeenCalledWith('SELECT channel, revenue FROM t', {
      maxRows: 25,
      timeoutMs: 30_000,
      maxBytes: 1_000_000,
    });
    expect(mockGenerateForNode).toHaveBeenCalledWith(
      'summaryOverride',
      expect.anything(),
      expect.objectContaining({
        contents: [expect.objectContaining({ role: 'user' })],
      }),
    );
    expect(text).toContain('Paid channel revenue was the largest');
    expect(text).toContain('(trace: trace-wa-1)');
  });
});
