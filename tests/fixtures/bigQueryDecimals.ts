import { BigQuery } from '@google-cloud/bigquery';

export const NUMERIC_TEXT = '0.000000001';
export const BIGNUMERIC_TEXT = '-12345678901234567890123456789012345678.12345678901234567890123456789012345678';

export function bigQueryDecimalRow(): Record<string, unknown> {
  // Decode an API-shaped result locally so both cells use the SDK's real decimal class.
  const [row] = BigQuery.mergeSchemaWithRows_({
    fields: [
      { name: 'small', type: 'NUMERIC' },
      { name: 'wide', type: 'BIGNUMERIC' },
    ],
  }, [{ f: [{ v: NUMERIC_TEXT }, { v: BIGNUMERIC_TEXT }] }], { wrapIntegers: false });
  return row;
}
