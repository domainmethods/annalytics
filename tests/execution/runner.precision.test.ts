import { expect, it, vi } from 'vitest';
import { executeQuery, getBigQueryClient, initBigQueryClient } from '../../src/execution/runner.js';
import { buildTableBlocks } from '../../src/slack/blocks.js';
import { renderWhatsAppQueryAnswer } from '../../src/whatsapp/renderer.js';

it('preserves INT64 values through the SDK decoder and chat table renderers', async () => {
  const cases = [
    ['9007199254740993', '9007199254740993'],
    ['-9007199254740993', '-9007199254740993'],
    ['9007199254740991', Number.MAX_SAFE_INTEGER],
    ['-9007199254740991', Number.MIN_SAFE_INTEGER],
    ['9007199254740992', '9007199254740992'],
    ['-9007199254740992', '-9007199254740992'],
    ['9223372036854775807', '9223372036854775807'],
    ['-9223372036854775808', '-9223372036854775808'],
  ] as const;
  const schema = {
    fields: [
      { name: 'id', type: 'INTEGER' },
      { name: 'nested', type: 'RECORD', fields: [{ name: 'ids', type: 'INT64', mode: 'REPEATED' }] },
      { name: 'ratio', type: 'FLOAT' },
    ],
  };
  const rows = cases.map(([value]) => ({
    f: [
      { v: value },
      { v: { f: [{ v: [{ v: '42' }, { v: value }] }] } },
      { v: '1.25' },
    ],
  }));
  const maxRows = rows.length;

  initBigQueryClient('test-project');
  const request = vi.spyOn(getBigQueryClient(), 'request').mockImplementation(({ uri, json, qs }, callback) => {
    if (uri === '/jobs') {
      callback(null, { jobReference: json.jobReference, status: { state: 'DONE' } });
    } else if (uri.startsWith('/queries/') && !qs?.pageToken) {
      // A short first page: the API capped it before maxResults (#38).
      callback(null, { schema, rows: rows.slice(0, 3), jobComplete: true, totalRows: String(maxRows + 1), pageToken: 'page-2' });
    } else if (uri.startsWith('/queries/') && qs?.pageToken === 'page-2') {
      callback(null, { schema, rows: rows.slice(3), jobComplete: true, totalRows: String(maxRows + 1), pageToken: 'page-3' });
    } else if (uri.startsWith('jobs/')) {
      // The row count lives on the results response, not job statistics (#38).
      callback(null, { statistics: { query: {} } });
    } else {
      callback(new Error(`Unexpected BigQuery request: ${uri}`));
    }
  });

  const result = await executeQuery('SELECT id, nested, ratio FROM synthetic_data', {
    maxRows,
    timeoutMs: 30_000,
    maxBytes: 10_000_000,
  });

  expect(result.rows).toEqual(cases.map(([, value]) => ({
    id: value,
    nested: { ids: [42, value] },
    ratio: 1.25,
  })));
  expect(request).toHaveBeenCalledWith(expect.objectContaining({
    uri: expect.stringMatching(/^\/queries\//),
    qs: expect.objectContaining({ maxResults: maxRows }),
  }), expect.any(Function));
  expect(request).toHaveBeenCalledWith(expect.objectContaining({
    qs: expect.objectContaining({ pageToken: 'page-2', maxResults: maxRows - 3 }),
  }), expect.any(Function));
  expect(result).toMatchObject({ totalRows: maxRows + 1, truncated: true });

  const slack = JSON.stringify(buildTableBlocks(result.rows, result.columnNames));
  const whatsapp = renderWhatsAppQueryAnswer({ ...result, explanation: '', assumptions: [], traceId: 'precision-test' });
  for (const id of ['9007199254740993', '-9007199254740993']) {
    const nested = `{"ids":[42,"${id}"]}`;
    expect(slack).toContain(`"text":"${id}"`);
    expect(slack).toContain(`"text":${JSON.stringify(nested)}`);
    expect(whatsapp).toContain(`\n${id} | ${nested}`);
  }
});
