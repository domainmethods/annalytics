import { expect, it } from 'vitest';
import { matchesRelation } from '../../src/dbt/relationMatching.js';
it('accepts unique suffixes and exact names, rejecting ambiguous projects', () => {
  expect(matchesRelation('ds.tbl', ['proj.ds.tbl'])).toBe(true);
  expect(matchesRelation('ds.tbl', ['proj.ds.tbl', 'other.ds.tbl'])).toBe(false);
  expect(matchesRelation('proj.ds.tbl', ['proj.ds.tbl', 'other.ds.tbl'])).toBe(true);
});

import { resolveDomain } from '../../src/feedback/domainAttribution.js';
it('attributes legacy and qualified cards without crossing ambiguous projects', () => {
  const cards = [{ table: 'ds.tbl', domain: 'sales' }];
  expect(resolveDomain(['proj.ds.tbl'], cards)).toBe('sales');
  expect(resolveDomain(['proj.ds.tbl', 'other.ds.tbl'], cards)).toBe('ds');
  expect(resolveDomain(['proj.ds.tbl'], [{ table: 'proj.ds.tbl', domain: 'sales' }])).toBe('sales');
});

import { tableSelectionPassed } from '../../scripts/benchmarkSupport.js';
it('rejects a legacy card and expectation when another advertised project collides', () => {
  const inventory = ['p.ds.tbl', 'q.ds.tbl'];
  expect(resolveDomain(['q.ds.tbl'], [{ table: 'ds.tbl', domain: 'sales' }], inventory)).toBe('ds');
  expect(tableSelectionPassed(['ds.tbl'], ['q.ds.tbl'], inventory)).toBe(false);
});
