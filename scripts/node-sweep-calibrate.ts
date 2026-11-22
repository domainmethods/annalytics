/**
 * Run-to-run noise band for comparing two corpus MEANS, floored.
 *
 * Candidates are ranked on their mean score over the corpus, so the band must
 * describe how much a mean moves between runs, not how much one case moves.
 * With paired differences d_i = runA[i] - runB[i], the band is
 * `z * sqrt(sum(d_i^2)) / n`: the standard error of the mean difference
 * between two single-run means, at z = 2 (about 95%). The runs are
 * replicates, so the spread is measured around 0 rather than the sample
 * mean (which would cancel a uniform drift), and the band is floored at
 * |mean(d)| so a uniform drift is never understated.
 * On a 40-case corpus, one case that swings by s sets ε to s / 20: about
 * 0.033 for a 2/3 swing (two of three facts lost) and 0.05 for a full 0→1 flip.
 * The old max-per-case band set ε to s itself, which made every candidate
 * tie.
 *
 * Inputs MUST be id-aligned by the caller (runA[i] and runB[i] are the same
 * corpus case); see node-sweep.ts for the alignment step. Fewer than two
 * shared cases cannot estimate noise and means the calibration is broken
 * (an empty or failed baseline run), so it throws rather than return a floor
 * that would treat every candidate difference as signal.
 */
export function computeEpsilon(runA: number[], runB: number[], floor = 0.01, z = 2): number {
  const n = Math.min(runA.length, runB.length);
  if (n < 2) {
    throw new Error(`computeEpsilon needs at least 2 id-aligned cases from both baseline runs, got ${n}`);
  }
  const diffs = Array.from({ length: n }, (_, i) => runA[i] - runB[i]);
  const mean = diffs.reduce((sum, d) => sum + d, 0) / n;
  const sumSq = diffs.reduce((sum, d) => sum + d * d, 0);
  return Math.max(Math.abs(mean), (z * Math.sqrt(sumSq)) / n, floor);
}
