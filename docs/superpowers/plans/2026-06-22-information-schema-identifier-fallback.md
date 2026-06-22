# INFORMATION_SCHEMA Identifier Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix issue #15 so Stage 1b INFORMATION_SCHEMA fallback resolves two-part, three-part, and hyphenated BigQuery table references correctly.

**Architecture:** Keep the fix narrow. Add a pipeline-local candidate parser for fallback references, right-align parsed identifiers before calling `getSchemaFallback`, and change the fallback cache key to include project ID while keeping prompt-facing table names unchanged.

**Tech Stack:** TypeScript, Vitest, NodeNext ESM, existing Annalytics pipeline mocks.

---

## File Structure

- Modify: `src/pipeline.ts`
  - Owns Stage 1b fallback extraction and lookup.
  - Add a small helper near the fallback block or immediately above `runPipeline`.
- Modify: `src/dbt/informationSchemaFallback.ts`
  - Change the Firestore cache key from `dataset.table` to `project.dataset.table`.
  - Preserve returned `TableContext.name` as `dataset.table`.
- Test: `tests/pipeline/informationSchemaFallback.integration.test.ts`
  - Add regression coverage for parsed lookup arguments.
- Test: `tests/dbt/informationSchemaFallback.test.ts`
  - Add regression coverage for project-scoped cache keys.

### Task 1: Add Pipeline Parser Regressions

**Files:**
- Modify: `tests/pipeline/informationSchemaFallback.integration.test.ts`

- [ ] **Step 1: Add table-specific input helper**

Add this helper after `makeInput`:

```typescript
const makeInputForQuestion = (question: string) => ({
  ...makeInput(),
  question,
});
```

- [ ] **Step 2: Confirm existing two-part coverage**

Keep the existing test named `includes fallback table when question references non-dbt table`. It already covers the two-part `raw_dataset.raw_events` case and asserts:

```typescript
    expect(mockGetSchemaFallback).toHaveBeenCalledWith(
      'test-project',
      'raw_dataset',
      'raw_events',
    );
```

- [ ] **Step 3: Add tests for 3-part and hyphenated refs**

Add these tests after `includes fallback table when question references non-dbt table`:

