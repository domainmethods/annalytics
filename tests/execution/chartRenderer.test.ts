import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mocks must be set up BEFORE importing renderChart
vi.mock('vega', () => ({
  parse: vi.fn(() => ({})),
  View: vi.fn(function () {
    return {
      initialize: vi.fn().mockReturnThis(),
      toSVG: vi.fn().mockResolvedValue('<svg>test</svg>'),
      finalize: vi.fn(),
    };
  }),
}));

vi.mock('vega-lite', () => ({
  compile: vi.fn(() => ({ spec: {} })),
}));

vi.mock('sharp', () => ({
  default: vi.fn(() => ({
    png: vi.fn().mockReturnThis(),
    resize: vi.fn().mockReturnThis(),
    toBuffer: vi.fn().mockResolvedValue(Buffer.from('fake-png')),
  })),
}));

import { isChartable, renderChart } from '../../src/execution/chartRenderer.js';
import type { QueryResult } from '../../src/types.js';
import { compile } from 'vega-lite';
import * as vega from 'vega';
import sharp from 'sharp';

function makeResult(overrides: Partial<QueryResult> = {}): QueryResult {
  return {
    rows: [],
    columnNames: [],
    totalRows: 0,
    bytesProcessed: 0,
    truncated: false,
    ...overrides,
  };
}

describe('isChartable', () => {
  it('true for numeric + non-numeric columns with 2+ rows', () => {
    const result = makeResult({
      rows: [
        { name: 'Alice', count: 10 },
        { name: 'Bob', count: 20 },
      ],
      columnNames: ['name', 'count'],
      totalRows: 2,
    });
    expect(isChartable(result)).toBe(true);
  });

  it('false for single row', () => {
    const result = makeResult({
      rows: [{ name: 'Alice', count: 10 }],
      columnNames: ['name', 'count'],
      totalRows: 1,
    });
    expect(isChartable(result)).toBe(false);
  });

  it('false for single column', () => {
    const result = makeResult({
      rows: [
        { count: 10 },
        { count: 20 },
      ],
      columnNames: ['count'],
      totalRows: 2,
    });
    expect(isChartable(result)).toBe(false);
  });

  it('false for zero rows', () => {
    const result = makeResult({
      rows: [],
      columnNames: ['name', 'count'],
      totalRows: 0,
    });
    expect(isChartable(result)).toBe(false);
  });

  it('false when rows array empty but totalRows > 0', () => {
    const result = makeResult({
      rows: [],
      columnNames: ['name', 'count'],
      totalRows: 100,
    });
    expect(isChartable(result)).toBe(false);
  });

  it('false for all-string columns', () => {
    const result = makeResult({
      rows: [
        { name: 'Alice', city: 'NYC' },
        { name: 'Bob', city: 'LA' },
      ],
      columnNames: ['name', 'city'],
      totalRows: 2,
    });
    expect(isChartable(result)).toBe(false);
  });
});

describe('renderChart', () => {
  const compileMock = compile as ReturnType<typeof vi.fn>;
  const ViewMock = vega.View as unknown as ReturnType<typeof vi.fn>;
  const parseMock = vega.parse as ReturnType<typeof vi.fn>;
  const sharpMock = sharp as unknown as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    // Re-setup default mock implementations after clearAllMocks
    parseMock.mockReturnValue({});
    ViewMock.mockImplementation(function () {
      return {
        initialize: vi.fn().mockReturnThis(),
        toSVG: vi.fn().mockResolvedValue('<svg>test</svg>'),
        finalize: vi.fn(),
      };
    });
    compileMock.mockReturnValue({ spec: {} });
    sharpMock.mockReturnValue({
      png: vi.fn().mockReturnThis(),
      resize: vi.fn().mockReturnThis(),
      toBuffer: vi.fn().mockResolvedValue(Buffer.from('fake-png')),
    });
  });

  it('renders a spec to a PNG buffer', async () => {
    const spec = { mark: 'bar', encoding: {} };
    const rows = [
      { name: 'Alice', count: 10 },
      { name: 'Bob', count: 20 },
    ];
    const result = await renderChart(spec, rows);
    expect(result).toBeInstanceOf(Buffer);
  });

  it('returns null when vega-lite compile throws', async () => {
    compileMock.mockImplementation(() => {
      throw new Error('compile failed');
    });
    const result = await renderChart({ mark: 'bar' }, [{ name: 'Alice', count: 10 }]);
    expect(result).toBeNull();
  });
});
