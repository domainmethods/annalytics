/**
 * Run-to-run noise band: the largest absolute per-index difference between two
 * baseline runs, floored. Inputs MUST be id-aligned by the caller (runA[i] and
 * runB[i] are the same corpus case); see node-sweep.ts for the alignment step.
 */
export function computeEpsilon(runA: number[], runB: number[], floor = 0.01): number {
  const n = Math.min(runA.length, runB.length);
  let maxDiff = 0;
  for (let i = 0; i < n; i++) maxDiff = Math.max(maxDiff, Math.abs(runA[i] - runB[i]));
  return Math.max(maxDiff, floor);
}