```typescript
  it('right-aligns three-part BigQuery refs for fallback lookup', async () => {
    mockGenerateContent
      .mockResolvedValueOnce(clarificationResponse({
        resolved_question: 'How many events are in other_project.raw_dataset.raw_events?',
      }))
      .mockResolvedValueOnce(sqlGenResponse())
      .mockResolvedValueOnce(supervisorResponse());

    mockGetSchemaFallback.mockResolvedValue(fallbackTable);

    mockCreateQueryJob
      .mockResolvedValueOnce(dryRunResult())
      .mockResolvedValueOnce(executionResult([{ event_count: 100 }]));

    vi.mocked(qualityLoop).mockImplementation(async () => ({
      sqlResult: {
        sql: VALID_SQL,
        explanation: 'Counts events',
        tablesUsed: ['raw_dataset.raw_events'],
        confidence: 'high' as const,
        assumptions: [],
        reasoningChain: 'count query',
        groundingCitations: [],
      },
      verdict: 'pass' as const,
      supervisorNotes: '',
      finalConfidence: 'high' as const,
      retryCount: 0,
      failureHistory: [],
      bytesProcessed: 5000,
    }));

    await runPipeline(makeInputForQuestion('How many events are in other_project.raw_dataset.raw_events?'));

    expect(mockGetSchemaFallback).toHaveBeenCalledWith(
      'other_project',
      'raw_dataset',
      'raw_events',
    );
  });

  it('does not treat explicit non-default project refs as covered by dbt metadata', async () => {
    mockGenerateContent
      .mockResolvedValueOnce(clarificationResponse({
        resolved_question: 'How many rows are in other_project.analytics.fct_orders?',
      }))
      .mockResolvedValueOnce(sqlGenResponse())
      .mockResolvedValueOnce(supervisorResponse());

    mockGetSchemaFallback.mockResolvedValue({
      ...fallbackTable,
      name: 'analytics.fct_orders',
      schema: 'analytics',
    });

    mockCreateQueryJob
      .mockResolvedValueOnce(dryRunResult())
      .mockResolvedValueOnce(executionResult([{ row_count: 100 }]));

    vi.mocked(qualityLoop).mockImplementation(async () => ({
      sqlResult: {
        sql: VALID_SQL,
        explanation: 'Counts rows',
        tablesUsed: ['analytics.fct_orders'],
        confidence: 'high' as const,
        assumptions: [],
        reasoningChain: 'count query',
        groundingCitations: [],
      },
      verdict: 'pass' as const,
      supervisorNotes: '',
      finalConfidence: 'high' as const,
      retryCount: 0,
      failureHistory: [],
      bytesProcessed: 5000,
    }));

    await runPipeline(makeInputForQuestion('How many rows are in other_project.analytics.fct_orders?'));

    expect(mockGetSchemaFallback).toHaveBeenCalledTimes(1);
    expect(mockGetSchemaFallback).toHaveBeenCalledWith(
      'other_project',
      'analytics',
      'fct_orders',
    );
  });

  it('supports hyphenated project IDs in three-part refs', async () => {
    mockGenerateContent
      .mockResolvedValueOnce(clarificationResponse({
        resolved_question: 'How many events are in gcp-project-123.raw_dataset.raw_events?',
      }))
      .mockResolvedValueOnce(sqlGenResponse())
      .mockResolvedValueOnce(supervisorResponse());

    mockGetSchemaFallback.mockResolvedValue(fallbackTable);

    mockCreateQueryJob
      .mockResolvedValueOnce(dryRunResult())
      .mockResolvedValueOnce(executionResult([{ event_count: 100 }]));

    vi.mocked(qualityLoop).mockImplementation(async () => ({
      sqlResult: {
        sql: VALID_SQL,
        explanation: 'Counts events',
        tablesUsed: ['raw_dataset.raw_events'],
        confidence: 'high' as const,
        assumptions: [],
        reasoningChain: 'count query',
        groundingCitations: [],
      },
      verdict: 'pass' as const,
      supervisorNotes: '',
      finalConfidence: 'high' as const,
      retryCount: 0,
      failureHistory: [],
      bytesProcessed: 5000,
    }));

    await runPipeline(makeInputForQuestion('How many events are in gcp-project-123.raw_dataset.raw_events?'));

    expect(mockGetSchemaFallback).toHaveBeenCalledWith(
      'gcp-project-123',
      'raw_dataset',
      'raw_events',
    );
  });
```

- [ ] **Step 4: Add guard tests for false positives, numeric segments, and four-part refs**

Add this test after `ignores numeric-segment refs like v1.0 in question text`:

```typescript
  it('does not fallback on prose false positives or partial four-part refs', async () => {
    mockGenerateContent
      .mockResolvedValueOnce(clarificationResponse({
        resolved_question:
          'Compare e.g and node.js notes with us.region.raw_dataset.raw_events, but use raw_dataset.raw_events for the count.',
      }))
      .mockResolvedValueOnce(sqlGenResponse())
      .mockResolvedValueOnce(supervisorResponse());

    mockGetSchemaFallback.mockResolvedValue(fallbackTable);

    mockCreateQueryJob
      .mockResolvedValueOnce(dryRunResult())
      .mockResolvedValueOnce(executionResult([{ event_count: 50 }]));

    vi.mocked(qualityLoop).mockImplementation(async () => ({
      sqlResult: {
        sql: VALID_SQL,
        explanation: 'Counts events',
        tablesUsed: ['raw_dataset.raw_events'],
        confidence: 'high' as const,
        assumptions: [],
        reasoningChain: 'count query',
        groundingCitations: [],
      },
      verdict: 'pass' as const,
      supervisorNotes: '',
      finalConfidence: 'high' as const,
      retryCount: 0,
      failureHistory: [],
      bytesProcessed: 5000,
    }));

    await runPipeline(makeInputForQuestion('How many events are in raw_dataset.raw_events?'));

    expect(mockGetSchemaFallback).toHaveBeenCalledTimes(1);
    expect(mockGetSchemaFallback).toHaveBeenCalledWith(
      'test-project',
      'raw_dataset',
      'raw_events',
    );
  });
```

