import { describe, it, expect } from 'vitest';
import { BigQuery, BigQueryDate, BigQueryTimestamp, Geography } from '@google-cloud/bigquery';
import { unwrapBigQueryScalar } from '../../src/execution/bigqueryScalar.js';

describe('unwrapBigQueryScalar (#67)', () => {
  it('unwraps the SDK scalar wrapper classes', () => {
    expect(unwrapBigQueryScalar(new BigQueryDate('2026-06-21'))).toBe('2026-06-21');
    expect(unwrapBigQueryScalar(new BigQueryTimestamp('2026-06-21T10:00:00Z'))).toBe('2026-06-21T10:00:00.000Z');
    expect(unwrapBigQueryScalar(new Geography('POINT(1 2)'))).toBe('POINT(1 2)');
    expect(unwrapBigQueryScalar(BigQuery.int('9007199254740993'))).toBe('9007199254740993');
  });

  it('unwraps a plain object whose only field is value', () => {
    expect(unwrapBigQueryScalar({ value: '2026-06-21' })).toBe('2026-06-21');
  });

  it('leaves a STRUCT with a value field and siblings alone', () => {
    expect(unwrapBigQueryScalar({ value: 4, unit: 'hours' })).toBeUndefined();
  });

  it('leaves objects without a primitive value alone', () => {
    expect(unwrapBigQueryScalar({ a: 1 })).toBeUndefined();
    expect(unwrapBigQueryScalar({ value: { nested: 1 } })).toBeUndefined();
    expect(unwrapBigQueryScalar({ value: null })).toBeUndefined();
  });
});
