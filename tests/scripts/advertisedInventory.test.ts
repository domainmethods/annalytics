import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { tableSelectionPassed } from '../../scripts/benchmarkSupport.js';
import { sameTableRef } from '../../scripts/node-sweep-smoke.js';

for (const script of ['benchmark', 'node-sweep', 'node-sweep-smoke']) {
  it(`${script} constructs its inventory exclusively from advertised tables`, () => {
    const source = readFileSync(`scripts/${script}.ts`, 'utf8');
    const declaration = source.match(/const knownBenchmarkTables = ([\s\S]*?);/)![1];
    const construct = new Function('tables', 'corpus', `return ${declaration}`);
    const corpus = [{ expectedTables: ['ds.tbl'] }];
    const inventory = construct([{ name: 'p.ds.tbl' }], corpus);
    expect(inventory).toEqual(['p.ds.tbl']);
    expect(tableSelectionPassed(corpus[0].expectedTables, ['p.ds.tbl'], inventory)).toBe(true);
    expect(sameTableRef('p.ds.tbl', 'ds.tbl', inventory)).toBe(true);
    const ambiguous = construct([{ name: 'p.ds.tbl' }, { name: 'q.ds.tbl' }], corpus);
    expect(tableSelectionPassed(['ds.tbl'], ['p.ds.tbl'], ambiguous)).toBe(false);
    expect(construct([], corpus)).toEqual([]);
  });
}
