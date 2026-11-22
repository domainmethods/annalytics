/**
 * Run-to-run noise band for comparing two corpus MEANS, floored.
 *
 * Candidates are ranked on their mean score over the corpus, so the band must
 * describe how much a mean moves between runs, not how much one case moves.
 * With paired differences d_i = runA[i] - runB[i], the band is
 * `z * sd(d) / sqrt(n)`: the spread of the mean difference between two
 * single-run means, at z = 2 (about 95%). A single flipped case on a 40-case
 * corpus therefore moves ε by ~0.03 instead of setting it to that case's
 * whole swing, which made every candidate tie.
 *
 * Inputs MUST be id-aligned by the caller (runA[i] and runB[i] are the same
 * corpus case); see node-sweep.ts for the alignment step. Fewer than two
 * shared cases cannot estimate spread, so the floor is returned.
 */
export function computeEpsilon(runA: number[], runB: number[], floor = 0.01, z = 2): number {
  const n = Math.min(runA.length, runB.length);
  if (n < 2) return floor;
  const diffs = Array.from({ length: n }, (_, i) => runA[i] - runB[i]);
  const mean = diffs.reduce((sum, d) => sum + d, 0) / n;
  const variance = diffs.reduce((sum, d) => sum + (d - mean) ** 2, 0) / (n - 1);
  return Math.max((z * Math.sqrt(variance)) / Math.sqrt(n), floor);
}
