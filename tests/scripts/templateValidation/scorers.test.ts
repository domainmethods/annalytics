import { describe, expect, it, vi } from 'vitest';
import { parse } from 'vega';
import type { ChartSpec } from '../../../src/agents/chartAgent.js';
import type { TeachingCandidate } from '../../../src/state/teachingCandidates.js';
import type { ChartItem, TeachingCandidateItem } from '../../../scripts/template-validation/items.js';
import {
  scoreChart,
  scoreFacts,
  scoreRubric,
  scoreSummaryNumbers,
  scoreSummaryOverride,
  scoreTeachingCandidate,
} from '../../../scripts/template-validation/scorers.js';

vi.mock('vega', () => ({
  parse: vi.fn(),
  View: vi.fn(function () {
    return {
      toSVG: vi.fn().mockResolvedValue('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>'),
      finalize: vi.fn(),
    };
  }),
}));
vi.mock('vega-lite', () => ({ compile: vi.fn(() => ({ spec: {} })) }));

const itemMetadata = {
  id: 'test-item',
  category: 'simple' as const,
  inputHash: '0'.repeat(64),
  agreement: { members: ['test'] },
};

describe('scoreChart', () => {
  const item: ChartItem = {
    ...itemMetadata,
    question: 'How many orders?',
    columnNames: ['orders'],
    sampleRows: [{ orders: 42 }],
    allowedMarks: ['bar'],
  };
  const spec: ChartSpec = {
    chartTitle: 'Orders',
    chartType: 'bar',
    vegaLiteSpec: { mark: { type: 'bar' }, encoding: { y: { field: 'orders' } } },
  };

  it('rejects encodings naming absent fields', async () => {
    const invalid = {
      ...spec,
      vegaLiteSpec: { mark: 'bar', encoding: { tooltip: [{ field: 'missing' }] } },
    };
    await expect(scoreChart(invalid, item)).resolves.toBe(0);
    expect(parse).not.toHaveBeenCalled();
  });

  it('rejects a missing spec or disallowed Vega-Lite mark', async () => {
    await expect(scoreChart(null, item)).resolves.toBe(0);
    const invalid = { ...spec, vegaLiteSpec: { ...spec.vegaLiteSpec, mark: 'line' } };
    await expect(scoreChart(invalid, item)).resolves.toBe(0);
  });

  it('requires a successful render', async () => {
    await expect(scoreChart(spec, item)).resolves.toBe(1);
    vi.mocked(parse).mockImplementationOnce(() => { throw new Error('render failed'); });
    await expect(scoreChart(spec, item)).resolves.toBe(0);
  });
});

