import type { DryRunValidationResult } from './dryRun.js';
import { costGate } from './costGate.js';
import { runCoreValidation } from './core.js';

export async function validateSql(sql: string, maxBytes: number): Promise<DryRunValidationResult> {
  // L1 static → L2 AST (advisory) → L3 dry run
  const core = await runCoreValidation(sql, 0);
  if (core.blocked) return core.blocked;

  // L4: Cost gate
  const bytes = core.bytesProcessed ?? 0;
  const l4 = costGate(bytes, maxBytes);
  if (!l4.valid) return l4;

  // All valid
  return {
    valid: true, layer: 'all', bytesProcessed: bytes,
    ...(core.referencedTables && { referencedTables: core.referencedTables }),
    ...(core.referencedLogicalViews && { referencedLogicalViews: core.referencedLogicalViews }),
    ...(core.referencedRoutines && { referencedRoutines: core.referencedRoutines }),
  };
}
