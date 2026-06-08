import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatSetupCheckResult, runSetupCheck } from '../../scripts/setup-check.js';

async function createRepoFixture(overrides: Partial<Record<string, string>> = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'annalytics-setup-check-'));
  await mkdir(join(root, '.github', 'workflows'), { recursive: true });
  await mkdir(join(root, 'docs'), { recursive: true });
  await mkdir(join(root, 'infra'), { recursive: true });
  await mkdir(join(root, 'references'), { recursive: true });
  await mkdir(join(root, 'dbt'), { recursive: true });

  const files: Record<string, string> = {
    'README.md': [
      'Use references/ as the primary knowledge authoring surface.',
      'Run npx tsx scripts/sync-knowledge.ts for manual sync.',
      'Models default to gemini-3.1-pro-preview and gemini-3-flash-preview.',
      'GitHub secrets include GCP_PROJECT_ID, WIF_PROVIDER, WIF_SERVICE_ACCOUNT, GEMINI_API_KEY_CI, FILE_SEARCH_STORE_ID.',
      'Cloud Run uses us-west1 and Secret Manager secrets slack-bot-token, slack-signing-secret, gemini-api-key.',
    ].join('\n'),
    '.env.example': [
      'GEMINI_MODEL=gemini-3.1-pro-preview',
      'GEMINI_FLASH_MODEL=gemini-3-flash-preview',
      'GEMINI_JUDGE_MODEL=gemini-3.1-pro-preview',
    ].join('\n'),
    'docs/trajectory-governance.md': 'Setup simplification records gcloud primary deployment and optional Terraform infrastructure.',
    '.github/workflows/deploy.yml': [
      'env:',
      '  REGION: us-west1',
      'run: |',
      '  gcloud run deploy anna-lytics \\',
      '    --project "${PROJECT_ID}" \\',
      '    --region "${REGION}" \\',
      '    --service-account "anna-lytics@${PROJECT_ID}.iam.gserviceaccount.com" \\',
      '    --set-env-vars "GCP_PROJECT_ID=${PROJECT_ID},FILE_SEARCH_STORE_ID=${FILE_SEARCH_STORE_ID}" \\',
      '    --set-secrets "SLACK_BOT_TOKEN=slack-bot-token:latest,SLACK_SIGNING_SECRET=slack-signing-secret:latest,GEMINI_API_KEY=gemini-api-key:latest" \\',
      '    --port 3000 \\',
      '    --allow-unauthenticated',
    ].join('\n'),
    '.github/workflows/sync-teachings.yml': [
      'name: Sync Knowledge',
      "      - 'references/**/*.yml'",
      "      - 'teachings/**/*.yml'",
      "      - 'scripts/knowledgeSync.ts'",
      "      - 'scripts/knowledgeSupport.ts'",
      "      - 'scripts/validate-knowledge.ts'",
      'run: npm run knowledge:sync',
    ].join('\n'),
    'infra/main.tf': [
      'variable "region" {',
      '  default = "us-west1"',
      '}',
      'locals {',
      '  firestore_index_config = jsondecode(file("${path.module}/firestore.indexes.json"))',
      '}',
      'resource "google_secret_manager_secret" "runtime" {}',
    ].join('\n'),
    'infra/firestore.indexes.json': '{ "indexes": [], "fieldOverrides": [] }',
    'references/README.md': 'Add implementation-specific ReferenceCards here before syncing File Search.',
  };

  for (const [path, content] of Object.entries({ ...files, ...overrides })) {
    await writeFile(join(root, path), content);
  }

  return root;
}

describe('runSetupCheck', () => {
  it('reports missing environment variables by presence only', async () => {
    const root = await createRepoFixture();

    const result = await runSetupCheck({ rootDir: root, env: {} });

    expect(result.errors).toHaveLength(0);
    expect(result.findings).toContainEqual({
      status: 'warn',
      message: 'Environment GCP_PROJECT_ID=missing',
    });
    expect(result.findings).toContainEqual({
      status: 'warn',
      message: 'dbt artifacts missing; table-reference validation will be skipped until dbt/manifest.json and dbt/catalog.json are present',
    });
  });

  it('reports stale Gemini 3.0 model IDs in docs or examples', async () => {
    const root = await createRepoFixture({
      'README.md': 'Default model is gemini-3.0-pro.',
    });

    const result = await runSetupCheck({ rootDir: root, env: {} });

    expect(result.findings).toContainEqual({
      status: 'error',
      message: 'Stale Gemini model ID found in README.md; pin a Gemini 3.x id (e.g. gemini-3.1-pro-preview / gemini-3-flash-preview) instead of -latest aliases',
    });
  });

  it('reports floating -latest aliases as stale (hard 3.x constraint)', async () => {
    const root = await createRepoFixture({
      '.env.example': 'GEMINI_MODEL=gemini-pro-latest',
    });

    const result = await runSetupCheck({ rootDir: root, env: {} });

    expect(result.findings).toContainEqual({
      status: 'error',
      message: 'Stale Gemini model ID found in .env.example; pin a Gemini 3.x id (e.g. gemini-3.1-pro-preview / gemini-3-flash-preview) instead of -latest aliases',
    });
  });

  it('reports ReferenceCard table mismatches when dbt artifacts are present', async () => {
    const root = await createRepoFixture({
      'references/revenue.yml': [
        'reference_cards:',
        '  - id: revenue-canonical-definition',
        '    title: Canonical Revenue Definition',
        '    domain: revenue',
        '    grain: order',
        '    canonical_table: analytics.fct_orders',
        '    canonical_metric: total_amount',
        '    aliases: [revenue]',
        '    routing_triggers: [total revenue]',
        '    owner: finance-analytics',
        '    freshness_sla: daily',
        '    updated: "2026-06-04"',
      ].join('\n'),
      'dbt/manifest.json': JSON.stringify({
        nodes: {
          'model.analytics.fct_revenue': {
            resource_type: 'model',
            name: 'fct_revenue',
            schema: 'analytics',
            columns: {
              revenue: { name: 'revenue' },
            },
          },
        },
      }),
      'dbt/catalog.json': JSON.stringify({
        nodes: {
          'model.analytics.fct_revenue': {
            columns: {
              REVENUE: { type: 'FLOAT64', index: 0 },
            },
          },
        },
      }),
    });

    const result = await runSetupCheck({ rootDir: root, env: {} });

    expect(result.findings).toContainEqual({
      status: 'error',
      message: 'Knowledge validation failed: Reference card revenue-canonical-definition references unknown canonical table: analytics.fct_orders',
    });
  });

  it('does not print secret values in formatted output', async () => {
    const root = await createRepoFixture();
    const result = await runSetupCheck({
      rootDir: root,
      env: {
        GCP_PROJECT_ID: 'example-project',
        GEMINI_API_KEY: 'super-secret-gemini-key',
        FILE_SEARCH_STORE_ID: 'fileSearchStores/private-store',
        SLACK_BOT_TOKEN: 'xoxb-secret',
        SLACK_SIGNING_SECRET: 'slack-secret',
      },
    });

    const output = formatSetupCheckResult(result);

    expect(output).toContain('Environment GEMINI_API_KEY=present');
    expect(output).not.toContain('super-secret-gemini-key');
    expect(output).not.toContain('fileSearchStores/private-store');
    expect(output).not.toContain('xoxb-secret');
    expect(output).not.toContain('slack-secret');
  });
});
