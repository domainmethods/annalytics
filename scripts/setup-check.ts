import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { validateKnowledgeForSync } from './knowledgeSupport.js';

export type SetupCheckStatus = 'ok' | 'warn' | 'error';

export interface SetupCheckFinding {
  status: SetupCheckStatus;
  message: string;
}

export interface SetupCheckResult {
  findings: SetupCheckFinding[];
  errors: SetupCheckFinding[];
  warnings: SetupCheckFinding[];
  ok: boolean;
}

export interface RunSetupCheckOptions {
  rootDir?: string;
  env?: Record<string, string | undefined>;
}

const requiredFiles = [
  'README.md',
  '.env.example',
  'docs/trajectory-governance.md',
  '.github/workflows/deploy.yml',
  '.github/workflows/sync-teachings.yml',
  'infra/main.tf',
  'infra/firestore.indexes.json',
  'references/README.md',
];

const envVars = [
  'GCP_PROJECT_ID',
  'GEMINI_API_KEY',
  'FILE_SEARCH_STORE_ID',
  'SLACK_BOT_TOKEN',
  'SLACK_SIGNING_SECRET',
];

export async function runSetupCheck(options: RunSetupCheckOptions = {}): Promise<SetupCheckResult> {
  const rootDir = options.rootDir ?? process.cwd();
  const env = options.env ?? process.env;
  const findings: SetupCheckFinding[] = [];
  const add = (status: SetupCheckStatus, message: string): void => {
    findings.push({ status, message });
  };

  await checkRequiredFiles(rootDir, add);
  checkEnvironment(env, add);
  await checkDbtArtifacts(rootDir, add);
  await checkKnowledgeValidation(rootDir, add);
  await checkModelDocs(rootDir, add);
  await checkReadme(rootDir, add);
  await checkDeployWorkflow(rootDir, add);
  await checkSyncWorkflow(rootDir, add);
  await checkTerraformBoundary(rootDir, add);

  const errors = findings.filter(finding => finding.status === 'error');
  const warnings = findings.filter(finding => finding.status === 'warn');
  return {
    findings,
    errors,
    warnings,
    ok: errors.length === 0,
  };
}

export function formatSetupCheckResult(result: SetupCheckResult): string {
  const lines = ['Anna Lytics setup check'];
  for (const finding of result.findings) {
    lines.push(`${finding.status.toUpperCase()} ${finding.message}`);
  }
  lines.push(`Result: ${result.errors.length} errors, ${result.warnings.length} warnings`);
  return lines.join('\n');
}

async function checkRequiredFiles(
  rootDir: string,
  add: (status: SetupCheckStatus, message: string) => void,
): Promise<void> {
  for (const file of requiredFiles) {
    if (await fileExists(rootDir, file)) {
      add('ok', `Required file present: ${file}`);
    } else {
      add('error', `Required file missing: ${file}`);
    }
  }
}

function checkEnvironment(
  env: Record<string, string | undefined>,
  add: (status: SetupCheckStatus, message: string) => void,
): void {
  for (const name of envVars) {
    add(env[name] ? 'ok' : 'warn', `Environment ${name}=${env[name] ? 'present' : 'missing'}`);
  }
}

async function checkDbtArtifacts(
  rootDir: string,
  add: (status: SetupCheckStatus, message: string) => void,
): Promise<void> {
  const manifest = await fileExists(rootDir, 'dbt/manifest.json');
  const catalog = await fileExists(rootDir, 'dbt/catalog.json');

  if (manifest && catalog) {
    add('ok', 'dbt artifacts present: dbt/manifest.json and dbt/catalog.json');
    return;
  }

  if (!manifest && !catalog) {
    add(
      'warn',
      'dbt artifacts missing; table-reference validation will be skipped until dbt/manifest.json and dbt/catalog.json are present',
    );
    return;
  }

  add('error', 'Incomplete dbt artifacts; dbt/manifest.json and dbt/catalog.json must be updated together');
}

async function checkKnowledgeValidation(
  rootDir: string,
  add: (status: SetupCheckStatus, message: string) => void,
): Promise<void> {
  const errors = await withoutGcpProject(() => validateKnowledgeForSync(rootDir));
  if (errors.length === 0) {
    add('ok', 'Knowledge validation passed without network-backed dry runs');
    return;
  }

  for (const error of errors) {
    add('error', `Knowledge validation failed: ${error}`);
  }
}

async function checkModelDocs(
  rootDir: string,
  add: (status: SetupCheckStatus, message: string) => void,
): Promise<void> {
  for (const file of ['README.md', '.env.example']) {
    const content = await readText(rootDir, file);
    if (/gemini-3\.0/.test(content)) {
      add(
        'error',
        `Stale Gemini model ID found in ${file}; use gemini-pro-latest/gemini-flash-latest aliases instead`,
      );
    } else {
      add('ok', `Gemini model docs are current in ${file}`);
    }
  }
}

