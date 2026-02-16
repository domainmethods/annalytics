import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generateWithSupervision } from '../../src/agents/supervisorLoop.js';
import type { SqlGenerationResult } from '../../src/types.js';
import type { SupervisorVerdict } from '../../src/agents/types.js';

vi.mock('../../src/agents/sqlGenerator.js');
vi.mock('../../src/agents/supervisorAgent.js');

import { generateSql } from '../../src/agents/sqlGenerator.js';
import { reviewSql } from '../../src/agents/supervisorAgent.js';

const mockGenerateSql = vi.mocked(generateSql);
const mockReviewSql = vi.mocked(reviewSql);

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
  suggestions: ['Add WHERE order_date >= DATE_SUB(CURRENT_DATE(), INTERVAL 30 DAY)'],
  teaching_compliance: 'deviated',
};

describe('generateWithSupervision — Supervisor Retry Loop', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('passes on first try with "pass" verdict', async () => {
    mockGenerateSql.mockResolvedValue(baseSqlResult);
    mockReviewSql.mockResolvedValue(passVerdict);

    const result = await generateWithSupervision({
      question: 'revenue?',
      tables: [],
      threadContext: [],
      apiKey: 'key',
    }, 'supervisor-key', 'total revenue?');

    expect(result.verdict).toBe('pass');
    expect(result.retryCount).toBe(0);
    expect(mockGenerateSql).toHaveBeenCalledTimes(1);
    expect(mockReviewSql).toHaveBeenCalledTimes(1);
  });

  it('retries on fail and returns "fail_then_pass" verdict', async () => {
    mockGenerateSql
      .mockResolvedValueOnce(baseSqlResult)
      .mockResolvedValueOnce({ ...baseSqlResult, sql: 'SELECT SUM(total_amount) FROM `analytics.fct_orders` WHERE order_date >= CURRENT_DATE() - 30' });
    mockReviewSql
      .mockResolvedValueOnce(failVerdict)
      .mockResolvedValueOnce(passVerdict);

    const result = await generateWithSupervision({
      question: 'revenue?',
      tables: [],
      threadContext: [],
      apiKey: 'key',
    }, 'supervisor-key', 'total revenue?');

    expect(result.verdict).toBe('fail_then_pass');
    expect(result.retryCount).toBe(1);
    expect(mockGenerateSql).toHaveBeenCalledTimes(2);
    expect(mockReviewSql).toHaveBeenCalledTimes(2);
  });

  it('returns "exhausted" with low confidence after 3 failures', async () => {
    mockGenerateSql.mockResolvedValue(baseSqlResult);
    mockReviewSql.mockResolvedValue(failVerdict);

    const result = await generateWithSupervision({
      question: 'revenue?',
      tables: [],
      threadContext: [],
      apiKey: 'key',
    }, 'supervisor-key', 'total revenue?');

    expect(result.verdict).toBe('exhausted');
    expect(result.finalConfidence).toBe('low');
    expect(result.supervisorNotes).toContain('could not approve');
    // 1 initial + 2 retries = 3 supervisor calls
    expect(mockReviewSql).toHaveBeenCalledTimes(3);
    // 1 initial + 2 regenerations = 3 generate calls
    expect(mockGenerateSql).toHaveBeenCalledTimes(3);
  });

  it('passes supervisor issues as previousAttempt error to Primary Agent on retry', async () => {
    mockGenerateSql.mockResolvedValue(baseSqlResult);
    mockReviewSql
      .mockResolvedValueOnce(failVerdict)
      .mockResolvedValueOnce(passVerdict);

    await generateWithSupervision({
      question: 'revenue?',
      tables: [],
      threadContext: [],
      apiKey: 'key',
    }, 'supervisor-key', 'total revenue?');

    // Second generateSql call should include previousAttempt
    const secondCall = mockGenerateSql.mock.calls[1][0];
    expect(secondCall.previousAttempt).toBeDefined();
    expect(secondCall.previousAttempt!.sql).toBe(baseSqlResult.sql);
    expect(secondCall.previousAttempt!.error).toContain('Missing date filter');
  });

  it('makes maximum 3 supervisor calls', async () => {
    mockGenerateSql.mockResolvedValue(baseSqlResult);
    mockReviewSql.mockResolvedValue(failVerdict);

    await generateWithSupervision({
      question: 'revenue?',
      tables: [],
      threadContext: [],
      apiKey: 'key',
    }, 'supervisor-key', 'total revenue?');

    expect(mockReviewSql).toHaveBeenCalledTimes(3);
  });
});
