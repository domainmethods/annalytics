import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generateChartSpec } from '../../src/agents/chartAgent.js';
import type { ChartSpec } from '../../src/agents/chartAgent.js';

const mockGenerateContent = vi.fn();
vi.mock('@google/genai', () => ({
  GoogleGenAI: vi.fn(function () {
    return {
      models: { generateContent: mockGenerateContent },
    };
  }),
}));

const validChartSpec: ChartSpec = {
  vegaLiteSpec: {
    mark: 'bar',
    encoding: {
      x: { field: 'date', type: 'temporal' },
      y: { field: 'revenue', type: 'quantitative' },
    },
    data: { values: [] },
  },
  chartTitle: 'Revenue Over Time',
  chartType: 'bar',
};

describe('generateChartSpec', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns valid ChartSpec when Flash returns good data', async () => {
    mockGenerateContent.mockResolvedValue({
      text: JSON.stringify(validChartSpec),
    });

    const result = await generateChartSpec({
      question: 'What is revenue by month?',
      columnNames: ['date', 'revenue'],
      sampleRows: [
        { date: '2024-01', revenue: 10000 },
        { date: '2024-02', revenue: 12000 },
      ],
      apiKey: 'test-key',
    });

    expect(result).not.toBeNull();
    expect(result?.chartType).toBe('bar');
    expect(result?.chartTitle).toBe('Revenue Over Time');
    expect(result?.vegaLiteSpec.mark).toBe('bar');
    expect(result?.vegaLiteSpec.encoding).toBeDefined();
  });

  it('returns null when Flash returns invalid JSON', async () => {
    mockGenerateContent.mockResolvedValue({
      text: 'not json',
    });

    const result = await generateChartSpec({
      question: 'What is revenue by month?',
      columnNames: ['date', 'revenue'],
      sampleRows: [{ date: '2024-01', revenue: 10000 }],
      apiKey: 'test-key',
    });

    expect(result).toBeNull();
  });

  it('returns null when spec is missing encoding field', async () => {
    const specMissingEncoding = {
      vegaLiteSpec: {
        mark: 'bar',
        data: { values: [] },
        // encoding is missing
      },
      chartTitle: 'Revenue Over Time',
      chartType: 'bar',
    };

    mockGenerateContent.mockResolvedValue({
      text: JSON.stringify(specMissingEncoding),
    });

    const result = await generateChartSpec({
      question: 'What is revenue by month?',
      columnNames: ['date', 'revenue'],
      sampleRows: [{ date: '2024-01', revenue: 10000 }],
      apiKey: 'test-key',
    });

    expect(result).toBeNull();
  });
});
