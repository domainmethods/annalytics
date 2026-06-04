import * as vega from 'vega';
import { compile } from 'vega-lite';
import { Resvg } from '@resvg/resvg-js';
import type { QueryResult } from '../types.js';

const MAX_CHART_ROWS = 1000;
const CHART_WIDTH = 800;
const CHART_HEIGHT = 500;

export function isChartable(result: QueryResult): boolean {
  if (result.rows.length < 2) return false;
  if (result.columnNames.length < 2) return false;
  const numericColumns = result.columnNames.filter(col =>
    result.rows.some(row => typeof row[col] === 'number'),
  );
  const nonNumericColumns = result.columnNames.filter(col =>
    result.rows.some(row => row[col] != null && typeof row[col] !== 'number'),
  );
  return numericColumns.some(numericCol =>
    nonNumericColumns.some(nonNumericCol => nonNumericCol !== numericCol),
  );
}

export async function renderChart(
  vegaLiteSpec: Record<string, unknown>,
  rows: Record<string, unknown>[],
): Promise<Buffer | null> {
  try {
    const specWithData = {
      ...vegaLiteSpec,
      data: { values: rows.slice(0, MAX_CHART_ROWS) },
      width: CHART_WIDTH,
      height: CHART_HEIGHT,
    };

    const vegaSpec = compile(specWithData as any).spec;
    const view = new vega.View(vega.parse(vegaSpec), { renderer: 'none' });
    const svg = await view.toSVG();
    view.finalize();

    const pngBuffer = new Resvg(svg, {
      fitTo: { mode: 'width', value: CHART_WIDTH },
      background: 'white',
      font: { loadSystemFonts: false },
    }).render().asPng();

    return pngBuffer;
  } catch (error) {
    console.debug('[ChartRenderer] Error rendering chart:', error);
    return null;
  }
}
