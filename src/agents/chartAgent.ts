import { GoogleGenAI } from '@google/genai';
import { generateForNode } from './modelGateway.js';

export interface ChartSpecInput {
  question: string;
  columnNames: string[];
  sampleRows: Record<string, unknown>[];
  apiKey: string;
}

export interface ChartSpec {
  vegaLiteSpec: Record<string, unknown>;
  chartTitle: string;
  chartType: 'bar' | 'line' | 'scatter' | 'area' | 'pie' | 'heatmap';
}

const chartResponseSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object' as const,
  properties: {
    vegaLiteSpec: { type: 'object', description: 'Complete vega-lite spec with mark and encoding' },
    chartTitle: { type: 'string' },
    chartType: { type: 'string', enum: ['bar', 'line', 'scatter', 'area', 'pie', 'heatmap'] },
  },
  required: ['vegaLiteSpec', 'chartTitle', 'chartType'],
};

export async function generateChartSpec(input: ChartSpecInput): Promise<ChartSpec | null> {
  try {
    const ai = new GoogleGenAI({ apiKey: input.apiKey });
    const sampleData = input.sampleRows.slice(0, 20);
    const prompt = `Given these query results, generate a vega-lite chart spec.

Question: ${input.question}
Columns: ${input.columnNames.join(', ')}
Sample data (${sampleData.length} rows):
${JSON.stringify(sampleData, null, 2)}

Rules:
- Pick the most appropriate chart type for the data shape
- Use line/area for time-series, bar for categorical comparisons, scatter for correlations
- Keep specs simple — no layered or faceted charts
- Use data.values as an empty array placeholder (data will be injected)
- Include proper axis labels from column names`;

    const response = await generateForNode('chart', ai, {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      config: {
        responseMimeType: 'application/json',
        responseJsonSchema: chartResponseSchema,
      },
    });

    const text = response.text;
    if (!text) return null;

    const parsed = JSON.parse(text);
    if (!parsed.vegaLiteSpec?.encoding || !parsed.vegaLiteSpec?.mark) return null;

    return parsed as ChartSpec;
  } catch (error) {
    console.debug('[ChartAgent] Error generating chart spec:', error);
    return null;
  }
}
