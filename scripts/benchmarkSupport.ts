import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import type { GroundingCitation } from '../src/agents/types.js';
import type { FailureRecord, QualityResult, ValidationLayerRecord } from '../src/qualityLoop.js';
import {
  extractReferenceIdsFromCitations as extractCitationReferenceIds,
  extractTeachingIdsFromCitations as extractCitationTeachingIds,
} from '../src/agents/grounding.js';

export interface BenchmarkMetadataInput {
  packageJson: string;
  corpusRaw: string;
  manifestRaw?: string | null;
  catalogRaw?: string | null;
  gitSha?: string | null;
  gitDirty?: boolean;
  geminiModel?: string | null;
  judgeModel?: string | null;
  fileSearchStoreId?: string | null;
  gcpProjectId?: string | null;
  runStartedAt?: string;
}

function sha256(value: string | null | undefined): string | null {
  if (value == null) return null;
  return createHash('sha256').update(value).digest('hex');
}

function safeGit(args: string[], cwd: string): string | null {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
  } catch {
    return null;
  }
}

export function getGitSha(cwd = process.cwd()): string | null {
  return safeGit(['rev-parse', 'HEAD'], cwd);
}

export function getGitDirty(cwd = process.cwd()): boolean {
  const status = safeGit(['status', '--porcelain'], cwd);
  return status != null && status.length > 0;
}

export function buildBenchmarkMetadata(input: BenchmarkMetadataInput) {
  let packageVersion = 'unknown';
  try {
    const parsed = JSON.parse(input.packageJson) as { version?: string };
    packageVersion = parsed.version || packageVersion;
  } catch {
    packageVersion = 'unknown';
  }

  const runStartedAt = input.runStartedAt ?? new Date().toISOString();

  return {
    runId: `benchmark_${runStartedAt.replace(/[:.]/g, '-')}`,
    runStartedAt,
    gitSha: input.gitSha ?? null,
    gitDirty: input.gitDirty ?? false,
    packageVersion,
    corpusHash: sha256(input.corpusRaw)!,
    dbtManifestHash: sha256(input.manifestRaw),
    dbtCatalogHash: sha256(input.catalogRaw),
    geminiModel: input.geminiModel ?? null,
    judgeModel: input.judgeModel ?? null,
    fileSearchStoreId: input.fileSearchStoreId ?? null,
    gcpProjectId: input.gcpProjectId ?? null,
  };
}

export function validationResultsFromFailures(
  failureHistory: FailureRecord[],
  verdict: QualityResult['verdict'],
  validationHistory: ValidationLayerRecord[] = [],
): { l1: boolean; l2: boolean; l3: boolean; l4: boolean } {
  if (validationHistory.length > 0) {
    const finalAttempt = Math.max(...validationHistory.map(result => result.attempt));
    const finalHistory = validationHistory.filter(result => result.attempt === finalAttempt);
    const hasLayer = (layer: ValidationLayerRecord['layer']) =>
      finalHistory.some(result => result.layer === layer);
    const layerPassed = (layer: ValidationLayerRecord['layer']) =>
      finalHistory.some(result => result.layer === layer && result.valid);

    return {
      l1: layerPassed('l1'),
      l2: hasLayer('l2') ? layerPassed('l2') : true,
      l3: layerPassed('l3'),
      l4: hasLayer('l4') ? layerPassed('l4') : verdict !== 'cost_exceeded',
    };
  }

  if (verdict === 'pass' || verdict === 'fail_then_pass') {
    return { l1: true, l2: true, l3: true, l4: true };
  }

  if (verdict === 'cost_exceeded') {
    return { l1: true, l2: true, l3: true, l4: false };
  }

  const lastFailure = failureHistory[failureHistory.length - 1];
  return {
    l1: !lastFailure || lastFailure.failureType !== 'structural',
    l2: true,
    l3: !lastFailure || (lastFailure.failureType !== 'structural' && lastFailure.failureType !== 'dry_run'),
    l4: true,
  };
}

// Compact, deterministic per-attempt failure trace for the acceptance report.
// Only failing layers appear; L2 is marked advisory (visible, never blocking).
export function formatValidationTrace(history: ValidationLayerRecord[] = []): string {
  return history
    .filter(r => !r.valid)
    .map(r => {
      const advisory = r.layer === 'l2' ? ' advisory' : '';
      const detail = r.detail ? ` (${r.detail})` : '';
      return `a${r.attempt} ${r.layer.toUpperCase()}✗${advisory}${detail}`;
    })
    .join('; ');
}

