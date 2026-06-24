# Template CI/Deploy Boundary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make template CI pass without implementation-specific dbt artifacts while keeping deploy strict and opt-in.

**Architecture:** Keep the existing `.github/workflows/deploy.yml` file but rename the workflow and split it into always-on testing, an observable deploy-decision job, and a deploy job gated by manual dispatch or `ANNALYTICS_AUTO_DEPLOY=true`. Extend `setup-check` so the README and workflow cannot drift from the opt-in deploy boundary.

**Tech Stack:** GitHub Actions YAML, TypeScript setup-check script, Vitest, README and governance Markdown.

---

## Scope Decisions From The Design

- Keep one workflow file instead of splitting CI and deploy into separate YAML files.
- Use `workflow_dispatch` for manual deploys from `main`.
- Use repository variable `ANNALYTICS_AUTO_DEPLOY=true` for implementation repos that intentionally want push-to-main deploys.
- Keep strict dbt artifact and secret checks inside the deploy job.
- Do not introduce artifact download, storage, or secret-delivery machinery.
- Do not commit `dbt/manifest.json`, `dbt/catalog.json`, `.env`, project IDs, Cloud Run URLs, File Search store IDs, live ReferenceCards, live corpus files, or benchmark evidence.

## File Structure

- `.github/workflows/deploy.yml`
  - Rename workflow to `Build, Test & Optional Deploy`.
  - Add `workflow_dispatch`.
  - Add `deploy-decision` job that writes `should_deploy`.
  - Gate deploy on `needs.deploy-decision.outputs.should_deploy == 'true'`.
  - Validate `GCP_PROJECT_ID`, `FILE_SEARCH_STORE_ID`, `WIF_PROVIDER`,
    `WIF_SERVICE_ACCOUNT`, and dbt artifacts before authentication/build steps.

- `scripts/setup-check.ts`
  - Extend README checks for optional deploy docs.
  - Extend deploy workflow checks for manual dispatch, auto-deploy variable, deploy-decision job, and deploy output gate.

- `tests/scripts/setup-check.test.ts`
  - Update baseline fixture to match the new expected workflow and README tokens.
  - Add regression tests for missing README optional-deploy docs and missing workflow opt-in deploy boundary.

- `README.md`
  - Replace the automatic deploy section with CI and optional deploy guidance.
  - Document `workflow_dispatch` and `ANNALYTICS_AUTO_DEPLOY=true`.
  - Keep the manual `gcloud run deploy` instructions.

- `docs/trajectory-governance.md`
  - Record this as trust-maintenance work.
  - Keep product trajectory unchanged.

---

### Task 1: Setup-Check Guardrails

**Files:**
- Modify: `tests/scripts/setup-check.test.ts`
- Modify: `scripts/setup-check.ts`

- [ ] **Step 1: Write failing setup-check tests**

In `tests/scripts/setup-check.test.ts`, update the default fixture README and deploy workflow strings inside `createRepoFixture` to include the new intended tokens:

```typescript
'README.md': [
  'Use references/ as the primary knowledge authoring surface.',
  'Run npx tsx scripts/sync-knowledge.ts for manual sync.',
  'Models default to gemini-3.1-pro-preview and gemini-3-flash-preview.',
  'GitHub secrets include GCP_PROJECT_ID, WIF_PROVIDER, WIF_SERVICE_ACCOUNT, GEMINI_API_KEY_CI, FILE_SEARCH_STORE_ID.',
  'Cloud Run uses us-west1 and Secret Manager secrets slack-bot-token, slack-signing-secret, gemini-api-key.',
  'Template pushes do not deploy by default.',
  'Manual GitHub Actions deploys use workflow_dispatch.',
  'Implementation repos may set ANNALYTICS_AUTO_DEPLOY=true when dbt artifacts are available in the build workspace.',
].join('\n'),
```

Replace the fixture deploy workflow body with:

