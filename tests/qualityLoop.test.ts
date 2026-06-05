import { describe, it, expect, vi, beforeEach } from 'vitest';
import { qualityLoop } from '../src/qualityLoop.js';
import type { SqlGenerationResult } from '../src/types.js';
import type { SupervisorVerdict } from '../src/agents/types.js';
import type { StatusCallbacks } from '../src/qualityLoop.js';

vi.mock('../src/agents/sqlGenerator.js');
vi.mock('../src/agents/supervisorAgent.js');
vi.mock('../src/validation/staticAnalysis.js');
vi.mock('../src/validation/astValidation.js');
vi.mock('../src/validation/dryRun.js');
vi.mock('../src/validation/costGate.js');

import { generateSql } from '../src/agents/sqlGenerator.js';
import { reviewSql } from '../src/agents/supervisorAgent.js';
import { staticAnalysis } from '../src/validation/staticAnalysis.js';
import { astValidation } from '../src/validation/astValidation.js';
import { dryRunValidation } from '../src/validation/dryRun.js';
import { costGate } from '../src/validation/costGate.js';

const mockGenerateSql = vi.mocked(generateSql);
const mockReviewSql = vi.mocked(reviewSql);
const mockStaticAnalysis = vi.mocked(staticAnalysis);
const mockAstValidation = vi.mocked(astValidation);
const mockDryRun = vi.mocked(dryRunValidation);
const mockCostGate = vi.mocked(costGate);

const baseSqlResult: SqlGenerationResult = {
  sql: 'SELECT SUM(total_amount) FROM `analytics.fct_orders`',
  explanation: 'Sums total amount',
  tablesUsed: ['analytics.fct_orders'],
  confidence: 'high',
  assumptions: [],
  reasoningChain: 'Simple sum',
  groundingCitations: [],
};

const passVerdict: SupervisorVerdict = {
  verdict: 'PASS',
  confidence: 'high',
  issues: [],
  suggestions: [],
  teaching_compliance: 'compliant',
};

const failVerdict: SupervisorVerdict = {
  verdict: 'FAIL',
  confidence: 'low',
  issues: ['Missing date filter'],
  suggestions: ['Add WHERE clause'],
  teaching_compliance: 'deviated',
};

const baseOptions = {
  question: 'total revenue?',
  tables: [],
  threadContext: [],
  apiKey: 'key',
};

function setupPassingValidation(bytesProcessed = 1000) {
  mockStaticAnalysis.mockReturnValue({ valid: true, layer: 'L1' });
  mockAstValidation.mockReturnValue({ valid: true, layer: 'L2' });
  mockDryRun.mockResolvedValue({ valid: true, layer: 'L3', bytesProcessed });
  mockCostGate.mockReturnValue({ valid: true, layer: 'L4' });
}