export function extractReferenceIdsFromCitations(
  citations: Pick<GroundingCitation, 'sourceFile' | 'chunkText' | 'relevanceScore'>[],
): string[] {
  return extractCitationReferenceIds(citations);
}

export function combineReferenceIds(...groups: Array<string[] | undefined>): string[] {
  return [...new Set(groups.flatMap(group => group ?? []))].sort();
}

export function referenceRetrievalSource(
  referenceProbeIds: string[],
  sqlGroundingIds: string[],
): 'explicit_probe' | 'sql_grounding' | 'none' {
  if (referenceProbeIds.length > 0) return 'explicit_probe';
  if (sqlGroundingIds.length > 0) return 'sql_grounding';
  return 'none';
}

export function referenceRetrievalPassed(
  expectedReferenceIds: string[] | undefined,
  observedReferenceIds: string[],
): boolean | null {
  if (!expectedReferenceIds || expectedReferenceIds.length === 0) return null;
  const observed = new Set(observedReferenceIds);
  return expectedReferenceIds.every(id => observed.has(id));
}

export function extractTeachingIdsFromCitations(
  citations: Pick<GroundingCitation, 'sourceFile' | 'chunkText' | 'relevanceScore'>[],
): string[] {
  return extractCitationTeachingIds(citations);
}

// Same shape as referenceRetrievalPassed: null when nothing expected, else
// "every expected id observed". Keeps the two retrieval signals symmetric.
export function teachingRetrievalPassed(
  expectedTeachingIds: string[] | undefined,
  observedTeachingIds: string[],
): boolean | null {
  if (!expectedTeachingIds || expectedTeachingIds.length === 0) return null;
  const observed = new Set(observedTeachingIds);
  return expectedTeachingIds.every(id => observed.has(id));
}

export function teachingComplianceLabel(passed: boolean | null): string {
  if (passed === null) return 'no_relevant_teaching';
  return passed ? 'followed' : 'missed';
}

export function extractTablesFromSql(sql: string | null | undefined, knownTables: string[]): string[] {
  if (!sql) return [];
  const normalizedSql = sql.toLowerCase().replace(/`/g, '');
  const observed = new Set<string>();

  for (const table of knownTables) {
    const normalizedTable = table.toLowerCase().replace(/`/g, '').trim();
    if (normalizedTable.length === 0) continue;
    const tablePattern = escapeRegExp(normalizedTable);
    const regex = new RegExp(`(^|[^a-z0-9_])${tablePattern}([^a-z0-9_]|$)`, 'i');
    if (regex.test(normalizedSql)) observed.add(table);
  }

  return [...observed];
}

export function tableSelectionPassed(
  expectedTables: string[] | undefined,
  observedTables: string[],
): boolean | null {
  if (!expectedTables || expectedTables.length === 0) return null;
  const observed = new Set(observedTables.map(table => table.toLowerCase()));
  return expectedTables.every(table => observed.has(table.toLowerCase()));
}

export function sqlShapePassed(
  expectedSqlContains: string[] | undefined,
  generatedSql: string | null,
): boolean | null {
  if (!expectedSqlContains || expectedSqlContains.length === 0) return null;
  if (!generatedSql) return false;
  const normalizedSql = normalizeSqlFragment(generatedSql);
  const identifierTolerantSql = stripIdentifierQualifiers(normalizedSql);
  return expectedSqlContains.every(fragment =>
    normalizedSql.includes(normalizeSqlFragment(fragment))
    || (
      !fragment.includes('.')
      && identifierTolerantSql.includes(stripIdentifierQualifiers(normalizeSqlFragment(fragment)))
    ),
  );
}

export function clarificationPassed(
  expectedConfidence: 'high' | 'medium' | 'low' | undefined,
  observedConfidence: 'high' | 'medium' | 'low' | undefined,
): boolean | null {
  if (!expectedConfidence) return null;
  return observedConfidence === expectedConfidence;
}

function normalizeSqlFragment(value: string): string {
  return value.toLowerCase().replace(/`/g, '').replace(/\s+/g, ' ').trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripIdentifierQualifiers(value: string): string {
  let previous = value;
  let next = previous.replace(/\b[a-z_][a-z0-9_]*\s*\.\s*([a-z_][a-z0-9_]*)\b/g, '$1');
  while (next !== previous) {
    previous = next;
    next = previous.replace(/\b[a-z_][a-z0-9_]*\s*\.\s*([a-z_][a-z0-9_]*)\b/g, '$1');
  }
  return next;
}