describe('scoreSummaryNumbers', () => {
  it.each([0.42, 42])('matches compact currency and a percentage stored as %s', (rate) => {
    expect(scoreSummaryNumbers('Revenue was $1.2M with a 42% margin.', [
      { revenue: 1234567, rate },
    ])).toBe(1);
  });

  it('lowers the score for a hallucinated number', () => {
    expect(scoreSummaryNumbers('Revenue was $1,200 and we had 18 orders.', [{ revenue: 1200 }])).toBe(0.5);
  });

  it('handles suffix scaling, signs, and relative tolerance', () => {
    expect(scoreSummaryNumbers('Net losses were -$1.2k and debt was $2.5B.', [
      { loss: -1249, debt: 2500002000 },
    ])).toBe(1);
    expect(scoreSummaryNumbers('Results were 123.456789.', [{ value: 123.4568 }])).toBe(1);
  });

  it('ignores years in date contexts and counts a standalone four-digit value', () => {
    expect(scoreSummaryNumbers('In January 2024, we had 2025 orders as of 2024-01-15.', [
      { orders: 2025 },
    ])).toBe(1);
    expect(scoreSummaryNumbers('We had 2025 orders.', [])).toBe(0);
  });

  it('ignores ISO timestamps and scores the count that follows', () => {
    expect(scoreSummaryNumbers('As of 2024-01-15T00:00:00Z, there were 42 orders.', [
      { orders: 42 },
    ])).toBe(1);
    expect(scoreSummaryNumbers('As of 2024-01-15T00:00:00.123-05:00, there were 42 orders.', [
      { orders: 42 },
    ])).toBe(1);
  });

  it('counts a quantity before the verb may and skips the year beside the month May', () => {
    const summary = 'Of these, 2024 may qualify for refunds, per May 2025 records.';
    expect(scoreSummaryNumbers(summary, [])).toBe(0);
    expect(scoreSummaryNumbers(summary, [{ orders: 2024 }])).toBe(1);
    expect(scoreSummaryNumbers('2024 May Qualify for Refunds', [])).toBe(0);
  });

  it.each(['In MAY 2024', 'in may 2024', 'In May 2024', 'May 3, 2024', '3 MAY 2024', '2024 May 3'])(
    'skips %s as a date and scores the count',
    (date) => {
      expect(scoreSummaryNumbers(`${date}, there were 42 orders.`, [{ orders: 42 }])).toBe(1);
    },
  );

  it.each([
    ['2024 May 12,345 orders', 12345],
    ['2024 May 12.5 orders per day', 12.5],
    ['2024 May 12k orders', 12000],
  ])('scores the full claim in %s', (summary, orders) => {
    expect(scoreSummaryNumbers(summary, [{ orders }])).toBe(1);
    expect(scoreSummaryNumbers(summary, [])).toBe(0);
  });

  it('counts a percentage immediately after a year and May', () => {
    expect(scoreSummaryNumbers('2024 May 12% conversion', [])).toBe(0);
    expect(scoreSummaryNumbers('2024 May 12% conversion', [{ rate: 0.12 }])).toBe(1);
  });

  it('scores scientific notation as one number and rounds on the exponent scale', () => {
    const summary = 'Revenue was $1.2e6.';
    expect(scoreSummaryNumbers(summary, [{ revenue: 1200000 }])).toBe(1);
    expect(scoreSummaryNumbers(summary, [{ revenue: 1 }])).toBe(0);
    expect(scoreSummaryNumbers(summary, [{ revenue: 1234567 }])).toBe(1);
    expect(scoreSummaryNumbers('The rate was 1.2E-3.', [{ rate: 0.001234 }])).toBe(1);
  });

  it.each([[120, 1], [1.2, 1], [0.012, 0]])(
    'scores a scientific percentage against the row value %s',
    (rate, expected) => {
      expect(scoreSummaryNumbers('The rate was 1.2e2%.', [{ rate }])).toBe(expected);
    },
  );

  it('scores empty and number-free summaries', () => {
    expect(scoreSummaryNumbers('  ', [])).toBe(0);
    expect(scoreSummaryNumbers('Orders increased.', [])).toBe(1);
  });
});

it('scores required facts with case-insensitive containment', () => {
  expect(scoreFacts('Orders SUCCEEDED.', ['orders', 'succeeded', 'yesterday'])).toBe(2 / 3);
  expect(scoreFacts('', [])).toBe(1);
});

it('accepts run facts worded conversationally', () => {
  const facts = ['users', 'success', '2026-10-02T02:00:00Z'];
  expect(scoreFacts('Yes, users passed in the 2 AM UTC run on Oct 2.', facts)).toBe(1);
  expect(scoreFacts('users succeeded at 02:00 UTC on October 2nd', facts)).toBe(1);
  expect(scoreFacts('users: success, 2026-10-02T02:00:00Z', facts)).toBe(1);
  expect(scoreFacts('order items failed and products were skipped', ['order_items', 'error', 'products', 'skipped']))
    .toBe(1);
});