```typescript
'.github/workflows/deploy.yml': [
  'name: Build, Test & Optional Deploy',
  'on:',
  '  push:',
  '    branches: [main]',
  '  pull_request:',
  '    branches: [main]',
  '  workflow_dispatch:',
  'jobs:',
  '  test:',
  '    runs-on: ubuntu-latest',
  '  deploy-decision:',
  '    needs: test',
  "    if: github.ref == 'refs/heads/main'",
  '    outputs:',
  '      should_deploy: ${{ steps.decision.outputs.should_deploy }}',
  '    steps:',
  '      - id: decision',
  '        env:',
  '          ANNALYTICS_AUTO_DEPLOY: ${{ vars.ANNALYTICS_AUTO_DEPLOY }}',
  '        run: |',
  '          echo "should_deploy=false" >> "$GITHUB_OUTPUT"',
  '          echo "Deploy skipped" >> "$GITHUB_STEP_SUMMARY"',
  'env:',
  '  REGION: us-west1',
  '  WIF_PROVIDER: ${{ secrets.WIF_PROVIDER }}',
  '  WIF_SERVICE_ACCOUNT: ${{ secrets.WIF_SERVICE_ACCOUNT }}',
  'deploy:',
  "  if: github.ref == 'refs/heads/main' && needs.deploy-decision.outputs.should_deploy == 'true'",
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
```

Add these tests near the existing setup-check tests:

```typescript
it('requires README to document optional deploy controls', async () => {
  const root = await createRepoFixture({
    'README.md': [
      'Use references/ as the primary knowledge authoring surface.',
      'Run npx tsx scripts/sync-knowledge.ts for manual sync.',
      'Models default to gemini-3.1-pro-preview and gemini-3-flash-preview.',
      'GitHub secrets include GCP_PROJECT_ID, WIF_PROVIDER, WIF_SERVICE_ACCOUNT, GEMINI_API_KEY_CI, FILE_SEARCH_STORE_ID.',
      'Cloud Run uses us-west1 and Secret Manager secrets slack-bot-token, slack-signing-secret, gemini-api-key.',
    ].join('\n'),
  });

  const result = await runSetupCheck({ rootDir: root, env: {} });

  expect(result.findings).toContainEqual({
    status: 'error',
    message: 'README states template pushes do not deploy by default (missing Template pushes do not deploy by default)',
  });
  expect(result.findings).toContainEqual({
    status: 'error',
    message: 'README documents manual GitHub Actions deploy dispatch (missing workflow_dispatch)',
  });
  expect(result.findings).toContainEqual({
    status: 'error',
    message: 'README documents opt-in automatic deploy variable (missing ANNALYTICS_AUTO_DEPLOY)',
  });
});

it('requires deploy workflow to keep deployment opt-in', async () => {
  const root = await createRepoFixture({
    '.github/workflows/deploy.yml': [
      'name: Build, Test & Deploy',
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
  });

  const result = await runSetupCheck({ rootDir: root, env: {} });

  expect(result.findings).toContainEqual({
    status: 'error',
    message: 'Deploy workflow uses optional-deploy name (missing name: Build, Test & Optional Deploy)',
  });
  expect(result.findings).toContainEqual({
    status: 'error',
    message: 'Deploy workflow supports manual dispatch (missing workflow_dispatch:)',
  });
  expect(result.findings).toContainEqual({
    status: 'error',
    message: 'Deploy workflow reads ANNALYTICS_AUTO_DEPLOY variable (missing ANNALYTICS_AUTO_DEPLOY)',
  });
  expect(result.findings).toContainEqual({
    status: 'error',
    message: 'Deploy workflow records deploy decision output (missing should_deploy)',
  });
  expect(result.findings).toContainEqual({
    status: 'error',
    message: "Deploy workflow gates deploy job on deploy decision output (missing needs.deploy-decision.outputs.should_deploy == 'true')",
  });
  expect(result.findings).toContainEqual({
    status: 'error',
    message: 'Deploy workflow validates WIF_PROVIDER before auth (missing WIF_PROVIDER)',
  });
  expect(result.findings).toContainEqual({
    status: 'error',
    message: 'Deploy workflow validates WIF_SERVICE_ACCOUNT before auth (missing WIF_SERVICE_ACCOUNT)',
  });
});
```

