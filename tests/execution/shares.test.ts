import { describe, it, expect } from 'vitest';
import { computeShares, toExactDecimal } from '../../src/execution/shares.js';

describe('toExactDecimal', () => {
  it.each([
    [198, 'INT64', '198'],
    ['9007199254740993', 'INT64', '9007199254740993'],
    ['1.5', 'INT64', null],
    [1e21, 'FLOAT64', null],
    [0.1, 'FLOAT64', '0.1'],
    [{ toString: () => '15.25' }, 'NUMERIC', '15.25'],
    [{ value: '42' }, 'INT64', '42'],
    [{ value: 2 ** 53 + 2 }, 'INT64', null],
    [{ value: NaN }, 'FLOAT64', null],
    [{ value: true }, 'INT64', null],
    [null, 'INT64', null],
    [NaN, 'FLOAT64', null],
    [Infinity, 'FLOAT64', null],
    [[9], 'INT64', null],
    ['abc', 'NUMERIC', null],
    [true, 'INT64', null],
    [3, 'INTEGER', '3'],
    [0.5, 'FLOAT', '0.5'],
    [1, 'STRING', null],
  ])('%j as %s -> %j', (val, type, expected) => {
    expect(toExactDecimal(val, type)).toBe(expected);
  });
});

describe('computeShares', () => {
  const ok = (values: unknown[], type = 'INT64') => {
    const r = computeShares(values, type);
    if (!r.ok) throw new Error(`expected ok, got ${r.reason}`);
    return r;
  };

  it('A1: exact total, labels and basis points', () => {
    const r = ok([198, 120, 42]);
    expect(r.total).toBe('360');
    expect(r.shares.map(s => s.label)).toEqual(['55%', '33%', '12%']);
    expect(r.shares.map(s => s.basisPoints)).toEqual([5500, 3333, 1167]);
  });
  it('A7: <1% and >99%', () => {
    expect(ok([249, 1]).shares.map(s => s.label)).toEqual(['>99%', '<1%']);
  });
  it('A8: equal thirds', () => {
    expect(ok([1, 1, 1]).shares.map(s => s.label)).toEqual(['33%', '33%', '33%']);
  });
  it('A9: sums beyond safe integers', () => {
    expect(ok(['9007199254740993', '1']).total).toBe('9007199254740994');
  });
  it('zero and 100%', () => {
    expect(ok([0, 5]).shares.map(s => s.label)).toEqual(['0%', '100%']);
  });
  it('rounds half up', () => {
    expect(ok([1, 7]).shares[0].label).toBe('13%');
  });
  it('exactly 0.5% is 1%, not <1%', () => {
    expect(ok([1, 199]).shares.map(s => s.label)).toEqual(['1%', '>99%']);
  });
  it('exactly 99.5% is >99%', () => {
    expect(ok([199, 1]).shares[0].label).toBe('>99%');
  });
  it('mixed scales', () => {
    expect(ok(['1.5', '2.25'], 'NUMERIC').total).toBe('3.75');
  });
  it('accepts legacy type names', () => {
    expect(ok([1, 3], 'INTEGER').shares.map(s => s.basisPoints)).toEqual([2500, 7500]);
    expect(ok([0.5, 0.5], 'FLOAT').total).toBe('1.0');
  });
  it('R-24 negative', () => {
    expect(computeShares([-50, 100], 'INT64')).toEqual({ ok: false, reason: 'negative_value' });
  });
  it('R-25 zero total', () => {
    expect(computeShares([0, 0], 'INT64')).toEqual({ ok: false, reason: 'zero_total' });
  });
  it('R-26 null value', () => {
    expect(computeShares([null, 1], 'INT64')).toEqual({ ok: false, reason: 'measure_value' });
  });
  it('unknown type and >38 fraction digits are measure_value', () => {
    expect(computeShares([1], 'STRING')).toEqual({ ok: false, reason: 'measure_value' });
    expect(computeShares(['0.' + '1'.repeat(39)], 'NUMERIC')).toEqual({ ok: false, reason: 'measure_value' });
  });
});
