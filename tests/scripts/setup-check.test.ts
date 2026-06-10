import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { formatSetupCheckResult, runSetupCheck } from '../../scripts/setup-check.js';

// Track every fixture dir so afterEach can remove it — mkdtemp dirs otherwise
// accumulate under /tmp across runs.
const createdRoots: string[] = [];

afterEach(async () => {
  await Promise.all(createdRoots.map((root) => rm(root, { recursive: true, force: true })));
  createdRoots.length = 0;
});

async function createRepoFixture(overrides: Partial<Record<string, string>> = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'annalytics-setup-check-'));
  createdRoots.push(root);
  await mkdir(join(root, '.github', 'workflows'), { recursive: true });
  await mkdir(join(root, 'docs'), { recursive: true });
  await mkdir(join(root, 'infra'), { recursive: true });
  await mkdir(join(root, 'references'), { recursive: true });
  await mkdir(join(root, 'teachings'), { recursive: true });
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
    'infra/firestore.ttls.json': '{ "ttls": [] }',
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

  it('reports non-flash/pro floating -latest aliases as stale', async () => {
    // The old narrow regex (gemini-(?:pro|flash)-latest) would NOT match this —
    // the broadened -latest\b pattern must catch ANY floating alias, since any of
    // them can silently resolve to a non-3.x model.
    const root = await createRepoFixture({
      'README.md': 'Legacy default model is gemini-1.5-pro-latest.',
    });

    const result = await runSetupCheck({ rootDir: root, env: {} });

    expect(result.findings).toContainEqual({
      status: 'error',
      message: 'Stale Gemini model ID found in README.md; pin a Gemini 3.x id (e.g. gemini-3.1-pro-preview / gemini-3-flash-preview) instead of -latest aliases',
    });
  });

  it('flags a stale model id in the developer\'s active .env, not just docs', async () => {
    // Docs/examples can be perfectly clean while the local runtime config still
    // pins a stale alias — the check must scan .env when it is present.
    const root = await createRepoFixture({
      '.env': 'GEMINI_JUDGE_MODEL=gemini-pro-latest',
    });

    const result = await runSetupCheck({ rootDir: root, env: {} });

    expect(result.findings).toContainEqual({
      status: 'error',
      message: 'Stale Gemini model ID found in .env; pin a Gemini 3.x id (e.g. gemini-3.1-pro-preview / gemini-3-flash-preview) instead of -latest aliases',
    });
  });

  it('does not flag .env when the file is absent', async () => {
    const root = await createRepoFixture();

    const result = await runSetupCheck({ rootDir: root, env: {} });

    // No .env in the fixture → no .env finding at all (neither ok nor error).
    // Anchor on `.env;`/`.env` end-of-string so `.env.example` findings don't
    // count as `.env` matches.
    expect(
      result.findings.some(
        (f) => f.message.includes('found in .env;') || f.message.endsWith('current in .env'),
      ),
    ).toBe(false);
  });

  it('warns about ReferenceCard table mismatches when dbt artifacts are present', async () => {
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

    expect(result.errors).toHaveLength(0);
    expect(result.ok).toBe(true);
    expect(result.findings).toContainEqual({
      status: 'warn',
      message: 'Knowledge validation warning: Reference card revenue-canonical-definition references unknown canonical table: analytics.fct_orders (strict knowledge:validate will still fail before sync)',
    });
  });

  it('warns about teaching table mismatches when dbt artifacts are present', async () => {
    const root = await createRepoFixture({
      'teachings/revenue.yml': [
        'teachings:',
        '  - id: revenue-monthly',
        '    question_patterns: [monthly revenue]',
        '    sanctioned_sql: null',
        '    reasoning: Use completed orders.',
        '    models_referenced: [analytics.fct_orders]',
        '    tags: [revenue]',
        '    author: finance',
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

    expect(result.errors).toHaveLength(0);
    expect(result.ok).toBe(true);
    expect(result.findings).toContainEqual({
      status: 'warn',
      message: 'Knowledge validation warning: Teaching revenue-monthly references unknown model/table: analytics.fct_orders (strict knowledge:validate will still fail before sync)',
    });
  });

  it('keeps non-table knowledge validation failures as errors', async () => {
    const root = await createRepoFixture({
      'teachings/revenue.yml': [
        'teachings:',
        '  - id: revenue-monthly',
        '    question_patterns: [monthly revenue]',
        '    sanctioned_sql: null',
        '    reasoning: Use completed orders.',
        '    models_referenced: [analytics.fct_orders]',
        '    tags: [revenue]',
        '    author: finance',
        '    updated: "2026-06-04"',
      ].join('\n'),
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
        '    related_teachings: [missing-teaching]',
        '    updated: "2026-06-04"',
      ].join('\n'),
      'dbt/manifest.json': JSON.stringify({
        nodes: {
          'model.analytics.fct_orders': {
            resource_type: 'model',
            name: 'fct_orders',
            schema: 'analytics',
            columns: {
              total_amount: { name: 'total_amount' },
            },
          },
        },
      }),
      'dbt/catalog.json': JSON.stringify({
        nodes: {
          'model.analytics.fct_orders': {
            columns: {
              TOTAL_AMOUNT: { type: 'FLOAT64', index: 0 },
            },
          },
        },
      }),
    });

    const result = await runSetupCheck({ rootDir: root, env: {} });

    expect(result.ok).toBe(false);
    expect(result.findings).toContainEqual({
      status: 'error',
      message: 'Knowledge validation failed: Reference card revenue-canonical-definition references unknown related teaching: missing-teaching',
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
