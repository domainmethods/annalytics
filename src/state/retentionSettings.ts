/** Cap retention at 100 years, comfortably within JavaScript Date's range. */
export function parseResponseContextRetentionDays(): number {
  const value = process.env.RESPONSE_CONTEXT_RETENTION_DAYS;
  if (value === undefined || value.trim() === '') return 90;
  const days = Number(value);
  if (!Number.isSafeInteger(days) || days <= 0 || days > 36_500) {
    throw new Error('Invalid config: RESPONSE_CONTEXT_RETENTION_DAYS must be a positive integer no greater than 36500');
  }
  return days;
}