it('keeps run facts strict about the run and the status', () => {
  const fact = ['2026-10-03T02:30:00Z'];
  expect(scoreFacts('It ran at 2:30 AM UTC on Oct 3.', fact)).toBe(1);
  expect(scoreFacts('It ran at 2 AM UTC on Oct 3.', fact)).toBe(0);
  expect(scoreFacts('It ran at 2:30 AM UTC on Oct 13.', fact)).toBe(0);
  expect(scoreFacts('It ran at 12:30 AM UTC on Oct 3.', fact)).toBe(0);
  expect(scoreFacts('The run on Oct 3 was unsuccessful.', ['success'])).toBe(0);
  expect(scoreFacts('Everything passed.', ['error', 'skipped'])).toBe(0);
});

it('rejects a run time on the wrong side of noon', () => {
  expect(scoreFacts('It ran at 2:30 PM UTC on Oct 3.', ['2026-10-03T02:30:00Z'])).toBe(0);
  expect(scoreFacts('It ran at 2:30:00 PM UTC on Oct 3.', ['2026-10-03T02:30:00Z'])).toBe(0);
  expect(scoreFacts('It ran at 12:30 AM UTC on Oct 3.', ['2026-10-03T12:30:00Z'])).toBe(0);
  expect(scoreFacts('It ran at 12:30 PM UTC on Oct 3.', ['2026-10-03T12:30:00Z'])).toBe(1);
  expect(scoreFacts('It ran at 02:30 AM UTC on Oct 3.', ['2026-10-03T02:30:00Z'])).toBe(1);
  expect(scoreFacts('On Oct 2, 2 among 5 models passed.', ['2026-10-02T02:00:00Z'])).toBe(0);
});

it('accepts ISO timestamp variants', () => {
  const fact = ['2026-10-02T02:00:00Z'];
  expect(scoreFacts('Started 2026-10-02T02:00Z.', fact)).toBe(1);
  expect(scoreFacts('Started 2026-10-02T02:00:00.000Z.', fact)).toBe(1);
  expect(scoreFacts('Started at 02:00Z on Oct 2.', fact)).toBe(1);
});

it('halves the score when required models are missing', () => {
  const candidate: TeachingCandidate = {
    candidateId: 'candidate',
    escalationId: 'escalation',
    status: 'pending',
    questionPatterns: [],
    reasoning: '',
    sanctionedSql: 'SELECT 1',
    modelsReferenced: ['orders'],
    tags: [],
    originalQuestion: 'How many orders?',
    humanResponse: 'Use orders.',
    generatedAt: new Date(0),
  };
  const item: TeachingCandidateItem = {
    ...itemMetadata,
    context: {
      escalationId: 'escalation',
      originalQuestion: 'How many orders?',
      clarifiedQuestion: 'How many orders?',
      humanResponse: 'Use orders.',
    },
    expectSanctionedSql: true,
    requiredModels: ['orders', 'users'],
  };
  expect(scoreTeachingCandidate(candidate, item)).toBe(0.5);
});

it('averages rubric facts and counts a throwing judge as false', async () => {
  const judge = vi.fn(async (_text: string, fact: string) => {
    if (fact === 'error') throw new Error('judge failed');
    return fact === 'present';
  });
  await expect(scoreRubric('answer', [], judge)).resolves.toBe(1);
  expect(judge).not.toHaveBeenCalled();
  await expect(scoreRubric('answer', ['present', 'missing', 'error'], judge)).resolves.toBe(1 / 3);
  expect(judge.mock.calls).toEqual([['answer', 'present'], ['answer', 'missing'], ['answer', 'error']]);
});

it('weights numeric accuracy and the summary rubric equally', async () => {
  const judge = vi.fn().mockResolvedValue(false);
  const item = {
    ...itemMetadata,
    question: 'How many orders?',
    sql: 'SELECT 42 AS orders',
    rows: [{ orders: 42 }],
    totalRows: 1,
  };
  await expect(scoreSummaryOverride('42.', item, judge)).resolves.toBe(0.5);
  expect(judge).toHaveBeenCalledWith(
    'Question: How many orders?\nSummary: 42.',
    'answers the question asked',
  );

  judge.mockClear();
  await expect(scoreSummaryOverride('  ', item, judge)).resolves.toBe(0);
  expect(judge).not.toHaveBeenCalled();
});