- [ ] **Step 2: Run the failing tests**

Run:

```bash
npx vitest run tests/scripts/setup-check.test.ts
```

Expected: FAIL because `scripts/setup-check.ts` does not yet require the new README or workflow tokens, so the expected error findings are absent.

- [ ] **Step 3: Implement setup-check token requirements**

In `scripts/setup-check.ts`, add these checks to `checkReadme` after the existing README `requireText` calls:

```typescript
  requireText(
    readme,
    'Template pushes do not deploy by default',
    'README states template pushes do not deploy by default',
    add,
  );
  requireText(readme, 'workflow_dispatch', 'README documents manual GitHub Actions deploy dispatch', add);
  requireText(readme, 'ANNALYTICS_AUTO_DEPLOY', 'README documents opt-in automatic deploy variable', add);
```

Replace the token list in `checkDeployWorkflow` with this list:

```typescript
  const deployWorkflowTokens: Array<[string, string]> = [
    ['name: Build, Test & Optional Deploy', 'Deploy workflow uses optional-deploy name'],
    ['workflow_dispatch:', 'Deploy workflow supports manual dispatch'],
    ['deploy-decision', 'Deploy workflow includes deploy-decision job'],
    ['ANNALYTICS_AUTO_DEPLOY', 'Deploy workflow reads ANNALYTICS_AUTO_DEPLOY variable'],
    ['WIF_PROVIDER', 'Deploy workflow validates WIF_PROVIDER before auth'],
    ['WIF_SERVICE_ACCOUNT', 'Deploy workflow validates WIF_SERVICE_ACCOUNT before auth'],
    ['should_deploy', 'Deploy workflow records deploy decision output'],
    [
      "needs.deploy-decision.outputs.should_deploy == 'true'",
      'Deploy workflow gates deploy job on deploy decision output',
    ],
    ['REGION: us-west1', 'Deploy workflow includes REGION: us-west1'],
    ['--project', 'Deploy workflow includes --project'],
    ['--region', 'Deploy workflow includes --region'],
    ['--service-account', 'Deploy workflow includes --service-account'],
    ['--set-env-vars', 'Deploy workflow includes --set-env-vars'],
    ['--set-secrets', 'Deploy workflow includes --set-secrets'],
    ['--port', 'Deploy workflow includes --port'],
    ['--allow-unauthenticated', 'Deploy workflow includes --allow-unauthenticated'],
  ];

  for (const [token, label] of deployWorkflowTokens) {
    requireText(deploy, token, label, add);
  }
```

- [ ] **Step 4: Run the setup-check tests**

Run:

```bash
npx vitest run tests/scripts/setup-check.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/setup-check.ts tests/scripts/setup-check.test.ts
git commit -m "test: guard optional deploy boundary"
```

---

### Task 2: Optional Deploy Workflow

**Files:**
- Modify: `.github/workflows/deploy.yml`

- [ ] **Step 1: Verify the real workflow now fails setup-check**

Run:

```bash
npm run setup:check
```

Expected: FAIL with errors for the missing optional-deploy workflow tokens. This confirms Task 1 is guarding the real workflow.

- [ ] **Step 2: Replace the deploy workflow**

Replace `.github/workflows/deploy.yml` with:

```yaml
name: Build, Test & Optional Deploy

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
  workflow_dispatch:

env:
  PROJECT_ID: ${{ secrets.GCP_PROJECT_ID }}
  REGION: us-west1
  SERVICE_NAME: anna-lytics
  FILE_SEARCH_STORE_ID: ${{ secrets.FILE_SEARCH_STORE_ID }}
  WIF_PROVIDER: ${{ secrets.WIF_PROVIDER }}
  WIF_SERVICE_ACCOUNT: ${{ secrets.WIF_SERVICE_ACCOUNT }}

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: npm ci
      - run: npm run knowledge:validate
      - run: npm run setup:check
      - run: npm run typecheck
      - run: npm test

  deploy-decision:
    needs: test
    if: github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    outputs:
      should_deploy: ${{ steps.decision.outputs.should_deploy }}
    steps:
      - id: decision
        env:
          ANNALYTICS_AUTO_DEPLOY: ${{ vars.ANNALYTICS_AUTO_DEPLOY }}
        run: |
          if [[ "${GITHUB_EVENT_NAME}" == "workflow_dispatch" || "${ANNALYTICS_AUTO_DEPLOY}" == "true" ]]; then
            echo "should_deploy=true" >> "$GITHUB_OUTPUT"
            echo "Deploy requested. The deploy job will validate secrets and dbt artifacts before publishing." >> "$GITHUB_STEP_SUMMARY"
          else
            echo "should_deploy=false" >> "$GITHUB_OUTPUT"
            echo "Deploy skipped. Template pushes do not deploy by default because dbt artifacts are implementation-specific and gitignored." >> "$GITHUB_STEP_SUMMARY"
          fi

  deploy:
    needs: [test, deploy-decision]
    if: github.ref == 'refs/heads/main' && needs.deploy-decision.outputs.should_deploy == 'true'
    runs-on: ubuntu-latest
    permissions:
      contents: read
      id-token: write

    steps:
      - uses: actions/checkout@v4

      - name: Validate deploy configuration
        run: |
          test -n "${PROJECT_ID}" || (echo "Missing GCP_PROJECT_ID secret" && exit 1)
          test -n "${FILE_SEARCH_STORE_ID}" || (echo "Missing FILE_SEARCH_STORE_ID secret" && exit 1)
          test -n "${WIF_PROVIDER}" || (echo "Missing WIF_PROVIDER secret" && exit 1)
          test -n "${WIF_SERVICE_ACCOUNT}" || (echo "Missing WIF_SERVICE_ACCOUNT secret" && exit 1)
          test -f dbt/manifest.json || (echo "Missing dbt/manifest.json; provide implementation-specific dbt artifacts before deploy" && exit 1)
          test -f dbt/catalog.json || (echo "Missing dbt/catalog.json; provide implementation-specific dbt artifacts before deploy" && exit 1)

      - id: auth
        uses: google-github-actions/auth@v2
        with:
          workload_identity_provider: ${{ env.WIF_PROVIDER }}
          service_account: ${{ env.WIF_SERVICE_ACCOUNT }}

      - uses: google-github-actions/setup-gcloud@v2

      - name: Set gcloud project
        run: gcloud config set project "${PROJECT_ID}"

      - name: Build and push Docker image
        run: |
          gcloud auth configure-docker "${REGION}-docker.pkg.dev"
          docker build -t "${REGION}-docker.pkg.dev/${PROJECT_ID}/anna-lytics/anna-lytics:${GITHUB_SHA}" .
          docker push "${REGION}-docker.pkg.dev/${PROJECT_ID}/anna-lytics/anna-lytics:${GITHUB_SHA}"
          docker tag "${REGION}-docker.pkg.dev/${PROJECT_ID}/anna-lytics/anna-lytics:${GITHUB_SHA}" \
            "${REGION}-docker.pkg.dev/${PROJECT_ID}/anna-lytics/anna-lytics:latest"
          docker push "${REGION}-docker.pkg.dev/${PROJECT_ID}/anna-lytics/anna-lytics:latest"

      - name: Deploy to Cloud Run
        run: |
          gcloud run deploy "${SERVICE_NAME}" \
            --project "${PROJECT_ID}" \
            --image "${REGION}-docker.pkg.dev/${PROJECT_ID}/anna-lytics/anna-lytics:${GITHUB_SHA}" \
            --region "${REGION}" \
            --service-account "${SERVICE_NAME}@${PROJECT_ID}.iam.gserviceaccount.com" \
            --set-env-vars "GCP_PROJECT_ID=${PROJECT_ID},FILE_SEARCH_STORE_ID=${FILE_SEARCH_STORE_ID},GEMINI_MODEL=gemini-3.1-pro-preview,GEMINI_FLASH_MODEL=gemini-3-flash-preview,GEMINI_JUDGE_MODEL=gemini-3.1-pro-preview" \
            --set-secrets "SLACK_BOT_TOKEN=slack-bot-token:latest,SLACK_SIGNING_SECRET=slack-signing-secret:latest,GEMINI_API_KEY=gemini-api-key:latest" \
            --port 3000 \
            --allow-unauthenticated
```

