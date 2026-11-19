/**
 * BigQuery's Node SDK decodes DATE, DATETIME, TIME, TIMESTAMP, GEOGRAPHY and
 * (with integer wrapping) INT64 cells into small class instances that hold
 * their text in a `value` field. A decoded STRUCT/RECORD is a plain object, and
 * it may legitimately have a field named `value` next to others
 * (`{ value: 4, unit: 'hours' }`), so "has a `value`" alone must not count as
 * a wrapper.
 *
 * Returns the primitive inside a wrapper, or `undefined` when `val` is not one:
 * - a class instance (non-plain prototype) with a primitive `value` — the SDK
 *   wrapper classes;
 * - a plain object whose only own key is `value` — a wrapper that lost its class
 *   (e.g. a JSON round trip). A one-field STRUCT named `value` also reads this
 *   way, which only drops the field name.
 */
export function unwrapBigQueryScalar(val: object): string | number | boolean | bigint | undefined {
  const wrapped = (val as { value?: unknown }).value;
  if (wrapped === null || wrapped === undefined || typeof wrapped === 'object' || typeof wrapped === 'function') {
    return undefined;
  }
  const prototype = Object.getPrototypeOf(val);
  if (prototype !== Object.prototype && prototype !== null) {
    return wrapped as string | number | boolean | bigint;
  }
  const keys = Object.keys(val);
  return keys.length === 1 && keys[0] === 'value'
    ? wrapped as string | number | boolean | bigint
    : undefined;
}