describe('qualityLoop', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    setupPassingValidation();
    mockGenerateSql.mockResolvedValue(baseSqlResult);
    mockReviewSql.mockResolvedValue(passVerdict);
  });

  // 1. Happy path — pass on first try
  it('returns pass verdict when all checks succeed on first attempt', async () => {
    const result = await qualityLoop(baseOptions, 'supervisor-key', 'total revenue?', 1_000_000);

    expect(result.verdict).toBe('pass');
    expect(result.retryCount).toBe(0);
    expect(result.failureHistory).toHaveLength(0);
    expect(result.validationHistory).toEqual(expect.arrayContaining([
      expect.objectContaining({ attempt: 0, layer: 'l1', valid: true }),
      expect.objectContaining({ attempt: 0, layer: 'l2', valid: true }),
      expect.objectContaining({ attempt: 0, layer: 'l3', valid: true, bytesProcessed: 1000 }),
      expect.objectContaining({ attempt: 0, layer: 'l4', valid: true }),
    ]));
    expect(result.sqlResult).toEqual(baseSqlResult);
    expect(result.finalConfidence).toBe('high');
    expect(result.bytesProcessed).toBe(1000);
    expect(mockGenerateSql).toHaveBeenCalledTimes(1);
    expect(mockReviewSql).toHaveBeenCalledTimes(1);
  });

  // 2. L1 structural block then retry succeeds
  it('retries on L1 static analysis failure and returns fail_then_pass', async () => {
    mockStaticAnalysis
      .mockReturnValueOnce({ valid: false, layer: 'L1', error: 'DML blocked' })
      .mockReturnValue({ valid: true, layer: 'L1' });

    const result = await qualityLoop(baseOptions, 'supervisor-key', 'total revenue?', 1_000_000);

    expect(result.verdict).toBe('fail_then_pass');
    expect(result.retryCount).toBe(1);
    expect(result.failureHistory).toHaveLength(1);
    expect(result.failureHistory[0]).toEqual({
      attempt: 0,
      failureType: 'structural',
      detail: 'DML blocked',
    });
    expect(mockGenerateSql).toHaveBeenCalledTimes(2);
    // Supervisor not called on first attempt (L1 blocked before reaching it)
    expect(mockReviewSql).toHaveBeenCalledTimes(1);
  });

  // 3. L3 dry-run fail then retry succeeds
  it('retries on L3 dry-run failure and returns fail_then_pass', async () => {
    mockDryRun
      .mockResolvedValueOnce({ valid: false, layer: 'L3', error: 'Table not found' })
      .mockResolvedValue({ valid: true, layer: 'L3', bytesProcessed: 2000 });

    const result = await qualityLoop(baseOptions, 'supervisor-key', 'total revenue?', 1_000_000);

    expect(result.verdict).toBe('fail_then_pass');
    expect(result.failureHistory).toHaveLength(1);
    expect(result.failureHistory[0].failureType).toBe('dry_run');
    expect(result.failureHistory[0].detail).toBe('Table not found');
    // Supervisor only called on successful attempt
    expect(mockReviewSql).toHaveBeenCalledTimes(1);
  });

  // 4. Supervisor FAIL then retry succeeds
  it('retries on supervisor FAIL and passes dryRunMetadata', async () => {
    mockReviewSql
      .mockResolvedValueOnce(failVerdict)
      .mockResolvedValueOnce(passVerdict);

    const result = await qualityLoop(baseOptions, 'supervisor-key', 'total revenue?', 1_000_000);

    expect(result.verdict).toBe('fail_then_pass');
    expect(result.failureHistory).toHaveLength(1);
    expect(result.failureHistory[0].failureType).toBe('semantic');
    expect(result.failureHistory[0].detail).toContain('Missing date filter');

    // Verify dryRunMetadata was passed to reviewSql
    const firstReviewCall = mockReviewSql.mock.calls[0][0];
    expect(firstReviewCall.dryRunMetadata).toEqual({ bytesProcessed: 1000 });
  });

  // 5. All 3 attempts fail L3 — exhausted
  it('returns exhausted when all 3 attempts fail dry-run', async () => {
    mockDryRun.mockResolvedValue({ valid: false, layer: 'L3', error: 'Invalid table' });

    const result = await qualityLoop(baseOptions, 'supervisor-key', 'total revenue?', 1_000_000);

    expect(result.verdict).toBe('exhausted');
    expect(result.finalConfidence).toBe('low');
    expect(result.failureHistory).toHaveLength(3);
    expect(result.failureHistory.every(f => f.failureType === 'dry_run')).toBe(true);
    expect(result.supervisorNotes).toContain('Quality loop exhausted');
    // Supervisor never called — all blocked at L3
    expect(mockReviewSql).toHaveBeenCalledTimes(0);
    expect(mockGenerateSql).toHaveBeenCalledTimes(3);
  });

  // 6. All 3 attempts fail supervisor — exhausted
  it('returns exhausted when all 3 supervisor reviews fail', async () => {
    mockReviewSql.mockResolvedValue(failVerdict);

    const result = await qualityLoop(baseOptions, 'supervisor-key', 'total revenue?', 1_000_000);

    expect(result.verdict).toBe('exhausted');
    expect(result.finalConfidence).toBe('low');
    expect(result.failureHistory).toHaveLength(3);
    expect(result.failureHistory.every(f => f.failureType === 'semantic')).toBe(true);
    expect(mockGenerateSql).toHaveBeenCalledTimes(3);
    expect(mockReviewSql).toHaveBeenCalledTimes(3);
  });

  // 7. Mixed failure types across attempts
  it('records mixed failure types in failureHistory', async () => {
    // Attempt 0: L1 blocks (dryRun not called)
    mockStaticAnalysis
      .mockReturnValueOnce({ valid: false, layer: 'L1', error: 'DML' })
      .mockReturnValue({ valid: true, layer: 'L1' });
    // Attempt 1: L3 blocks (first actual dryRun call)
    mockDryRun
      .mockResolvedValueOnce({ valid: false, layer: 'L3', error: 'Unknown column' })
      .mockResolvedValue({ valid: true, layer: 'L3', bytesProcessed: 1000 });
    // Attempt 2: passes

    const result = await qualityLoop(baseOptions, 'supervisor-key', 'total revenue?', 1_000_000);

    expect(result.verdict).toBe('fail_then_pass');
    expect(result.retryCount).toBe(2);
    expect(result.failureHistory).toHaveLength(2);
    expect(result.failureHistory[0].failureType).toBe('structural');
    expect(result.failureHistory[1].failureType).toBe('dry_run');
  });

  // 8. Cost gate exceeded after successful loop
  it('returns cost_exceeded when cost gate blocks', async () => {
    mockCostGate.mockReturnValue({ valid: false, layer: 'L4', error: 'Cost exceeded' });

    const result = await qualityLoop(baseOptions, 'supervisor-key', 'total revenue?', 500);

    expect(result.verdict).toBe('cost_exceeded');
    expect(result.failureHistory).toHaveLength(0);
    expect(result.validationHistory).toEqual(expect.arrayContaining([
      expect.objectContaining({ attempt: 0, layer: 'l4', valid: false, detail: 'Cost exceeded' }),
    ]));
    expect(result.retryCount).toBe(0);
    expect(result.supervisorNotes).toBeTruthy();
  });

  // 9. L2 advisory pass-through — parse failure does not consume retry budget
  it('L2 AST parse failure passes through to L3 without consuming retry budget', async () => {
    mockAstValidation.mockReturnValue({ valid: false, layer: 'L2', error: 'Parse error' });

    const result = await qualityLoop(baseOptions, 'supervisor-key', 'total revenue?', 1_000_000);

    // Should still pass — L2 is advisory only
    expect(result.verdict).toBe('pass');
    expect(result.failureHistory).toHaveLength(0);
    expect(result.validationHistory).toEqual(expect.arrayContaining([
      expect.objectContaining({ attempt: 0, layer: 'l2', valid: false, detail: 'Parse error' }),
      expect.objectContaining({ attempt: 0, layer: 'l3', valid: true }),
    ]));
    expect(result.retryCount).toBe(0);
    expect(mockDryRun).toHaveBeenCalledTimes(1); // L3 was still reached
    expect(mockReviewSql).toHaveBeenCalledTimes(1); // Supervisor was still reached
  });

  // 10. Status callbacks invocation order
  it('calls status callbacks in correct order', async () => {
    const callOrder: string[] = [];
    const callbacks: StatusCallbacks = {
      onGenerate: () => { callOrder.push('generate'); },
      onValidate: () => { callOrder.push('validate'); },
      onReview: () => { callOrder.push('review'); },
      onRetry: (n) => { callOrder.push(`retry-${n}`); },
    };

    const result = await qualityLoop(baseOptions, 'supervisor-key', 'total revenue?', 1_000_000, callbacks);

    expect(result.verdict).toBe('pass');
    expect(callOrder).toEqual(['generate', 'validate', 'review']);
  });

  it('calls onRetry callback before subsequent attempts', async () => {
    const callOrder: string[] = [];
    const callbacks: StatusCallbacks = {
      onGenerate: () => { callOrder.push('generate'); },
      onValidate: () => { callOrder.push('validate'); },
      onReview: () => { callOrder.push('review'); },
      onRetry: (n) => { callOrder.push(`retry-${n}`); },
    };

    mockReviewSql
      .mockResolvedValueOnce(failVerdict)
      .mockResolvedValueOnce(passVerdict);

    await qualityLoop(baseOptions, 'supervisor-key', 'total revenue?', 1_000_000, callbacks);

    expect(callOrder).toEqual([
      'generate', 'validate', 'review',    // attempt 0
      'retry-1', 'generate', 'validate', 'review',  // attempt 1
    ]);
  });

  // 11. previousAttempt error feedback is passed on retry
  it('passes previousAttempt error to generateSql on retry after L1 failure', async () => {
    mockStaticAnalysis
      .mockReturnValueOnce({ valid: false, layer: 'L1', error: 'DML blocked' })
      .mockReturnValue({ valid: true, layer: 'L1' });

    await qualityLoop(baseOptions, 'supervisor-key', 'total revenue?', 1_000_000);

    const secondCall = mockGenerateSql.mock.calls[1][0];
    expect(secondCall.previousAttempt).toBeDefined();
    expect(secondCall.previousAttempt!.sql).toBe(baseSqlResult.sql);
    expect(secondCall.previousAttempt!.error).toContain('DML blocked');
  });

  it('passes supervisor issues as previousAttempt error on retry', async () => {
    mockReviewSql
      .mockResolvedValueOnce(failVerdict)
      .mockResolvedValueOnce(passVerdict);

    await qualityLoop(baseOptions, 'supervisor-key', 'total revenue?', 1_000_000);

    const secondCall = mockGenerateSql.mock.calls[1][0];
    expect(secondCall.previousAttempt).toBeDefined();
    expect(secondCall.previousAttempt!.error).toContain('Missing date filter');
    expect(secondCall.previousAttempt!.error).toContain('Add WHERE clause');
  });
});