- [ ] **Step 3: Run targeted validation**

Run:

```bash
npx vitest run tests/scripts/setup-check.test.ts
```

Expected: PASS.

Run:

```bash
npm run setup:check
```

Expected: FAIL only if README has not yet been updated by Task 3. There should be no remaining deploy workflow errors.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/deploy.yml
git commit -m "ci: make template deploy opt-in"
```

---

### Task 3: README Deployment Guidance

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Confirm README guard is failing**

Run:

```bash
npm run setup:check
```

Expected: FAIL with README errors for missing `Template pushes do not deploy by default`, `workflow_dispatch`, and `ANNALYTICS_AUTO_DEPLOY`.

- [ ] **Step 2: Replace the automatic deploy section**

In `README.md`, replace the section that starts with `### Automatic` and ends before `### Manual` with:

```markdown
### CI and Optional Deploy

Pull requests and pushes to `main` trigger `.github/workflows/deploy.yml`.
The default template path validates code but does not deploy:

1. Installs dependencies.
2. Validates knowledge, setup docs/workflows, TypeScript, and tests.
3. Records that deploy was skipped unless it was explicitly requested.

Template pushes do not deploy by default because `dbt/manifest.json` and
`dbt/catalog.json` are implementation-specific and gitignored. A deploy can be
requested in either of two ways:

1. Run the workflow manually on `main` with GitHub Actions `workflow_dispatch`.
2. In an implementation repository that intentionally provides dbt artifacts in
   the build workspace, set repository variable
   `ANNALYTICS_AUTO_DEPLOY=true` to restore push-to-main deploy.

When deploy is requested, the workflow builds and pushes the Docker image to
Artifact Registry, then deploys Cloud Run with explicit project, region,
service account, env vars, Secret Manager bindings, port, and unauthenticated
Slack endpoint access.

Deployment still requires `dbt/manifest.json` and `dbt/catalog.json` to be
present in the build workspace. The deploy job fails fast with a clear message
if an implementation has not provided those artifacts.

Required GitHub configuration for CI and deploy-related workflows:

| Name | Type | Description |
|------|------|-------------|
| `GCP_PROJECT_ID` | Secret | Target GCP project ID for deploy |
| `WIF_PROVIDER` | Secret | Workload Identity Federation provider resource name for deploy |
| `WIF_SERVICE_ACCOUNT` | Secret | GitHub Actions deploy service account |
| `GEMINI_API_KEY_CI` | Secret | Gemini API key used by Sync Knowledge |
| `FILE_SEARCH_STORE_ID` | Secret | Gemini File Search store ID used by sync, deploy, and benchmark runs |
| `ANNALYTICS_AUTO_DEPLOY` | Repository variable | Optional. Set to `true` only in implementation repos that provide dbt artifacts in the build workspace and want push-to-main deploys. |
```

- [ ] **Step 3: Run setup-check**

Run:

```bash
npm run setup:check
```

Expected: PASS.

- [ ] **Step 4: Run setup-check tests**

Run:

```bash
npx vitest run tests/scripts/setup-check.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "docs: document optional deploy boundary"
```

---

### Task 4: Governance Record And Full Verification

**Files:**
- Modify: `docs/trajectory-governance.md`

- [ ] **Step 1: Update Current State date and table**

Change the heading:

```markdown
## Current State (as of 2026-06-12)
```

to:

```markdown
## Current State (as of 2026-06-24)
```

Add this row to the Current State table:

```markdown
| Template CI/deploy signal | Normal PR and `main` CI validate code without implementation-specific dbt artifacts; Cloud Run deploy is opt-in via `workflow_dispatch` or `ANNALYTICS_AUTO_DEPLOY=true` and still fails fast when requested without artifacts |
```

- [ ] **Step 2: Add Current Decision note**

Add this numbered item to the end of `## Current Decision`:

```markdown
6. **Template CI/deploy signal maintenance is approved as trust maintenance.** The active product queue is unchanged: second-domain selection still waits on real production feedback, and WhatsApp remains a gated prototype. The deploy workflow is allowed to change so the reusable template's `main` signal is not red merely because implementation-specific dbt artifacts are absent. Requested deploys still validate those artifacts strictly.
```

- [ ] **Step 3: Add Evidence Log entry**

Add this entry immediately after `## Evidence Log`:

```markdown
### 2026-06-24 - Template CI/deploy boundary

- Decision: treat the red `main` deploy caused by absent gitignored dbt artifacts as an operational trust signal defect, not as a product tranche or a reason to commit implementation artifacts.
- Change: `.github/workflows/deploy.yml` now runs validation by default and makes Cloud Run deploy opt-in through `workflow_dispatch` or `ANNALYTICS_AUTO_DEPLOY=true`; deploy still fails fast when requested without required secrets or dbt artifacts.
- Documentation: README now describes CI and optional deploy behavior, including the implementation-repo variable for restoring push-to-main deploy.
- Guardrail: `scripts/setup-check.ts` and `tests/scripts/setup-check.test.ts` now require the optional-deploy workflow and README tokens so the boundary cannot silently regress.
- Template boundary held: no live dbt artifacts, project IDs, File Search store IDs, ReferenceCards, corpus retargets, benchmark evidence, or Cloud Run URLs were committed.
```

- [ ] **Step 4: Run targeted consistency checks**

Run:

```bash
rg -n "Template CI/deploy signal|ANNALYTICS_AUTO_DEPLOY|workflow_dispatch|Optional Deploy" docs/trajectory-governance.md README.md .github/workflows/deploy.yml scripts/setup-check.ts tests/scripts/setup-check.test.ts
```

Expected: output shows the workflow, README, setup-check, tests, and governance all mention the optional deploy boundary.

- [ ] **Step 5: Run full verification**

Run:

```bash
npm run setup:check
```

Expected: PASS.

Run:

```bash
npm run typecheck
```

Expected: PASS.

Run:

```bash
npm test
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add docs/trajectory-governance.md
git commit -m "docs: record template deploy signal maintenance"
```

---

## Final PR Checklist

- [ ] `git status --short` shows only intentional tracked changes before each commit.
- [ ] `git log --oneline --max-count=5` shows the three or four tranche commits.
- [ ] No ignored implementation files are staged:

```bash
git status --ignored --short dbt benchmarks references .env
```

Expected: ignored local implementation files, if present, remain unstaged and uncommitted.

- [ ] Create a PR explaining:
  - why `main` was red without a code failure;
  - why dbt artifacts stay out of the template;
  - how `workflow_dispatch` and `ANNALYTICS_AUTO_DEPLOY=true` preserve deployment for implementations.

- [ ] After merge, confirm the next `main` workflow is green with deploy skipped unless explicitly requested.
