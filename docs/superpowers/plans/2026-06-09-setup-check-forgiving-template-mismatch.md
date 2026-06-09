# Forgiving Setup Check Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `npm run setup:check` forgiving when starter/template knowledge examples do not match local dbt artifacts, while keeping strict knowledge validation for File Search sync and real implementation acceptance.

**Architecture:** Keep `scripts/knowledgeSupport.ts` and `npm run knowledge:validate` strict. Add a small severity classifier inside `scripts/setup-check.ts` so setup preflight downgrades ReferenceCard table mismatches and teaching model/table mismatches to warnings, but leaves malformed knowledge, missing related teachings, stale model IDs, and incomplete dbt artifacts as errors. Network-backed teaching SQL dry-run failures remain strict under `knowledge:validate` / `knowledge:sync` when `GCP_PROJECT_ID` is configured; setup preflight continues to skip those dry runs by clearing `GCP_PROJECT_ID`. Update README copy to distinguish forgiving local setup preflight from strict implementation/sync validation.

**Tech Stack:** TypeScript, Node.js scripts, Vitest, existing Anna Lytics setup/knowledge validation helpers.

---

## File Structure

- Modify `scripts/setup-check.ts`
  - Add a setup-only classifier for knowledge validation errors.
  - Convert ReferenceCard/dbt table mismatch findings and teaching/dbt model-table mismatch findings to `WARN`.
  - Keep every other knowledge validation error as `ERROR`.
- Modify `tests/scripts/setup-check.test.ts`
  - Update the existing ReferenceCard mismatch test to expect warning-only setup behavior.
  - Add a teaching mismatch test that expects warning-only setup behavior.
  - Add a regression test proving non-table knowledge errors remain hard errors.
- Modify `tests/scripts/knowledgeSupport.test.ts`
  - Add/adjust strict-validation tests proving `validateKnowledgeForSync()` still returns ReferenceCard and teaching table mismatches as errors.
- Modify `README.md`
  - Clarify that `setup:check` is forgiving for template/example dbt mismatches.
  - Clarify that `knowledge:validate` remains strict before File Search sync, acceptance runs, or implementation deploy confidence.

## Task 1: Downgrade Only dbt Table Mismatches In Setup Check

**Files:**
- Modify: `tests/scripts/setup-check.test.ts`
- Modify: `scripts/setup-check.ts`

- [ ] **Step 1: Update the existing failing test for setup-check table mismatches**

In `tests/scripts/setup-check.test.ts`, rename the test at about line 170 and change the expected finding from `error` to `warn`.

Replace:

```ts
  it('reports ReferenceCard table mismatches when dbt artifacts are present', async () => {
```

with:

```ts
  it('warns about ReferenceCard table mismatches when dbt artifacts are present', async () => {
```

Replace the assertion:

```ts
    expect(result.findings).toContainEqual({
      status: 'error',
      message: 'Knowledge validation failed: Reference card revenue-canonical-definition references unknown canonical table: analytics.fct_orders',
    });
```

with:

```ts
    expect(result.errors).toHaveLength(0);
    expect(result.ok).toBe(true);
    expect(result.findings).toContainEqual({
      status: 'warn',
      message: 'Knowledge validation warning: Reference card revenue-canonical-definition references unknown canonical table: analytics.fct_orders (strict knowledge:validate will still fail before sync)',
    });
```

- [ ] **Step 2: Add a hard-error regression test for non-table knowledge failures**

Still in `tests/scripts/setup-check.test.ts`, add this test after the table-mismatch test:

```ts
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
```

- [ ] **Step 3: Run setup-check tests to verify they fail**

Run:

```bash
npx vitest run tests/scripts/setup-check.test.ts
```

Expected: FAIL. The first updated test still receives `status: 'error'` and message prefix `Knowledge validation failed:` because production code has not been changed yet.

- [ ] **Step 4: Implement the setup-only severity classifier**

In `scripts/setup-check.ts`, add this helper below `checkKnowledgeValidation()`:

```ts
function setupStatusForKnowledgeError(error: string): SetupCheckStatus {
  return isDbtTableReferenceMismatch(error) ? 'warn' : 'error';
}

function setupMessageForKnowledgeError(error: string): string {
  if (setupStatusForKnowledgeError(error) === 'warn') {
    return `Knowledge validation warning: ${error} (strict knowledge:validate will still fail before sync)`;
  }
  return `Knowledge validation failed: ${error}`;
}

function isDbtTableReferenceMismatch(error: string): boolean {
  return /references unknown (canonical|avoid) table: /.test(error);
}
```

Then replace the loop inside `checkKnowledgeValidation()`:

```ts
  for (const error of errors) {
    add('error', `Knowledge validation failed: ${error}`);
  }
```

with:

```ts
  for (const error of errors) {
    add(setupStatusForKnowledgeError(error), setupMessageForKnowledgeError(error));
  }
```

- [ ] **Step 5: Run setup-check tests to verify they pass**

Run:

```bash
npx vitest run tests/scripts/setup-check.test.ts
```

Expected: PASS.

## Task 2: Prove Strict Knowledge Validation Remains Strict

**Files:**
- Modify: `tests/scripts/knowledgeSupport.test.ts`

- [ ] **Step 1: Add a strict table-mismatch regression test**

In `tests/scripts/knowledgeSupport.test.ts`, inside `describe('validateKnowledgeForSync', ...)`, add this test after the existing test that validates references without dbt artifacts:

```ts
  it('keeps ReferenceCard table mismatches strict for sync validation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'annalytics-knowledge-'));
    await mkdir(join(root, 'references'), { recursive: true });
    await mkdir(join(root, 'dbt'), { recursive: true });
    await writeFile(join(root, 'references', 'revenue.yml'), `
