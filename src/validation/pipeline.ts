import type { ValidationResult } from '../types.js';
import { staticAnalysis } from './staticAnalysis.js';
import { astValidation } from './astValidation.js';
import { dryRunValidation } from './dryRun.js';
import { costGate } from './costGate.js';

export async function validateSql(sql: string, maxBytes: number): Promise<ValidationResult> {
  // L1: Static Analysis
  const l1 = staticAnalysis(sql);
  if (!l1.valid) return l1;

  // L2: AST Validation (advisory — parse failures pass through to L3)
  astValidation(sql);

  // L3: Dry Run
  const l3 = await dryRunValidation(sql);
  if (!l3.valid) return l3;

  // L4: Cost Gate
  // l3.bytesProcessed is guaranteed if l3.valid is true
  const bytes = l3.bytesProcessed ?? 0;
  const l4 = costGate(bytes, maxBytes);
  if (!l4.valid) return l4;

  // All valid
  return {
    valid: true,
    layer: 'all',
    bytesProcessed: bytes,
  };
}
