import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import type { NodeId } from '../../src/agents/nodeProfiles.js';
import { executeQuery, initBigQueryClient } from '../../src/execution/runner.js';
import { initBigQuery, type QueryRelationMetadata, type ReferencedTable } from '../../src/validation/dryRun.js';
import { validateSql } from '../../src/validation/pipeline.js';
import { warehouseRelations } from '../benchmarkSupport.js';
import { hasSqlFrom, ITEM_SCHEMAS, scanTemplateSafety } from './items.js';
import { checkAvailable, loadLabelers, runLabeler, type LabelerConfig, type SpawnFn } from './labelers.js';
import { runLabelQuorum } from './labelQuorum.js';
import { validateQuorum } from './quorum.js';
import { TV_DATASET, TV_ROOT, TV_SOURCE_DATASET, TV_SOURCE_PROJECT, TV_TABLES } from './warehouse.js';

export const TEMPLATE_MAX_BYTES = 1024 ** 3;
const limits = { maxRows: 10_000, timeoutMs: 60_000, maxBytes: TEMPLATE_MAX_BYTES };

export async function availableLabelers(labelers: LabelerConfig[], spawn: SpawnFn, report: (line: string) => void) {
  const checks = await Promise.all(labelers.map(async cfg => ({ cfg, ...await checkAvailable(cfg, spawn) })));
  return checks.flatMap(({ cfg, ok, version }) => {
    report(`${cfg.id}: ${ok ? `usable (${version || 'version unknown'})` : cfg.enabled === false ? 'disabled' : 'unavailable'}`);
    return ok ? [{ ...cfg, cliVersion: version || 'unknown' }] : [];
  });
}

const templateViews = new Set(TV_TABLES.map(table => `${TV_DATASET}.${table}`));

export function checkTemplateRelations(
  sql: string, projectId: string, { referencedTables = [], referencedLogicalViews = [] }: QueryRelationMetadata,
): Error | undefined {
  let relations: string[];
  try {
    relations = warehouseRelations(sql);
  } catch {
    return new Error('Could not resolve SQL relations for template validation');
  }
  if (relations.some(relation => !templateViews.has(relation))) {
    return new Error(`SQL must name only approved ${TV_DATASET} views`);
  }
  if (!referencedTables.length && !referencedLogicalViews.length && hasSqlFrom(sql)) {
    return new Error('Dry run did not report referenced tables or views for SQL with FROM');
  }

  const named = new Set(relations);
  const matchesNamedView = (table: ReferencedTable) => named.has(`${TV_DATASET}.${table.tableId}`);
  const isTemplateView = (table: ReferencedTable) =>
    table.projectId === projectId && table.datasetId === TV_DATASET && matchesNamedView(table);
  // Dry runs can report the base table behind a logical view.
  const isViewSource = (table: ReferencedTable) =>
    table.projectId === TV_SOURCE_PROJECT && table.datasetId === TV_SOURCE_DATASET && matchesNamedView(table);
  if (referencedLogicalViews.some(view => !isTemplateView(view)) ||
      referencedTables.some(table => !isTemplateView(table) && !isViewSource(table))) {
    return new Error('Dry run reported a relation outside the template warehouse');
  }
}

export async function executeTemplateSql(sql: string, projectId: string) {
  try {
    if (/\bEXTERNAL_QUERY\b/i.test(sql)) return new Error('Federated SQL is not allowed for template validation');
    if (scanTemplateSafety(sql).length || /\bbigquery-public-data\b/i.test(sql)) {
      return new Error(`SQL must use the ${TV_DATASET} views`);
    }
    const validation = await validateSql(sql, limits.maxBytes);
    if (!validation.valid) return new Error(`SQL failed validation at ${validation.layer}`);
    const relationError = checkTemplateRelations(sql, projectId, validation);
    if (relationError) return relationError;
    const result = await executeQuery(sql, limits);
    return result.truncated ? new Error('SQL exceeded the result row limit') : result;
  } catch {
    return new Error('Template SQL execution failed');
  }
}

async function main(): Promise<void> {
  // Keep values loaded for BigQuery from being inherited by the agent CLIs.
  const env = { ...process.env };
  const spawn: SpawnFn = (cmd, args, { cwd, timeoutMs }) => new Promise(resolve => {
    execFile(cmd, args, { cwd, env, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) =>
      resolve({ stdout, code: error ? 1 : 0 }));
  });
  if (existsSync('.env') && typeof process.loadEnvFile === 'function') {
    process.loadEnvFile('.env');
  }
  const { values } = parseArgs({
    options: {
      node: { type: 'string', multiple: true },
      'allow-single-family': { type: 'boolean', default: false },
      drafter: { type: 'string', default: 'claude' },
    },
  });
  const nodes = (values.node ?? Object.keys(ITEM_SCHEMAS)).map(node => {
    if (!Object.hasOwn(ITEM_SCHEMAS, node)) throw new Error(`Unknown validation node ${node}`);
    return node as NodeId;
  });
  const labelers = await availableLabelers(loadLabelers(), spawn, console.log);
  validateQuorum(labelers, values['allow-single-family']);

  const projectId = process.env.GCP_PROJECT_ID ?? '';
  if (nodes.includes('sqlGenerator') || nodes.includes('supervisor')) {
    if (!projectId) throw new Error('GCP_PROJECT_ID is required for SQL labeling');
    initBigQuery(projectId);
    initBigQueryClient(projectId);
  }

  const result = await runLabelQuorum({
    nodes, drafter: values.drafter, allowSingleFamily: values['allow-single-family'], targetCounts: {},
  }, { labelers, runLabeler, execute: sql => executeTemplateSql(sql, projectId), root: TV_ROOT, now: () => new Date(), spawn });
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    const projectId = process.env.GCP_PROJECT_ID;
    console.error(projectId ? message.replaceAll(projectId, '<project>') : message);
    process.exitCode = 1;
  });
}