async function checkReadme(
  rootDir: string,
  add: (status: SetupCheckStatus, message: string) => void,
): Promise<void> {
  const readme = await readText(rootDir, 'README.md');
  requireText(readme, 'references/', 'README documents references/ as the primary knowledge authoring path', add);
  requireText(readme, 'scripts/sync-knowledge.ts', 'README documents the current knowledge sync command', add);
  requireText(readme, 'GEMINI_API_KEY_CI', 'README lists the knowledge sync Gemini CI secret', add);
  requireText(readme, 'FILE_SEARCH_STORE_ID', 'README lists the File Search store configuration', add);
  requireText(readme, 'slack-bot-token', 'README lists the Slack bot Secret Manager name', add);
  requireText(readme, 'slack-signing-secret', 'README lists the Slack signing Secret Manager name', add);
  requireText(readme, 'gemini-api-key', 'README lists the Gemini Secret Manager name', add);
  requireText(readme, 'us-west1', 'README documents us-west1 as the standard region', add);

  if (readme.includes('npx tsx scripts/sync-teachings.ts')) {
    add('error', 'README still documents sync-teachings.ts as the manual knowledge sync command');
  } else {
    add('ok', 'README does not use the legacy teaching-only sync command as the manual path');
  }
}

async function checkDeployWorkflow(
  rootDir: string,
  add: (status: SetupCheckStatus, message: string) => void,
): Promise<void> {
  const deploy = await readText(rootDir, '.github/workflows/deploy.yml');
  for (const token of [
    'REGION: us-west1',
    '--project',
    '--region',
    '--service-account',
    '--set-env-vars',
    '--set-secrets',
    '--port',
    '--allow-unauthenticated',
  ]) {
    requireText(deploy, token, `Deploy workflow includes ${token}`, add);
  }
}

async function checkSyncWorkflow(
  rootDir: string,
  add: (status: SetupCheckStatus, message: string) => void,
): Promise<void> {
  const workflow = await readText(rootDir, '.github/workflows/sync-teachings.yml');
  for (const token of [
    'name: Sync Knowledge',
    'references/**/*.yml',
    'teachings/**/*.yml',
    'scripts/knowledgeSync.ts',
    'scripts/knowledgeSupport.ts',
    'scripts/validate-knowledge.ts',
  ]) {
    requireText(workflow, token, `Knowledge sync workflow includes ${token}`, add);
  }
}

async function checkTerraformBoundary(
  rootDir: string,
  add: (status: SetupCheckStatus, message: string) => void,
): Promise<void> {
  const terraform = await readText(rootDir, 'infra/main.tf');
  requireText(terraform, 'default = "us-west1"', 'Terraform defaults to us-west1', add);
  requireText(terraform, 'firestore.indexes.json', 'Terraform derives Firestore indexes from infra/firestore.indexes.json', add);

  for (const forbidden of [
    'google_cloud_run_v2_service',
    'secret_data',
    'variable "slack_bot_token"',
    'variable "slack_signing_secret"',
    'variable "gemini_api_key"',
  ]) {
    if (terraform.includes(forbidden)) {
      add('error', `Terraform still owns runtime deployment or secret values via ${forbidden}`);
    } else {
      add('ok', `Terraform does not include ${forbidden}`);
    }
  }
}

function requireText(
  haystack: string,
  needle: string,
  okMessage: string,
  add: (status: SetupCheckStatus, message: string) => void,
): void {
  if (haystack.includes(needle)) {
    add('ok', okMessage);
  } else {
    add('error', `${okMessage} (missing ${needle})`);
  }
}

async function fileExists(rootDir: string, relativePath: string): Promise<boolean> {
  try {
    await access(join(rootDir, relativePath));
    return true;
  } catch {
    return false;
  }
}

async function readText(rootDir: string, relativePath: string): Promise<string> {
  try {
    return await readFile(join(rootDir, relativePath), 'utf-8');
  } catch {
    return '';
  }
}

async function withoutGcpProject<T>(fn: () => Promise<T>): Promise<T> {
  const original = process.env.GCP_PROJECT_ID;
  delete process.env.GCP_PROJECT_ID;
  try {
    return await fn();
  } finally {
    if (original === undefined) {
      delete process.env.GCP_PROJECT_ID;
    } else {
      process.env.GCP_PROJECT_ID = original;
    }
  }
}

async function main(): Promise<void> {
  const result = await runSetupCheck();
  console.log(formatSetupCheckResult(result));
  if (!result.ok) process.exit(1);
}

if (process.argv[1]?.endsWith('setup-check.ts') || process.argv[1]?.endsWith('setup-check.js')) {
  main().catch(err => {
    console.error('Setup check failed:', err);
    process.exit(1);
  });
}
