import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { ChannelClient, ChannelMessage } from '../../src/channels/types.js';
import type { PipelineConfig } from '../../src/pipeline.js';
import type { QualityResult } from '../../src/qualityLoop.js';
import type { TableContext } from '../../src/dbt/types.js';
import type { ResponseContext } from '../../src/types.js';

vi.mock('../../src/state/clarificationState.js', () => ({
  saveClarificationState: vi.fn(),
}));

vi.mock('../../src/agents/clarificationAgent.js', () => ({ classifyQuestion: vi.fn() }));
vi.mock('../../src/qualityLoop.js', () => ({ qualityLoop: vi.fn() }));
vi.mock('../../src/execution/runner.js', () => ({ executeQuery: vi.fn() }));
vi.mock('../../src/teachings/summaryMap.js', () => ({ getTeachingSummaries: vi.fn(() => []) }));
vi.mock('../../src/dbt/sampleRowCache.js', () => ({ getSampleRows: vi.fn(() => null) }));
vi.mock('../../src/state/responseContext.js', () => ({
  getLatestNegativeFeedback: vi.fn(() => null),
  saveResponseContext: vi.fn(),
}));
vi.mock('../../src/logging.js', () => ({
  createTraceId: () => 'trace-real',
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  logStage: vi.fn(),
  rootLogger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import { runWhatsAppPipeline, answerWhatsAppQuestion } from '../../src/whatsapp/pipeline.js';
import { saveClarificationState } from '../../src/state/clarificationState.js';
import { classifyQuestion } from '../../src/agents/clarificationAgent.js';
import { qualityLoop } from '../../src/qualityLoop.js';
import { executeQuery } from '../../src/execution/runner.js';
import { getTeachingSummaries } from '../../src/teachings/summaryMap.js';
import { getSampleRows } from '../../src/dbt/sampleRowCache.js';
import { getLatestNegativeFeedback } from '../../src/state/responseContext.js';
import { whatsappClarificationId } from '../../src/whatsapp/keys.js';

const mockSaveClarificationState = vi.mocked(saveClarificationState);
const mockClassifyQuestion = vi.mocked(classifyQuestion);
const mockQualityLoop = vi.mocked(qualityLoop);
const mockExecuteQuery = vi.mocked(executeQuery);
const mockGetTeachingSummaries = vi.mocked(getTeachingSummaries);
const mockGetSampleRows = vi.mocked(getSampleRows);
const mockGetLatestNegativeFeedback = vi.mocked(getLatestNegativeFeedback);

const conversation = {
  surface: 'whatsapp' as const,
  conversationId: 'whatsapp:15551234567',
  userId: '15551234567',
};

const message: ChannelMessage = {
  surface: 'whatsapp',
  providerMessageId: 'wamid.inbound',
  conversation,
  text: 'What was revenue yesterday?',
  receivedAt: new Date('2026-06-21T12:00:00.000Z'),
};

function responseContext(overrides: Partial<ResponseContext> = {}): ResponseContext {
  return {
    responseId: 'trace-answer',
    threadTs: '',
    statusMsgTs: '',
    clarifiedQuestion: 'What was revenue yesterday?',
    assumptions: [],
    reasoningChain: 'Summed revenue for yesterday.',
    generatedSql: 'SELECT 123 AS revenue',
    explanation: 'Revenue was 123 yesterday.',
    tablesUsed: ['analytics.fct_orders'],
    confidence: 'high',
    primaryAgentConfidence: 'high',
    supervisorConfidence: 'high',
    queryResults: {
      rowCount: 1,
      columnNames: ['revenue'],
      bytesProcessed: 100,
    },
    pipelineDurationMs: 10,
    traceId: 'trace-answer',
    createdAt: new Date('2026-06-21T12:00:01.000Z'),
    groundingCitations: [],
    teachingsUsed: [],
    supervisorVerdict: 'pass',
    supervisorNotes: 'Approved',
    ...overrides,
  };
}

function createClient(): ChannelClient {
  return {
    sendText: vi.fn()
      .mockResolvedValueOnce({ messageId: 'wamid.ack' })
      .mockResolvedValueOnce({ messageId: 'outbound/A+B=' }),
  };
}

const table: TableContext = {
  name: 'analytics.fct_orders',
  schema: 'analytics',
  description: 'Orders fact table',
  materialization: 'table',
  columns: [
    { name: 'revenue', description: 'Order revenue', dataType: 'NUMERIC', meta: {} },
  ],
  sampleDDL: 'CREATE TABLE analytics.fct_orders (revenue NUMERIC)',
  dependsOn: [],
  tags: [],
};

const config: PipelineConfig = {
  geminiApiKey: 'gemini-key',
  fileSearchStoreId: 'stores/test',
  maxBytesProcessed: 1_000,
  queryTimeoutMs: 30_000,
  maxResultRows: 10,
};

const highClarification = {
  route: 'data_query' as const,
  confidence: 'high' as const,
  reasoning: 'Clear question',
  ambiguities: [],
  assumptions: ['Using UTC dates'],
  clarifying_questions: [],
  resolved_question: 'What was revenue yesterday?',
};

const baseQualityResult: QualityResult = {
  sqlResult: {
    sql: 'SELECT 123 AS revenue',
    explanation: 'Revenue was 123 yesterday.',
    headline: 'revenue yesterday',
    tablesUsed: ['analytics.fct_orders'],
    confidence: 'high',
    assumptions: ['Using UTC dates'],
    reasoningChain: 'Summed revenue.',
    groundingCitations: [],
  },
  verdict: 'pass',
  supervisorNotes: 'Approved',
  finalConfidence: 'high',
  retryCount: 0,
  failureHistory: [],
  bytesProcessed: 100,
};

describe('runWhatsAppPipeline', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('acks, answers, renders, and saves WhatsApp response context', async () => {
    const client = createClient();
    const answerQuestion = vi.fn().mockResolvedValue({
      kind: 'answer',
      explanation: 'Revenue was 123 yesterday.',
      rows: [{ revenue: 123 }],
      columnNames: ['revenue'],
      totalRows: 1,
      assumptions: [],
      traceId: 'trace-answer',
      responseContext: responseContext(),
    });
    const saveResponseContext = vi.fn().mockResolvedValue(undefined);
    const markVisible = vi.fn().mockResolvedValue(undefined);

    const result = await runWhatsAppPipeline({
      message,
      client,
      answerQuestion,
      saveResponseContext,
      markVisible,
    });

    expect(result).toEqual({ visible: true, outcome: 'answer' });
    expect(client.sendText).toHaveBeenNthCalledWith(
      1,
      conversation,
      'Got it. I am checking that now.',
    );
    expect(markVisible).toHaveBeenCalledOnce();
    expect(vi.mocked(client.sendText).mock.invocationCallOrder[0])
      .toBeLessThan(markVisible.mock.invocationCallOrder[0]);
    expect(markVisible.mock.invocationCallOrder[0])
      .toBeLessThan(answerQuestion.mock.invocationCallOrder[0]);
    expect(answerQuestion).toHaveBeenCalledWith({
      question: 'What was revenue yesterday?',
      conversationId: 'whatsapp:15551234567',
      providerMessageId: 'wamid.inbound',
    });
    expect(client.sendText).toHaveBeenNthCalledWith(
      2,
      conversation,
      expect.stringContaining('Revenue was 123 yesterday.'),
    );
    expect(saveResponseContext).toHaveBeenCalledWith(expect.objectContaining({
      threadTs: 'whatsapp:15551234567',
      statusMsgTs: 'outbound/A+B=',
      surface: 'whatsapp',
    }));
  });

  it('sends clarification text and stores WhatsApp clarification state', async () => {
    const client = createClient();
    const messageWithDistinctUserId: ChannelMessage = {
      ...message,
      conversation: {
        ...conversation,
        conversationId: 'whatsapp:conversation-thread',
      },
    };
    const answerQuestion = vi.fn().mockResolvedValue({
      kind: 'clarification',
      questions: ['Which revenue definition should I use?'],
      ambiguities: ['Revenue definition unclear'],
      traceId: 'trace-clarify',
    });
    const saveResponseContext = vi.fn().mockResolvedValue(undefined);

    const result = await runWhatsAppPipeline({
      message: messageWithDistinctUserId,
      client,
      answerQuestion,
      saveResponseContext,
    });

    expect(result).toEqual({ visible: true, outcome: 'clarification' });
    expect(client.sendText).toHaveBeenNthCalledWith(
      2,
      messageWithDistinctUserId.conversation,
      expect.stringContaining('Which revenue definition should I use?'),
    );
    expect(mockSaveClarificationState).toHaveBeenCalledWith({
      clarificationId: whatsappClarificationId('15551234567'),
      threadTs: 'whatsapp:conversation-thread',
      channel: 'whatsapp:conversation-thread',
      originalQuestion: 'What was revenue yesterday?',
      ambiguities: ['Revenue definition unclear'],
      clarifyingMessageTs: 'outbound/A+B=',
    });
    expect(saveResponseContext).not.toHaveBeenCalled();
  });

  it('sends a safe error when the answerer throws and resolves without saving context', async () => {
    const client = createClient();
    const answerQuestion = vi.fn().mockRejectedValue(new Error('raw model failure'));
    const saveResponseContext = vi.fn().mockResolvedValue(undefined);

    await expect(runWhatsAppPipeline({
      message,
      client,
      answerQuestion,
      saveResponseContext,
    })).resolves.toEqual({ visible: true, outcome: 'safe_error' });

    expect(client.sendText).toHaveBeenNthCalledWith(
      2,
      conversation,
      expect.stringContaining("I couldn't complete that request safely."),
    );
    expect(saveResponseContext).not.toHaveBeenCalled();
  });

  it('rethrows when no message was sent and safe error delivery also fails', async () => {
    const client: ChannelClient = {
      sendText: vi.fn()
        .mockRejectedValueOnce(new Error('ack send failed'))
        .mockRejectedValueOnce(new Error('safe error send failed')),
    };
    const answerQuestion = vi.fn();
    const saveResponseContext = vi.fn().mockResolvedValue(undefined);

    await expect(runWhatsAppPipeline({
      message,
      client,
      answerQuestion,
      saveResponseContext,
    })).rejects.toThrow('safe error send failed');

    expect(answerQuestion).not.toHaveBeenCalled();
    expect(saveResponseContext).not.toHaveBeenCalled();
    expect(client.sendText).toHaveBeenCalledTimes(2);
  });

  it('resolves when ack was sent even if later safe error delivery fails', async () => {
    const client: ChannelClient = {
      sendText: vi.fn()
        .mockResolvedValueOnce({ messageId: 'wamid.ack' })
        .mockRejectedValueOnce(new Error('safe error send failed')),
    };
    const answerQuestion = vi.fn().mockRejectedValue(new Error('raw model failure'));
    const saveResponseContext = vi.fn().mockResolvedValue(undefined);

    await expect(runWhatsAppPipeline({
      message,
      client,
      answerQuestion,
      saveResponseContext,
    })).resolves.toEqual({ visible: true, outcome: 'safe_error' });

    expect(saveResponseContext).not.toHaveBeenCalled();
    expect(client.sendText).toHaveBeenCalledTimes(2);
  });

  it('logs response context save failures after sending an answer without sending a safe error', async () => {
    const client = createClient();
    const answerQuestion = vi.fn().mockResolvedValue({
      kind: 'answer',
      explanation: 'Revenue was 123 yesterday.',
      rows: [{ revenue: 123 }],
      columnNames: ['revenue'],
      totalRows: 1,
      assumptions: [],
      traceId: 'trace-answer',
      responseContext: responseContext(),
    });
    const saveResponseContext = vi.fn().mockRejectedValue(new Error('firestore unavailable'));

    await expect(runWhatsAppPipeline({
      message,
      client,
      answerQuestion,
      saveResponseContext,
    })).resolves.toEqual({ visible: true, outcome: 'answer' });

    expect(saveResponseContext).toHaveBeenCalled();
    expect(client.sendText).toHaveBeenCalledTimes(2);
  });
});

describe('answerWhatsAppQuestion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetTeachingSummaries.mockResolvedValue([]);
    mockGetSampleRows.mockResolvedValue(null);
    mockGetLatestNegativeFeedback.mockResolvedValue(null);
    mockClassifyQuestion.mockResolvedValue(highClarification);
    mockQualityLoop.mockResolvedValue(baseQualityResult);
    mockExecuteQuery.mockResolvedValue({
      rows: [{ revenue: 123 }],
      columnNames: ['revenue'],
      totalRows: 1,
      bytesProcessed: 100,
      truncated: false,
    });
  });

  it('returns a query answer from existing stages', async () => {
    const outcome = await answerWhatsAppQuestion({
      question: 'What was revenue yesterday?',
      conversationId: 'whatsapp:15551234567',
      providerMessageId: 'wamid.inbound',
      tables: [table],
      config,
    });

    expect(outcome.kind).toBe('answer');
    if (outcome.kind !== 'answer') throw new Error('Expected answer outcome');
    expect(outcome.explanation).toBe('Revenue was 123 yesterday.');
    expect(outcome.responseContext.surface).toBe('whatsapp');
    expect(mockClassifyQuestion).toHaveBeenCalledWith(
      'What was revenue yesterday?',
      [],
      [],
      'gemini-key',
    );
    expect(mockQualityLoop).toHaveBeenCalledWith(
      expect.objectContaining({
        question: 'What was revenue yesterday?',
        tables: [table],
        threadContext: [],
        apiKey: 'gemini-key',
        fileSearchStoreId: 'stores/test',
      }),
      'gemini-key',
      'What was revenue yesterday?',
      1_000,
    );
    expect(mockExecuteQuery).toHaveBeenCalledWith('SELECT 123 AS revenue', {
      maxRows: 10,
      timeoutMs: 30_000,
      maxBytes: 1_000,
    });
  });

  it('returns a safe answer without executing when supervisor is exhausted', async () => {
    mockQualityLoop.mockResolvedValue({
      ...baseQualityResult,
      sqlResult: { ...baseQualityResult.sqlResult, sql: '' },
      verdict: 'exhausted',
      supervisorNotes: 'Could not validate',
      finalConfidence: 'low',
    });

    const outcome = await answerWhatsAppQuestion({
      question: 'What was revenue yesterday?',
      conversationId: 'whatsapp:15551234567',
      providerMessageId: 'wamid.inbound',
      tables: [table],
      config,
    });

    expect(mockExecuteQuery).not.toHaveBeenCalled();
    expect(outcome.kind).toBe('answer');
    if (outcome.kind !== 'answer') throw new Error('Expected answer outcome');
    expect(outcome.explanation).toBe("I wasn't able to generate a valid query for that question.");
    expect(outcome.responseContext.supervisorVerdict).toBe('exhausted');
  });

  it('returns cost gate text without executing when cost is exceeded', async () => {
    mockQualityLoop.mockResolvedValue({
      ...baseQualityResult,
      verdict: 'cost_exceeded',
      bytesProcessed: 2_000,
    });

    const outcome = await answerWhatsAppQuestion({
      question: 'What was revenue yesterday?',
      conversationId: 'whatsapp:15551234567',
      providerMessageId: 'wamid.inbound',
      tables: [table],
      config,
    });

    expect(mockExecuteQuery).not.toHaveBeenCalled();
    expect(outcome.kind).toBe('answer');
    if (outcome.kind !== 'answer') throw new Error('Expected answer outcome');
    expect(outcome.explanation).toContain('limit');
  });

  it('returns an unsupported answer without SQL generation for non-data-query routes', async () => {
    mockClassifyQuestion.mockResolvedValue({
      ...highClarification,
      route: 'dbt_status',
    });

    const outcome = await answerWhatsAppQuestion({
      question: 'Did the latest dbt run pass?',
      conversationId: 'whatsapp:15551234567',
      providerMessageId: 'wamid.inbound',
      tables: [table],
      config,
    });

    expect(mockQualityLoop).not.toHaveBeenCalled();
    expect(mockExecuteQuery).not.toHaveBeenCalled();
    expect(outcome.kind).toBe('answer');
    if (outcome.kind !== 'answer') throw new Error('Expected answer outcome');
    expect(outcome.explanation).toBe(
      'I can only answer warehouse data questions in this WhatsApp prototype.',
    );
    expect(outcome.responseContext.surface).toBe('whatsapp');
  });
});