- [ ] **Step 5: Run failing tests**

Run:

```bash
npm test -- tests/pipeline/informationSchemaFallback.integration.test.ts
```

Expected: the new three-part test fails because fallback is called with the wrong dataset/table, the hyphenated test fails because no valid full reference is extracted, and the four-part guard catches any partial `us.region.raw_dataset` match.

### Task 2: Implement Pipeline Reference Parsing

**Files:**
- Modify: `src/pipeline.ts`

- [ ] **Step 1: Add parser types and constants**

Add near the `PipelineInput` interface:

```typescript
interface FallbackTableRef {
  projectId: string;
  datasetId: string;
  tableId: string;
  displayName: string;
}

const BIGQUERY_IDENTIFIER_SEGMENT = '[A-Za-z_][A-Za-z0-9_-]*';
const TABLE_REF_PATTERN = `${BIGQUERY_IDENTIFIER_SEGMENT}\\.${BIGQUERY_IDENTIFIER_SEGMENT}(?:\\.${BIGQUERY_IDENTIFIER_SEGMENT})?`;
const TABLE_REF_RE = new RegExp(TABLE_REF_PATTERN, 'g');
const IDENTIFIER_EDGE_RE = /[A-Za-z0-9_-]/;
const IDENTIFIER_START_RE = /[A-Za-z_]/;
const FALSE_POSITIVE_TABLE_REFS = new Set(['e.g', 'i.e', 'vs.net', 'node.js']);
```

- [ ] **Step 2: Add extraction helper**

Add after `toPipelineConfig`:

```typescript
function isEmbeddedTableRef(source: string, start: number, end: number): boolean {
  const before = source[start - 1];
  const beforeBefore = source[start - 2];
  if (before && IDENTIFIER_EDGE_RE.test(before)) return true;
  if (before === '.' && beforeBefore && IDENTIFIER_EDGE_RE.test(beforeBefore)) {
    return true;
  }

  const after = source[end];
  const afterAfter = source[end + 1];
  if (after && IDENTIFIER_EDGE_RE.test(after)) return true;
  if (after === '.' && afterAfter && IDENTIFIER_START_RE.test(afterAfter)) {
    return true;
  }

  return false;
}

function extractFallbackTableRefs(
  question: string,
  defaultProjectId: string,
  knownTables: TableContext[],
): FallbackTableRef[] {
  const refs: string[] = [];
  for (const match of question.matchAll(TABLE_REF_RE)) {
    const start = match.index;
    if (start === undefined) continue;
    const end = start + match[0].length;
    if (!isEmbeddedTableRef(question, start, end)) {
      refs.push(match[0]);
    }
  }

  const seen = new Set<string>();
  const parsed: FallbackTableRef[] = [];

  for (const ref of refs) {
    const normalized = ref.toLowerCase();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    if (FALSE_POSITIVE_TABLE_REFS.has(normalized)) continue;

    const parts = ref.split('.');
    if (parts.length < 2 || parts.length > 3) continue;
    if (parts.some((seg) => /^\d+$/.test(seg))) continue;

    const tableId = parts[parts.length - 1];
    const datasetId = parts[parts.length - 2];
    const projectId = parts.length === 3 ? parts[0] : defaultProjectId;
    const displayName = `${datasetId}.${tableId}`;
    const canBeCoveredByKnownTables =
      parts.length === 2 || projectId.toLowerCase() === defaultProjectId.toLowerCase();

    if (
      canBeCoveredByKnownTables
      && knownTables.some((t) => t.name === ref || t.name === displayName || t.name.endsWith(`.${displayName}`))
    ) {
      continue;
    }

    parsed.push({ projectId, datasetId, tableId, displayName });
  }

  return parsed;
}
```

