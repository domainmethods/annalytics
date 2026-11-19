import { describe, expect, it } from 'vitest';
import { referenceIsOrdered, resultsEquivalent } from '../../../scripts/template-validation/resultEquivalence.js';

const unordered = { ordered: false };

function singleValue(value: unknown) {
  return { columnNames: ['value'], rows: [{ value }] };
}

describe('resultsEquivalent', () => {
  it('ignores column order and aliases', () => {
    expect(resultsEquivalent(
      { columnNames: ['a', 'b'], rows: [{ a: 12, b: 'paid' }] },
      { columnNames: ['status', 'count'], rows: [{ status: 'paid', count: 12 }] },
      unordered,
    )).toBe(true);
  });

  it('uses numeric tolerance 1e-6 relative by default', () => {
    expect(resultsEquivalent(singleValue(1000000), singleValue(1000000.5), unordered)).toBe(true);
    expect(resultsEquivalent(singleValue(1), singleValue(1.01), unordered)).toBe(false);
    expect(resultsEquivalent(singleValue(1000000), singleValue(1000000.5), {
      ...unordered, relTol: 1e-8,
    })).toBe(false);
  });

  it('compares NULL safely', () => {
    expect(resultsEquivalent(singleValue(null), singleValue(null), unordered)).toBe(true);
    expect(resultsEquivalent(singleValue(null), singleValue(undefined), unordered)).toBe(true);
    expect(resultsEquivalent(singleValue(null), singleValue(0), unordered)).toBe(false);
  });

  it('ignores row order unless ordered', () => {
    const ref = { columnNames: ['x'], rows: [{ x: 1 }, { x: 2 }, { x: 1 }] };
    const cand = { ...ref, rows: [{ x: 2 }, { x: 1 }, { x: 1 }] };
    expect(resultsEquivalent(ref, cand, unordered)).toBe(true);
    expect(resultsEquivalent(ref, cand, { ordered: true })).toBe(false);
    expect(resultsEquivalent(ref, ref, { ordered: true })).toBe(true);
    expect(resultsEquivalent(ref, { ...cand, rows: [{ x: 2 }, { x: 2 }, { x: 1 }] }, unordered)).toBe(false);
  });

  it('finds a one-to-one match for unordered rows with overlapping tolerance', () => {
    const ref = { columnNames: ['x'], rows: [{ x: 1000000 }, { x: 1000001.5 }] };
    const cand = { columnNames: ['x'], rows: [{ x: 1000000.8 }, { x: 999999.5 }] };
    const reversed = { ...cand, rows: [...cand.rows].reverse() };

    expect(resultsEquivalent(ref, reversed, unordered)).toBe(true);
    expect(resultsEquivalent(ref, cand, unordered)).toBe(true);
  });

  it('requires the same column count even when both results are empty', () => {
    const empty = { columnNames: ['x'], rows: [] };
    expect(resultsEquivalent(empty, { columnNames: ['y'], rows: [] }, unordered)).toBe(true);
    expect(resultsEquivalent(empty, { columnNames: ['x', 'y'], rows: [] }, unordered)).toBe(false);
    expect(resultsEquivalent(singleValue(1), {
      columnNames: ['x', 'y'], rows: [{ x: 1, y: null }],
    }, unordered)).toBe(false);
  });

  it('rejects different row counts', () => {
    const ref = singleValue(1);
    expect(resultsEquivalent(ref, { ...ref, rows: [...ref.rows, ...ref.rows] }, unordered)).toBe(false);
  });

  it.each([
    [12n, 12, true],
    [{ value: '12' }, 12, true],
    [{ toString: () => '1.2e+1' }, 12, true],
    [{ value: '2026-11-18' }, '2026-11-18', true],
    [{ value: '' }, 0, false],
    ['12', 12, false],
    [true, 1, false],
    [false, 'false', false],
    [[{ b: 2, a: 1 }], [{ a: 1, b: 2 }], true],
    [[1, 2], [2, 1], false],
  ])('normalizes %o against %o to %s', (ref, cand, equivalent) => {
    expect(resultsEquivalent(singleValue(ref), singleValue(cand), unordered)).toBe(equivalent);
  });

  it('matches tolerant numeric values once each within a row', () => {
    const ref = { columnNames: ['a', 'b'], rows: [{ a: 1000000, b: 1000000 }] };
    expect(resultsEquivalent(ref, {
      ...ref, rows: [{ a: 1000001.8, b: 1000000.5 }],
    }, unordered)).toBe(false);
    expect(resultsEquivalent(ref, {
      ...ref, rows: [{ a: 1000000.5, b: 999999.5 }],
    }, unordered)).toBe(true);
  });
});

describe('referenceIsOrdered', () => {
  it.each([
    ['SELECT x FROM t ORDER BY x DESC LIMIT 10', true],
    ['SELECT x FROM t order /* comment */ by x limit 10;  ', true],
    ['SELECT x FROM t ORDER BY x', false],
    ['SELECT x FROM (SELECT x FROM t ORDER BY x LIMIT 5) LIMIT 10', false],
    ['SELECT ROW_NUMBER() OVER (ORDER BY x) FROM t LIMIT 10', false],
    ['SELECT x FROM t ORDER BY (SELECT y FROM u LIMIT 1)', false],
    ["SELECT 'ORDER BY x LIMIT 10'", false],
    [`SELECT r"""' ORDER BY x LIMIT 10"""`, false],
    ['SELECT x FROM t -- ORDER BY x\n LIMIT 10', false],
    ['SELECT x FROM t # ORDER BY x\n LIMIT 10', false],
    ['SELECT x FROM t /* ORDER BY x LIMIT 10 */', false],
    ['SELECT x FROM t ORDER BY t.limit', false],
    ['SELECT x FROM `ORDER BY x LIMIT 10`', false],
  ])('classifies %s as %s', (sql, ordered) => {
    expect(referenceIsOrdered(sql)).toBe(ordered);
  });
});
