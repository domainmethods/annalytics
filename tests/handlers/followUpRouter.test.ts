import { describe, it, expect, vi, beforeEach } from 'vitest';
import { routeFollowUp } from '../../src/handlers/followUpRouter.js';
import type { ResponseContext } from '../../src/types.js';
import type { PipelineConfig } from '../../src/pipeline.js';

const mockGetLatestResponseContext = vi.fn();
vi.mock('../../src/state/responseContext.js', () => ({
  getLatestResponseContext: (...args: unknown[]) => mockGetLatestResponseContext(...args),
}));

const mockHandleMetaQuestion = vi.fn();
vi.mock('../../src/agents/metaQuestionHandler.js', () => ({
  handleMetaQuestion: (...args: unknown[]) => mockHandleMetaQuestion(...args),
}));

const mockBuildRefinementInput = vi.fn();
vi.mock('../../src/agents/refinementHandler.js', () => ({
  buildRefinementInput: (...args: unknown[]) => mockBuildRefinementInput(...args),
}));

const mockGenerateDiagnosticSql = vi.fn();
vi.mock('../../src/agents/discrepancyHandler.js', () => ({
  generateDiagnosticSql: (...args: unknown[]) => mockGenerateDiagnosticSql(...args),
}));

const mockRunPipeline = vi.fn();
vi.mock('../../src/pipeline.js', async (importOriginal) => {
  const orig = await importOriginal() as Record<string, unknown>;
  return { ...orig, runPipeline: (...args: unknown[]) => mockRunPipeline(...args) };
});

const mockValidateSql = vi.fn();
vi.mock('../../src/validation/pipeline.js', () => ({
  validateSql: (...args: unknown[]) => mockValidateSql(...args),
}));

const mockExecuteQuery = vi.fn();
vi.mock('../../src/execution/runner.js', () => ({
  executeQuery: (...args: unknown[]) => mockExecuteQuery(...args),
}));

const mockReviewSql = vi.fn();
vi.mock('../../src/agents/supervisorAgent.js', () => ({
  reviewSql: (...args: unknown[]) => mockReviewSql(...args),
}));

const mockClient = {
  chat: {
    update: vi.fn().mockResolvedValue({}),
    postMessage: vi.fn().mockResolvedValue({ ts: 'new-msg-ts' }),
  },
} as any;

const baseCtx: ResponseContext = {
  responseId: 'resp-1',
  threadTs: '1234.5678',
  statusMsgTs: '1234.5679',
  clarifiedQuestion: 'What is total revenue?',
  assumptions: [],
  reasoningChain: 'Used fct_orders',
  generatedSql: 'SELECT SUM(revenue) FROM fct_orders',
  explanation: 'Summed revenue',
  tablesUsed: ['fct_orders'],
  confidence: 'high',
  primaryAgentConfidence: 'high',
  queryResults: { rowCount: 1, columnNames: ['total'], bytesProcessed: 500 },
  pipelineDurationMs: 2000,
  traceId: 'trace-1',
  createdAt: new Date(),
  groundingCitations: [],
  teachingsUsed: [],
  supervisorVerdict: 'pass',
  supervisorNotes: '',
};

const pipelineConfig: PipelineConfig = {
  geminiApiKey: 'test-key',
  geminiModel: 'gemini-3.0-pro',
  maxBytesProcessed: 1e9,
  queryTimeoutMs: 30000,
  maxResultRows: 1000,
};

const tables = [{ name: 'fct_orders', description: 'Orders', columns: [], sampleDDL: '' }] as any;

describe('routeFollowUp', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetLatestResponseContext.mockResolvedValue(baseCtx);
  });

  it('meta_question — calls handleMetaQuestion and posts answer', async () => {
    mockHandleMetaQuestion.mockResolvedValue('I used fct_orders because it has the revenue column.');

    await routeFollowUp(
      'meta_question', 'Why did you use fct_orders?',
      '1234.5678', 'C123', 'status-ts', mockClient, pipelineConfig, tables,
    );

    expect(mockHandleMetaQuestion).toHaveBeenCalledWith(
      'Why did you use fct_orders?', baseCtx, 'test-key',
    );
    expect(mockClient.chat.update).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'C123',
        ts: 'status-ts',
        text: 'I used fct_orders because it has the revenue column.',
      }),
    );
    expect(mockRunPipeline).not.toHaveBeenCalled();
  });

  it('refinement — builds composite question and runs pipeline with refinement hint', async () => {
    mockBuildRefinementInput.mockReturnValue({
      compositeQuestion: 'What is total revenue? (Refinement: break down by region)',
      previousSql: 'SELECT SUM(revenue) FROM fct_orders',
    });
    mockRunPipeline.mockResolvedValue(undefined);

    await routeFollowUp(
      'refinement', 'break down by region',
      '1234.5678', 'C123', 'status-ts', mockClient, pipelineConfig, tables,
    );

    expect(mockBuildRefinementInput).toHaveBeenCalledWith('break down by region', baseCtx);
    expect(mockRunPipeline).toHaveBeenCalledWith(
      expect.objectContaining({
        question: 'What is total revenue? (Refinement: break down by region)',
        refinementHint: { previousSql: 'SELECT SUM(revenue) FROM fct_orders' },
      }),
    );
  });

  it('discrepancy — generates diagnostic SQL, validates, executes, posts findings', async () => {
    mockGenerateDiagnosticSql.mockResolvedValue({
      diagnosticSql: 'SELECT region, SUM(revenue) FROM fct_orders GROUP BY region',
      explanation: 'Breaking down by region to check APAC',
    });
    mockValidateSql.mockResolvedValue({ valid: true, layer: 'L4', bytesProcessed: 500 });
    mockReviewSql.mockResolvedValue({ verdict: 'PASS', confidence: 'high', issues: [], suggestions: [], teaching_compliance: 'no_relevant_teaching' });
    mockExecuteQuery.mockResolvedValue({
      rows: [{ region: 'APAC', total: 200000 }, { region: 'EMEA', total: 4800000 }],
      columnNames: ['region', 'total'],
      totalRows: 2,
      bytesProcessed: 500,
      truncated: false,
    });

    await routeFollowUp(
      'discrepancy', 'How come APAC is only $200K?',
      '1234.5678', 'C123', 'status-ts', mockClient, pipelineConfig, tables,
    );

    expect(mockGenerateDiagnosticSql).toHaveBeenCalledWith(
      'How come APAC is only $200K?', baseCtx, 'test-key',
    );
    expect(mockValidateSql).toHaveBeenCalledWith(
      'SELECT region, SUM(revenue) FROM fct_orders GROUP BY region',
      1e9,
    );
    expect(mockExecuteQuery).toHaveBeenCalled();
    expect(mockClient.chat.update).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'C123',
        ts: 'status-ts',
        text: expect.stringContaining('Breaking down by region to check APAC'),
      }),
    );
  });

  it('new_query — runs standard pipeline', async () => {
    mockRunPipeline.mockResolvedValue(undefined);

    await routeFollowUp(
      'new_query', 'How many customers?',
      '1234.5678', 'C123', 'status-ts', mockClient, pipelineConfig, tables,
    );

    expect(mockRunPipeline).toHaveBeenCalledWith(
      expect.objectContaining({
        question: 'How many customers?',
        channel: 'C123',
        threadTs: '1234.5678',
        statusMsgTs: 'status-ts',
      }),
    );
    expect(mockHandleMetaQuestion).not.toHaveBeenCalled();
    expect(mockGenerateDiagnosticSql).not.toHaveBeenCalled();
  });
});
