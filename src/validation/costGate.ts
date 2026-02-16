import type { ValidationResult } from '../types.js';

function formatBytes(bytes: number): string {
  const gb = bytes / (1024 * 1024 * 1024);
  return `${gb.toFixed(2)} GB`;
}

export function costGate(bytesProcessed: number, maxBytes: number): ValidationResult {
  if (bytesProcessed <= maxBytes) {
    return { valid: true, layer: 'L4-cost', bytesProcessed };
  }

  return {
    valid: false,
    layer: 'L4-cost',
    bytesProcessed,
    error: `Query would scan ${formatBytes(bytesProcessed)}, exceeding the ${formatBytes(maxBytes)} limit. Try narrowing with a date filter or fewer columns.`,
  };
}
