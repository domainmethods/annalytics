import { readFileSync, writeFileSync } from 'node:fs';
import { join, parse } from 'node:path';
import type { JudgeResult, BenchmarkRun } from './benchmark-types.js';
import {
  evaluateReferenceCardAcceptance,
  formatReferenceCardAcceptanceReport,
} from './benchmarkAcceptance.js';

export interface Regression {
  corpusId: string;
  criterion: string;
  previousScore: number;
  currentScore: number;
  delta: number;
}

export function detectRegressions(
  previous: JudgeResult[],
  current: JudgeResult[],
  threshold = 2,
): Regression[] {
  const prevMap = new Map(previous.map(r => [r.corpusId, r]));
  const regressions: Regression[] = [];

  for (const cur of current) {
    const prev = prevMap.get(cur.corpusId);
    if (!prev) continue;

    for (const criterion of Object.keys(cur.scores) as Array<keyof typeof cur.scores>) {
      const delta = prev.scores[criterion] - cur.scores[criterion];
      if (delta >= threshold) {
        regressions.push({
          corpusId: cur.corpusId,
          criterion,
          previousScore: prev.scores[criterion],
          currentScore: cur.scores[criterion],
          delta,
        });
      }
    }
  }

  return regressions;
}

function percentile(sorted: number[], p: number): number {
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function mean(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export function generateSummary(
  current: BenchmarkRun,
  previous?: BenchmarkRun,
): string {
  const judges = current.judgeResults ?? [];
  const lines: string[] = [];

  lines.push(`# Benchmark Summary - ${current.runDate}`);
  lines.push('');

  if (judges.length === 0) {
    lines.push('No judge results available yet.');
    lines.push('');
  } else {
    const overallScores = judges.map(j => j.overallScore).sort((a, b) => a - b);
    const avg = mean(overallScores);
    const med = percentile(overallScores, 50);
    const p25 = percentile(overallScores, 25);
    const p75 = percentile(overallScores, 75);

    const failureCount = current.results.filter(
      r => r.qualityVerdict === 'exhausted' || r.qualityVerdict === 'cost_exceeded',
    ).length;

    const flagged = judges.filter(j => j.flaggedForReview);

    const regressions = previous?.judgeResults
      ? detectRegressions(previous.judgeResults, judges)
      : [];

    lines.push('## Score Distribution');
    lines.push('');
    lines.push('| Metric | Value |');
    lines.push('|--------|-------|');
    lines.push(`| Mean   | ${avg.toFixed(2)} |`);
    lines.push(`| Median | ${med.toFixed(2)} |`);
    lines.push(`| P25    | ${p25.toFixed(2)} |`);
    lines.push(`| P75    | ${p75.toFixed(2)} |`);
    lines.push(`| N      | ${judges.length} |`);
    lines.push('');
    lines.push('## Pipeline Failures');
    lines.push('');
    lines.push(`**${failureCount}** queries ended in \`exhausted\` or \`cost_exceeded\`.`);
    lines.push('');

    if (regressions.length > 0) {
      lines.push('## Regressions');
      lines.push('');
      lines.push('| Corpus ID | Criterion | Previous | Current | Delta |');
      lines.push('|-----------|-----------|----------|---------|-------|');
      for (const r of regressions) {
        lines.push(
          `| ${r.corpusId} | ${r.criterion} | ${r.previousScore} | ${r.currentScore} | -${r.delta} |`,
        );
      }
      lines.push('');
    } else if (previous) {
      lines.push('## Regressions');
      lines.push('');
      lines.push('No regressions detected.');
      lines.push('');
    }

    if (flagged.length > 0) {
      lines.push('## Flagged for Review');
      lines.push('');
      for (const j of flagged) {
        lines.push(`- **${j.corpusId}** (overall: ${j.overallScore}) - ${j.rationale}`);
      }
      lines.push('');
    }
  }

  const acceptance = evaluateReferenceCardAcceptance(current, previous);
  lines.push('## ReferenceCard Acceptance');
  lines.push('');
  lines.push(`**Decision:** \`${acceptance.decision}\``);
  lines.push('');
  lines.push(`Cases evaluated: ${acceptance.cases.length}`);
  lines.push('');
  if (acceptance.failures.length > 0) {
    lines.push('| Corpus ID | Class | Detail |');
    lines.push('|-----------|-------|--------|');
    for (const failure of acceptance.failures) {
      lines.push(
        `| ${escapeMarkdownCell(failure.corpusId)} | ${failure.failureClass} | ${escapeMarkdownCell(failure.detail)} |`,
      );
    }
    lines.push('');
  }

  return lines.join('\n');
}

export interface BenchmarkAnalysisOutputs {
  summaryPath: string;
  acceptancePath: string;
}

export function writeBenchmarkAnalysisOutputs(
  currentPath: string,
  previousPath?: string,
): BenchmarkAnalysisOutputs {
  const current: BenchmarkRun = JSON.parse(readFileSync(currentPath, 'utf-8'));
  const previous: BenchmarkRun | undefined = previousPath
    ? JSON.parse(readFileSync(previousPath, 'utf-8'))
    : undefined;

  const summary = generateSummary(current, previous);
  const acceptance = evaluateReferenceCardAcceptance(current, previous);
  const acceptanceReport = formatReferenceCardAcceptanceReport(acceptance);
  const { summaryPath, acceptancePath } = analysisOutputPathsFor(currentPath);

  writeFileSync(summaryPath, summary, 'utf-8');
  writeFileSync(acceptancePath, acceptanceReport, 'utf-8');

  return { summaryPath, acceptancePath };
}

function analysisOutputPathsFor(currentPath: string): BenchmarkAnalysisOutputs {
  const parsed = parse(currentPath);
  if (parsed.ext !== '.json') {
    throw new Error('Benchmark analysis input must end with .json');
  }

  return {
    summaryPath: join(parsed.dir, `${parsed.name}-summary.md`),
    acceptancePath: join(parsed.dir, `${parsed.name}-referencecard-acceptance.md`),
  };
}

function escapeMarkdownCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

// CLI entry point — only runs when executed directly
const isMain =
  process.argv[1]?.endsWith('benchmark-analyze.ts') ||
  process.argv[1]?.endsWith('benchmark-analyze.js');

if (isMain) {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error('Usage: npx tsx scripts/benchmark-analyze.ts <current.json> [previous.json]');
    process.exit(1);
  }

  const currentPath = args[0];
  const previousPath = args[1];

  const outputs = writeBenchmarkAnalysisOutputs(currentPath, previousPath);
  console.log(`Summary written to ${outputs.summaryPath}`);
  console.log(`ReferenceCard acceptance written to ${outputs.acceptancePath}`);
}
