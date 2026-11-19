import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import type { NodeId } from '../../src/agents/nodeProfiles.js';
import { executeQuery, initBigQueryClient } from '../../src/execution/runner.js';
import { initBigQuery } from '../../src/validation/dryRun.js';
import { validateSql } from '../../src/validation/pipeline.js';
import { ITEM_SCHEMAS, scanTemplateSafety } from './items.js';
import { checkAvailable, loadLabelers, runLabeler, type LabelerConfig, type SpawnFn } from './labelers.js';
import { runLabelQuorum } from './labelQuorum.js';
import { validateQuorum } from './quorum.js';
import { TV_DATASET, TV_ROOT } from './warehouse.js';

const limits = { maxRows: 10_000, timeoutMs: 60_000, maxBytes: 1024 ** 3 };

export async function availableLabelers(labelers: LabelerConfig[], spawn: SpawnFn, report: (line: string) => void) {
  const checks = await Promise.all(labelers.map(async cfg => ({ cfg, ...await checkAvailable(cfg, spawn) })));
  return checks.flatMap(({ cfg, ok, version }) => {
    report(`${cfg.id}: ${ok ? `usable (${version || 'version unknown'})` : cfg.enabled === false ? 'disabled' : 'unavailable'}`);
    return ok ? [{ ...cfg, cliVersion: version || 'unknown' }] : [];
  });
}

async function execute(sql: string) {
  try {
    if (scanTemplateSafety(sql).length || /\bbigquery-public-data\b/i.test(sql)) {
      return new Error(`SQL must use the ${TV_DATASET} views`);
    }
    const validation = await validateSql(sql, limits.maxBytes);
    if (!validation.valid) return new Error(`SQL failed validation at ${validation.layer}`);
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

  if (nodes.includes('sqlGenerator') || nodes.includes('supervisor')) {
    const projectId = process.env.GCP_PROJECT_ID;
    if (!projectId) throw new Error('GCP_PROJECT_ID is required for SQL labeling');
    initBigQuery(projectId);
    initBigQueryClient(projectId);
  }

  const result = await runLabelQuorum({
    nodes, drafter: values.drafter, allowSingleFamily: values['allow-single-family'], targetCounts: {},
  }, { labelers, runLabeler, execute, root: TV_ROOT, now: () => new Date(), spawn });
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