reference_cards:
  - id: revenue-canonical-definition
    title: Canonical Revenue Definition
    domain: revenue
    grain: order
    canonical_table: analytics.fct_orders
    canonical_metric: total_amount
    aliases: [revenue]
    routing_triggers: [total revenue]
    owner: finance-analytics
    freshness_sla: daily
    updated: "2026-06-04"
`);
    await writeFile(join(root, 'dbt', 'manifest.json'), JSON.stringify({
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
    }));
    await writeFile(join(root, 'dbt', 'catalog.json'), JSON.stringify({
      nodes: {
        'model.analytics.fct_revenue': {
          columns: {
            REVENUE: { type: 'FLOAT64', index: 0 },
          },
        },
      },
    }));

    await expect(validateKnowledgeForSync(root)).resolves.toContain(
      'Reference card revenue-canonical-definition references unknown canonical table: analytics.fct_orders',
    );
  });
```

- [ ] **Step 2: Run the strict validation test**

Run:

```bash
npx vitest run tests/scripts/knowledgeSupport.test.ts -t "keeps ReferenceCard table mismatches strict"
```

Expected: PASS. This proves `validateKnowledgeForSync()` still reports the mismatch as an error; only `setup:check` changes the severity.

## Task 3: Update README Guidance For Forgiving Setup vs Strict Sync

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update validation guidance near the top of README**

Replace the paragraph and command at about lines 38-44:

```md
Run validation before syncing or deploying:

```bash
npm run knowledge:validate
```
```

with:

```md
Run strict validation before syncing File Search, recording acceptance evidence, or treating an implementation schema as aligned:

```bash
npm run knowledge:validate
```

`npm run setup:check` is a local preflight and may warn, rather than fail, when starter/template ReferenceCards or teachings do not match the current local dbt artifacts. Those warnings are acceptable for template setup, but not for implementation knowledge sync.
```

- [ ] **Step 2: Update local setup guidance near dbt artifact copy instructions**

Replace the paragraph at about line 207:

```md
The implementation dbt artifacts must align with `references/` and `benchmarks/corpus.json`. If ReferenceCards mention tables absent from the copied dbt artifacts, `npm run knowledge:validate` fails. The template gitignores `dbt/manifest.json` and `dbt/catalog.json` so client schema is not accidentally committed here; implementation repositories can choose their own artifact delivery model.
```

with:

```md
The implementation dbt artifacts must align with `references/`, optional `teachings/`, and `benchmarks/corpus.json` before File Search sync or acceptance runs. If knowledge YAML mentions tables absent from the copied dbt artifacts, `npm run knowledge:validate` fails. `npm run setup:check` reports the same mismatch as a warning so template users can still verify local wiring when starter examples and local artifacts are intentionally out of sync. The template gitignores `dbt/manifest.json` and `dbt/catalog.json` so client schema is not accidentally committed here; implementation repositories can choose their own artifact delivery model.
```

- [ ] **Step 3: Update dbt metadata checklist**

Replace item 4 at about line 405:

```md
4. Run `npm run setup:check`.
```

with:

```md
4. Run `npm run setup:check`; treat table-reference warnings as acceptable only for template/example setup, not for implementation readiness.
```

- [ ] **Step 4: Run README-related setup-check tests**

Run:

```bash
npx vitest run tests/scripts/setup-check.test.ts
```

Expected: PASS. The README token checks should remain green because the updated copy still mentions `references/`, `scripts/sync-knowledge.ts`, `FILE_SEARCH_STORE_ID`, Secret Manager names, and `us-west1`.

## Task 4: Verify Real Local Behavior

**Files:**
- No source edits expected.

- [ ] **Step 1: Run setup preflight with the local `.env` sourced**

Run:

```bash
set -a; . ./.env; set +a; npm run setup:check
```

Expected: PASS exit code. Output should show `WARN Knowledge validation warning: ...` entries for the known `analytics.fct_orders` / `analytics.fct_revenue` mismatches, and the final line should report `Result: 0 errors, <N> warnings`.

- [ ] **Step 2: Run strict knowledge validation**

Run:

```bash
npm run knowledge:validate
```

Expected: FAIL with the same table mismatch messages. This is intentional and proves the strict sync gate was not weakened.

- [ ] **Step 3: Run targeted tests**

Run:

```bash
npx vitest run tests/scripts/setup-check.test.ts tests/scripts/knowledgeSupport.test.ts
```

Expected: PASS.

- [ ] **Step 4: Run full verification**

Run:

```bash
npm run typecheck
npm test
git diff --check
```

Expected: typecheck passes, Vitest passes, and `git diff --check` prints no whitespace errors.

## Task 5: Completion Notes

**Files:**
- No source edits expected.

- [ ] **Step 1: Review changed files**

Run:

```bash
git diff -- scripts/setup-check.ts tests/scripts/setup-check.test.ts tests/scripts/knowledgeSupport.test.ts README.md
git status --short
```

Expected: only intended setup-check, tests, and README files changed in this task. Existing Slack status-copy changes may still be present from the current worktree; do not revert them.

- [ ] **Step 2: Report the behavior split**

Final handoff should state:

```text
setup:check now warns for ReferenceCard/dbt table mismatches so template/local setup can continue.
knowledge:validate and knowledge:sync remain strict and still fail on the same mismatches.
```

Also report the exact verification commands and the known intentional `knowledge:validate` failure if run against the current local artifacts.

---

## Self-Review

- Spec coverage: The plan covers forgiving setup preflight, strict sync validation, README documentation, and local behavior verification.
- Placeholder scan: The plan contains concrete files, code, commands, and expected results.
- Type consistency: New helpers use the existing `SetupCheckStatus` union and do not change `validateKnowledgeForSync()` signatures.
