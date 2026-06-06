import { describe, it, expect } from 'vitest';
import { renderChart } from '../../src/execution/chartRenderer.js';

// Deliberately NO mocks. The sibling chartRenderer.test.ts mocks vega/vega-lite/
// resvg, so it never runs the real dynamic import('vega') — and would stay green
// even if production crashed. This guard exercises the actual ESM import path.
//
// vega is ESM-only with top-level await, so `require('vega')` throws
// ERR_REQUIRE_ASYNC_MODULE at runtime. The renderer avoids that by loading vega
// via dynamic import(), which TS preserves as real ESM ONLY while two things
// hold: the loader uses import() (not a static import), and tsconfig stays on
// `module: NodeNext`. Break either and the compiler re-emits require('vega') —
// and since renderChart swallows errors into null, charts would silently vanish
// instead of failing loudly. This test pins both invariants.
describe('renderChart — real vega/resvg ESM path (no mocks)', () => {
  it('loads vega via dynamic import and rasterizes a valid PNG', async () => {
    const spec = {
      $schema: 'https://vega.github.io/schema/vega-lite/v6.json',
      mark: 'bar',
      encoding: {
        x: { field: 'channel', type: 'nominal' },
        y: { field: 'leads', type: 'quantitative' },
      },
    };
    const rows = [
      { channel: 'paid', leads: 120 },
      { channel: 'organic', leads: 200 },
      { channel: 'referral', leads: 75 },
    ];

    const png = await renderChart(spec, rows);

    expect(png).toBeInstanceOf(Buffer);
    // PNG magic number — proves resvg actually rasterized real vega SVG output,
    // not that a swallowed error returned a stray buffer.
    expect(png!.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    expect(png!.length).toBeGreaterThan(100);
  }, 20_000);
});