- [ ] **Step 3: Replace inline fallback parsing**

Replace the current Stage 1b extraction body with:

```typescript
        const unknown = extractFallbackTableRefs(resolvedQuestion, config.gcpProjectId!, tables);
        const fallbacks = await Promise.all(unknown.map(async (ref) => {
          const result = await getSchemaFallback(ref.projectId, ref.datasetId, ref.tableId);
          if (!result) return null;
          return { ...result, description: `${result.description} \u26a0\ufe0f minimal documentation \u2014 no dbt metadata`.trim() };
        }));
```

- [ ] **Step 4: Run pipeline tests**

Run:

```bash
npm test -- tests/pipeline/informationSchemaFallback.integration.test.ts
```

Expected: all pipeline fallback tests pass.

### Task 3: Project-Scope INFORMATION_SCHEMA Cache Keys

**Files:**
- Modify: `src/dbt/informationSchemaFallback.ts`
- Modify: `tests/dbt/informationSchemaFallback.test.ts`

- [ ] **Step 1: Update cache-key expectations first**

In `tests/dbt/informationSchemaFallback.test.ts`, change existing cache assertions from:

```typescript
expect(mockGetCachedSchema).toHaveBeenCalledWith('raw_dataset.raw_events');
expect(mockCacheSchema).toHaveBeenCalledWith('raw_dataset.raw_events', result);
```

to:

```typescript
expect(mockGetCachedSchema).toHaveBeenCalledWith('my-project.raw_dataset.raw_events');
expect(mockCacheSchema).toHaveBeenCalledWith('my-project.raw_dataset.raw_events', result);
```

Also add this assertion to the query/cache test:

```typescript
expect(result!.name).toBe('raw_dataset.raw_events');
```

- [ ] **Step 2: Run failing cache tests**

Run:

```bash
npm test -- tests/dbt/informationSchemaFallback.test.ts
```

Expected: cache-key assertions fail because implementation still uses `dataset.table`.

- [ ] **Step 3: Update implementation cache key**

In `src/dbt/informationSchemaFallback.ts`, replace:

```typescript
  const cacheKey = `${datasetId}.${tableId}`;
```

with:

```typescript
  const displayName = `${datasetId}.${tableId}`;
  const cacheKey = `${projectId}.${displayName}`;
```

Then replace returned table fields:

```typescript
      name: cacheKey,
```

with:

```typescript
      name: displayName,
```

- [ ] **Step 4: Run cache tests**

Run:

```bash
npm test -- tests/dbt/informationSchemaFallback.test.ts
```

Expected: all cache tests pass.

### Task 4: Full Verification

**Files:**
- Verify all modified files.

- [ ] **Step 1: Run targeted tests**

Run:

```bash
npm test -- tests/pipeline/informationSchemaFallback.integration.test.ts tests/dbt/informationSchemaFallback.test.ts
```

Expected: both files pass.

- [ ] **Step 2: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected: TypeScript passes with no errors.

- [ ] **Step 3: Run full test suite**

Run:

```bash
npm test
```

Expected: full Vitest suite passes.

- [ ] **Step 4: Review diff**

Run:

```bash
git diff -- src/pipeline.ts src/dbt/informationSchemaFallback.ts tests/pipeline/informationSchemaFallback.integration.test.ts tests/dbt/informationSchemaFallback.test.ts
```

Expected: diff is limited to issue #15 parsing, cache-key hardening, and tests.

- [ ] **Step 5: Commit**

Run:

```bash
git add src/pipeline.ts src/dbt/informationSchemaFallback.ts tests/pipeline/informationSchemaFallback.integration.test.ts tests/dbt/informationSchemaFallback.test.ts
git commit -m "fix: resolve qualified information schema refs"
```

Expected: one focused implementation commit on `codex/fix-information-schema-identifiers`, following the already-committed design and plan.
