# ReferenceCard Repair Re-run Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Repair the sessions and traffic ReferenceCard acceptance failures, then re-run the existing acceptance workflow until the governance branch can advance or remain repair-scoped with fresh evidence.

**Architecture:** The template-safe work tightens three existing contracts: ReferenceCard summaries for clarification, SQL generator prompt instructions, and supervisor review criteria. Implementation-specific live card edits and benchmark artifacts stay in ignored local files; the tracked plan points to an ignored operator supplement for exact install content.

**Tech Stack:** TypeScript, Vitest, Gemini File Search, BigQuery dry runs, existing benchmark/analyzer scripts.

---

## Boundary Note

This plan intentionally separates tracked template work from operator-local install work.

- Tracked and committed: prompt/summary tests and implementation, this plan, and the final governance decision.
- Ignored and not committed: `references/*.live.yml`, `benchmarks/corpus.live.json`, `benchmarks/results/*`, `dbt/manifest.json`, `dbt/catalog.json`, `.env`, and any exact project/store identifiers.
- Operator-local exact card edits live in `docs/plans/2026-06-11-referencecard-repair-rerun-operator.md`, which is ignored by `.gitignore`.

Do not paste live project IDs, File Search store names, raw benchmark output, or client-specific dbt artifacts into tracked files.

## File Structure

- `tests/teachings/summaryMap.test.ts`: proves ReferenceCard summaries include compact required/exclusion/avoid guidance for clarification.
- `src/teachings/summaryMap.ts`: expands ReferenceCard summary definitions without copying full markdown.
- `tests/agents/sqlGenerator.test.ts`: proves SQL generation prompt treats retrieved ReferenceCards as binding operational constraints.
- `src/agents/sqlGenerator.ts`: strengthens the generic File Search/ReferenceCard instruction.
- `tests/agents/supervisorAgent.test.ts`: proves supervisor prompt treats ReferenceCard contradictions as review failures.
- `src/agents/supervisorAgent.ts`: strengthens the generic review checklist.
- `docs/plans/2026-06-11-referencecard-repair-rerun-operator.md`: ignored operator supplement for live cards and re-run commands.
- `docs/trajectory-governance.md`: final decision record after the live re-run.

## Task 0: Prepare The Work Area

**Files:**
- Read: `docs/trajectory-governance.md`
- Read: `docs/superpowers/specs/2026-06-11-referencecard-repair-rerun-design.md`
- Read: `docs/plans/2026-06-11-referencecard-repair-rerun-operator.md`

- [ ] **Step 1: Confirm repository status**

Run:

```bash
git status --short
git branch --show-current
git log -1 --oneline
```

Expected: either a clean tree, or only ignored operator-local files. If tracked files are dirty, inspect them before editing and do not overwrite unrelated work.

- [ ] **Step 2: Confirm ignored operator-local artifacts are present**

Run:

```bash
git check-ignore -v references/sessions-traffic.live.yml benchmarks/corpus.live.json dbt/manifest.json dbt/catalog.json
```

Expected: each path is ignored by `.gitignore`. If a path is not present locally, continue with template-safe tasks and stop before live sync/benchmark.

## Task 1: Expand ReferenceCard Summary Guidance

**Files:**
- Modify: `tests/teachings/summaryMap.test.ts`
- Modify: `src/teachings/summaryMap.ts`

- [ ] **Step 1: Write the failing test**

In `tests/teachings/summaryMap.test.ts`, append this test inside the existing `describe('buildKnowledgeSummaries', () => { ... })` block:

```typescript
  it('summarizes ReferenceCard required guidance, exclusions, and avoid tables', () => {
    const summaries = buildKnowledgeSummaries([], [{
      ...revenueCard,
      avoid_tables: ['analytics.raw_orders'],
    }]);

    const summary = summaries[0];
    expect(summary.definition).toContain('Canonical Revenue Definition.');
    expect(summary.definition).toContain('Canonical metric total_amount at order grain.');
    expect(summary.definition).toContain("Required guidance: order_status = 'completed'.");
    expect(summary.definition).toContain('Exclusions: cancelled orders.');
    expect(summary.definition).toContain('Avoid tables: analytics.raw_orders.');
  });
```

- [ ] **Step 2: Run the test and verify it fails**

Run:

```bash
npx vitest run tests/teachings/summaryMap.test.ts
```

Expected: FAIL because the current summary definition does not include exclusions or avoid-table guidance.

- [ ] **Step 3: Implement the summary contract**

In `src/teachings/summaryMap.ts`, replace `buildReferenceSummaryDefinition` with:

```typescript
function buildReferenceSummaryDefinition(card: ReferenceCard): string {
  const parts = [
    `${card.title}.`,
    `Canonical metric ${card.canonical_metric} at ${card.grain} grain.`,
  ];

  if (card.required_filters.length > 0) {
    parts.push(`Required guidance: ${card.required_filters.join('; ')}.`);
  }

  if (card.exclusions.length > 0) {
    parts.push(`Exclusions: ${card.exclusions.join('; ')}.`);
  }

  if (card.avoid_tables.length > 0) {
    parts.push(`Avoid tables: ${card.avoid_tables.join('; ')}.`);
  }

  return parts.join(' ');
}
```

- [ ] **Step 4: Run the targeted test**

Run:

```bash
npx vitest run tests/teachings/summaryMap.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected: clean.

- [ ] **Step 6: Commit**

Run:

```bash
git add src/teachings/summaryMap.ts tests/teachings/summaryMap.test.ts
git commit -m "fix: include ReferenceCard constraints in summaries"
```

## Task 2: Tighten SQL Generator ReferenceCard Instructions

**Files:**
- Modify: `tests/agents/sqlGenerator.test.ts`
- Modify: `src/agents/sqlGenerator.ts`

- [ ] **Step 1: Write the failing test**

In `tests/agents/sqlGenerator.test.ts`, append this test inside the existing `describe('generateSql', () => { ... })` block:

```typescript
  it('treats retrieved ReferenceCards as binding operational constraints', async () => {
    mockGenerateContent.mockResolvedValue({
      text: JSON.stringify({
        sql: 'SELECT 1',
        explanation: 'test',
        tables_used: [],
        confidence: 'high',
        assumptions: [],
        reasoning_chain: 'test',
        headline: 'test',
      }),
    });

    await generateSql({
      question: 'test',
      tables: mockTables,
      threadContext: [],
      apiKey: 'test-api-key',
      fileSearchStoreId: 'test-store',
    });

    const callArgs = mockGenerateContent.mock.calls[0][0];
    const systemPrompt = callArgs.config.systemInstruction;
    expect(systemPrompt).toContain('Retrieved ReferenceCards are operational constraints');
    expect(systemPrompt).toContain('canonical table, canonical metric, grain, required filters, exclusions, and avoid-table guidance');
    expect(systemPrompt).toContain('Do not substitute a broader category for a narrower user term');
    expect(systemPrompt).toContain('prefer the mart column over reconstructing it from lower-grain staging or event sources');
  });
```

- [ ] **Step 2: Run the test and verify it fails**

Run:

```bash
npx vitest run tests/agents/sqlGenerator.test.ts
```

Expected: FAIL because the prompt does not yet contain the stronger ReferenceCard contract.

- [ ] **Step 3: Implement the prompt contract**

In `src/agents/sqlGenerator.ts`, replace the existing `KNOWLEDGE CONTEXT` block inside `if (opts.fileSearchStoreId) { ... }` with:

```typescript
    prompt += `\nKNOWLEDGE CONTEXT:
Relevant teachings and reference cards are automatically retrieved via Gemini File Search.
Follow sanctioned SQL patterns from teachings when they exist.
Retrieved ReferenceCards are operational constraints for matching business terms, metrics, and routing triggers.
When a ReferenceCard applies, treat its canonical table, canonical metric, grain, required filters, exclusions, and avoid-table guidance as binding unless the available schema cannot answer the question.
Do not substitute a broader category for a narrower user term; preserve the user's requested metric and dimension.
If a mart table exposes the requested metric, prefer the mart column over reconstructing it from lower-grain staging or event sources.
If you must violate a ReferenceCard constraint, lower confidence and explain the reason in the explanation and assumptions.\n`;
```

- [ ] **Step 4: Run the targeted test**

Run:

```bash
npx vitest run tests/agents/sqlGenerator.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected: clean.

- [ ] **Step 6: Commit**

Run:

```bash
git add src/agents/sqlGenerator.ts tests/agents/sqlGenerator.test.ts
git commit -m "fix: make ReferenceCard constraints binding in SQL prompt"
```

## Task 3: Tighten Supervisor ReferenceCard Review

**Files:**
- Modify: `tests/agents/supervisorAgent.test.ts`
- Modify: `src/agents/supervisorAgent.ts`

- [ ] **Step 1: Write the failing test**

In `tests/agents/supervisorAgent.test.ts`, append this test inside the existing `describe('reviewSql — Supervisor Agent', () => { ... })` block:

```typescript
  it('instructs the supervisor to fail ReferenceCard contradictions', async () => {
    mockGenerateContent.mockResolvedValue({
      text: JSON.stringify({
        verdict: 'PASS',
        confidence: 'high',
        issues: [],
        suggestions: [],
        teaching_compliance: 'compliant',
      }),
    });

    await reviewSql({
      ...baseInput,
      groundingCitations: [{
        sourceFile: 'reference_card:revenue-canonical-definition',
        chunkText: [
          '# ReferenceCard: revenue-canonical-definition',
          'Canonical table: analytics.fct_orders',
          'Grain: order',
          '## Avoid Tables',
          '- analytics.raw_orders',
        ].join('\n'),
        relevanceScore: 0.95,
      }],
    });

    const call = mockGenerateContent.mock.calls[0][0];
    const prompt = call.contents[0].parts[0].text as string;
    expect(prompt).toContain('ReferenceCard compliance checks');
    expect(prompt).toContain('canonical table and grain');
    expect(prompt).toContain('exclusions and avoid tables');
    expect(prompt).toContain('Preserve metric and dimension fidelity');
    expect(prompt).toContain('Contradicting retrieved ReferenceCard constraints is a FAIL');
  });
```

- [ ] **Step 2: Run the test and verify it fails**

Run:

```bash
npx vitest run tests/agents/supervisorAgent.test.ts
```

Expected: FAIL because the review checklist does not yet contain the ReferenceCard contradiction rule.

- [ ] **Step 3: Implement the supervisor checklist**

In `src/agents/supervisorAgent.ts`, update the `REVIEW CHECKLIST` section in `buildSupervisorPrompt` so it reads:

```typescript
REVIEW CHECKLIST:
1. Does the SQL correctly answer the question?
2. Are the right tables and columns used?
3. If teachings exist for this topic, does the SQL follow them?
4. ReferenceCard compliance checks when retrieved ReferenceCard context exists:
   - Are the canonical table and grain followed?
   - Are required filters present?
   - Are exclusions and avoid tables respected?
   - Are aliases and routing triggers interpreted faithfully?
   - If a mart-level metric is available, did the query avoid reconstructing it from lower-grain sources?
5. Preserve metric and dimension fidelity. Do not approve substituting a broader category for a narrower user term.
6. Contradicting retrieved ReferenceCard constraints is a FAIL unless the SQL cannot answer the question otherwise and the explanation clearly says why.
7. Are the joins correct?
8. Are there missing WHERE clauses or filters that should exist?
9. Is the explanation accurate and matches the SQL?
10. Are the stated assumptions reasonable and valid?
11. Is the query safe (no DML/DDL, no unbounded scans, no sensitive data exposure)?
12. If the query uses ML.* functions:
   - Is the function appropriate for the user's question?
   - Are parameters reasonable (e.g., forecast horizon isn't absurdly large)?
   - Is the referenced model likely to exist in the dataset context?
```

- [ ] **Step 4: Run the targeted test**

Run:

```bash
npx vitest run tests/agents/supervisorAgent.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected: clean.

- [ ] **Step 6: Commit**

Run:

```bash
git add src/agents/supervisorAgent.ts tests/agents/supervisorAgent.test.ts
git commit -m "fix: enforce ReferenceCard contradictions in supervisor prompt"
```

## Task 4: Apply Operator-local Live Card Repair

**Files:**
- Modify: `references/sessions-traffic.live.yml` (ignored)
- Read: `docs/plans/2026-06-11-referencecard-repair-rerun-operator.md` (ignored)

- [ ] **Step 1: Confirm the operator supplement exists**

Run:

```bash
test -f docs/plans/2026-06-11-referencecard-repair-rerun-operator.md
```

Expected: command exits 0. If it is missing, stop and recreate the ignored supplement before editing live cards.

- [ ] **Step 2: Apply only the card edits in the operator supplement**

Follow the patch in `docs/plans/2026-06-11-referencecard-repair-rerun-operator.md`.

Expected: `references/sessions-traffic.live.yml` remains ignored and includes the repaired metric coverage plus source-vs-channel and mart-vs-staging guidance.

- [ ] **Step 3: Validate the live knowledge**

Run:

```bash
npm run knowledge:validate
```

Expected: no validation errors.

- [ ] **Step 4: Confirm no ignored live content is staged**

Run:

```bash
git status --short
git status --ignored --short references benchmarks dbt docs/plans | head -40
```

Expected: tracked tree remains clean except for later governance changes; live cards, corpus, dbt artifacts, benchmark results, and operator supplement show only as ignored files.

Do not commit this task. It intentionally modifies ignored operator-local content.

## Task 5: Run Knowledge Sync And Acceptance Re-run

**Files:**
- Read: `.env` (ignored; do not print secrets)
- Write: `benchmarks/results/*` (ignored)
- Read: `benchmarks/corpus.live.json` (ignored)

- [ ] **Step 1: Confirm required env is visible to the command**

Run:

```bash
npx tsx --env-file=.env -e "for (const k of ['GEMINI_API_KEY','GCP_PROJECT_ID','FILE_SEARCH_STORE_ID']) { console.log(k + '=' + Boolean(process.env[k])); }"
```

Expected: all three lines end in `true`. Do not print actual values.

- [ ] **Step 2: Sync live knowledge to File Search**

Run:

```bash
npx tsx --env-file=.env scripts/sync-knowledge.ts
```

Expected: sync succeeds with active managed ReferenceCard documents and no failed or duplicate managed documents.

- [ ] **Step 3: Run the benchmark**

Run:

```bash
npx tsx --env-file=.env scripts/benchmark.ts
```

Expected: a new JSON file appears under `benchmarks/results/`. The run uses `benchmarks/corpus.live.json`.

- [ ] **Step 4: Judge the benchmark**

Run:

```bash
RESULT="$(ls -t benchmarks/results/*.json | head -1)"
npx tsx --env-file=.env scripts/benchmark-judge.ts "$RESULT"
```

Expected: judge results are written back into the same JSON file.

- [ ] **Step 5: Analyze the benchmark**

Run:

```bash
RESULT="$(ls -t benchmarks/results/*.json | head -1)"
npx tsx scripts/benchmark-analyze.ts "$RESULT"
```

Expected: analyzer writes `<run>-summary.md` and `<run>-referencecard-acceptance.md` next to the JSON.

- [ ] **Step 6: Inspect the acceptance report**

Run:

```bash
REPORT="$(ls -t benchmarks/results/*-referencecard-acceptance.md | head -1)"
sed -n '1,120p' "$REPORT"
```

Expected: the report clearly records either `ACCEPTED` or `NEEDS_REVISION`. If it records `NEEDS_REVISION`, stop broadening scope and diagnose only the listed failure classes.

## Task 6: Record The Re-run Decision

**Files:**
- Modify: `docs/trajectory-governance.md`

- [ ] **Step 1: Read the current decision section**

Run:

```bash
sed -n '1,90p' docs/trajectory-governance.md
```

Expected: the head section still names the 2026-06-11 repair branch as active.

- [ ] **Step 2: Update the head sections with the actual re-run decision**

Edit `docs/trajectory-governance.md` so:

- `Current State` names the new re-run date, verdict, and high-level failure/pass summary.
- `Current Decision` says whether domain expansion re-arms (`ACCEPTED`) or repair remains active (`NEEDS_REVISION`).
- `Tranche Horizon` reflects the new branch without reviving deferred work.
- The template boundary sentence still says raw benchmark artifacts and live implementation content are operator-local.

- [ ] **Step 3: Append an Evidence Log entry**

Append a dated Evidence Log entry with:

- verdict from the new `*-referencecard-acceptance.md`
- artifact filenames only, not store IDs or project IDs
- whether the four repaired cases passed
- calibration note if present
- next branch
- confirmation that live cards, corpus, dbt artifacts, and raw benchmark results remain ignored

- [ ] **Step 4: Validate markdown and diff**

Run:

```bash
git diff --check -- docs/trajectory-governance.md
git diff -- docs/trajectory-governance.md
```

Expected: no whitespace errors; diff updates the head sections and Evidence Log consistently.

- [ ] **Step 5: Commit**

Run:

```bash
git add docs/trajectory-governance.md
git commit -m "docs: record ReferenceCard repair re-run decision"
```

## Task 7: Final Verification

**Files:**
- Verify tracked work only

- [ ] **Step 1: Run focused tests**

Run:

```bash
npx vitest run tests/teachings/summaryMap.test.ts tests/agents/sqlGenerator.test.ts tests/agents/supervisorAgent.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected: clean.

- [ ] **Step 3: Run full tests if time and environment allow**

Run:

```bash
npm test
```

Expected: PASS. If skipped, record why in the final handoff.

- [ ] **Step 4: Confirm template boundary**

Run:

```bash
git status --short
git status --ignored --short references benchmarks dbt docs/plans | head -80
```

Expected: tracked tree is clean after commits. Ignored operator-local files may exist but must not be staged.

- [ ] **Step 5: Stop condition**

If the acceptance re-run is `ACCEPTED`, stop and ask before starting the second-domain selection. If it is `NEEDS_REVISION`, stop and keep the next tranche scoped to the new failing categories.
