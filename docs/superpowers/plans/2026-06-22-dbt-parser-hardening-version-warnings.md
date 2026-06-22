# dbt Parser Hardening and Version Warnings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix GitHub issues #12 and #16 by hardening `parseDbtArtifacts` against partial dbt artifacts and surfacing schema-version warnings without changing valid fixture output.

**Architecture:** Keep `parseDbtArtifacts` returning `TableContext[]` and add runtime guards plus an optional parser warning callback. Keep log emission in `src/dbt/startupArtifacts.ts`, not in the parser. Bundle both parser changes into one PR because `src/dbt/parser.ts` is benchmark-gated and requires one accepted-slice rerun before merge.

**Tech Stack:** TypeScript, NodeNext ESM, Vitest, existing startup artifact loader, operator-local benchmark scripts.

---

## File Structure

- Modify: `src/dbt/parser.ts`
  - Owns runtime dbt artifact boundary guards.
  - Exports `DbtArtifactVersionWarning`.
  - Extends `ParseDbtOptions` with `onWarnings`.
- Modify: `src/dbt/startupArtifacts.ts`
  - Passes `onWarnings` to the parser.
  - Logs version warnings through the injected startup logger.
- Modify: `tests/dbt/parser.test.ts`
  - Adds red/green coverage for #12 parser hardening and #16 version warning behavior.
- Modify: `tests/dbt/startupArtifacts.test.ts`
  - Adds red/green coverage for startup logging of parser warnings.
- Modify after accepted benchmark only: `docs/trajectory-governance.md`
  - Records the accepted parser-change benchmark evidence with artifact filenames only.

Do not modify or commit `dbt/manifest.json`, `dbt/catalog.json`, `benchmarks/results/*`, `benchmarks/corpus.live.json`, `references/*.live.yml`, `.env`, or any project/store identifiers.

## Task 1: Add Red Parser Tests

**Files:**
- Modify: `tests/dbt/parser.test.ts`

- [ ] **Step 1: Update the test import**

In `tests/dbt/parser.test.ts`, replace the first import:

```ts
import { describe, it, expect } from 'vitest';
```

with:

```ts
import { describe, it, expect, vi } from 'vitest';
```

- [ ] **Step 2: Add test helpers after fixture constants**

In `tests/dbt/parser.test.ts`, add this helper after the existing `manifest` and `catalog` constants:

```ts
function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
```

- [ ] **Step 3: Append parser boundary and warning tests**

Append this block to the end of `tests/dbt/parser.test.ts`:

```ts
describe('artifact boundary guards', () => {
  const clearParserError = 'dbt manifest has no nodes key - wrong or malformed manifest.json';
  const manifestWithOneModel = {
    metadata: { dbt_schema_version: 'https://schemas.getdbt.com/dbt/manifest/v11.json' },
    nodes: {
      'model.my_project.partial_model': {
        resource_type: 'model',
        name: 'partial_model',
        schema: 'analytics',
        description: 'Partial model',
        columns: undefined as Record<string, { name: string; description?: string }> | undefined,
        config: { materialized: 'table' },
        depends_on: { nodes: [] },
        tags: [],
      },
    },
  };
  const catalogWithOneColumn = {
    metadata: { dbt_schema_version: 'https://schemas.getdbt.com/dbt/catalog/v1.json' },
    nodes: {
      'model.my_project.partial_model': {
        columns: {
          ID: { type: 'STRING', index: 1 },
        },
      },
    },
  };

  it('throws a clear parser error when manifest nodes are missing', () => {
    expect(() => parseDbtArtifacts({} as Parameters<typeof parseDbtArtifacts>[0], catalog)).toThrow(
      clearParserError,
    );
  });

  it('throws a clear parser error when manifest nodes are null', () => {
    expect(() =>
      parseDbtArtifacts({ nodes: null } as unknown as Parameters<typeof parseDbtArtifacts>[0], catalog),
    ).toThrow(clearParserError);
  });

  it('degrades gracefully when catalog nodes are missing', () => {
    const manifestWithColumns = cloneJson(manifestWithOneModel);
    manifestWithColumns.nodes['model.my_project.partial_model'].columns = {
      id: { name: 'id', description: 'Primary key' },
    };

    const result = parseDbtArtifacts(
      manifestWithColumns as unknown as Parameters<typeof parseDbtArtifacts>[0],
      {} as unknown as Parameters<typeof parseDbtArtifacts>[1],
    );

    expect(result).toHaveLength(1);
    expect(result[0].columns).toEqual([
      {
        name: 'id',
        description: 'Primary key',
        dataType: 'UNKNOWN',
        meta: {},
      },
    ]);
    expect(result[0].sampleDDL).toContain('id UNKNOWN -- Primary key');
  });

  it('emits catalog-only columns when manifest model columns are missing', () => {
    const result = parseDbtArtifacts(
      manifestWithOneModel as unknown as Parameters<typeof parseDbtArtifacts>[0],
      catalogWithOneColumn as unknown as Parameters<typeof parseDbtArtifacts>[1],
    );

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('analytics.partial_model');
    expect(result[0].columns).toEqual([
      {
        name: 'id',
        description: '',
        dataType: 'STRING',
        meta: {},
      },
    ]);
    expect(result[0].sampleDDL).toContain('id STRING');
  });

  it('coerces empty catalog-only column types to UNKNOWN', () => {
    const catalogWithEmptyType = cloneJson(catalogWithOneColumn);
    catalogWithEmptyType.nodes['model.my_project.partial_model'].columns.ID.type = '';

    const result = parseDbtArtifacts(
      manifestWithOneModel as unknown as Parameters<typeof parseDbtArtifacts>[0],
      catalogWithEmptyType as unknown as Parameters<typeof parseDbtArtifacts>[1],
    );

    expect(result[0].columns).toEqual([
      {
        name: 'id',
        description: '',
        dataType: 'UNKNOWN',
        meta: {},
      },
    ]);
    expect(result[0].sampleDDL).toContain('id UNKNOWN');
  });
});

describe('dbt artifact schema-version warnings', () => {
  it('does not warn for current known fixture versions', () => {
    const onWarnings = vi.fn();
    const expected = parseDbtArtifacts(manifest, catalog);

    const result = parseDbtArtifacts(manifest, catalog, { onWarnings });

    expect(result).toEqual(expected);
    expect(onWarnings).not.toHaveBeenCalled();
  });

  it('warns for missing schema-version metadata and still parses', () => {
    const manifestWithoutMetadata = cloneJson(manifest);
    const catalogWithoutMetadata = cloneJson(catalog);
    delete manifestWithoutMetadata.metadata;
    delete catalogWithoutMetadata.metadata;
    const onWarnings = vi.fn();
    const expected = parseDbtArtifacts(manifestWithoutMetadata, catalogWithoutMetadata);

    const result = parseDbtArtifacts(manifestWithoutMetadata, catalogWithoutMetadata, { onWarnings });

    expect(result).toEqual(expected);
    expect(onWarnings).toHaveBeenCalledTimes(1);
    expect(onWarnings).toHaveBeenCalledWith([
      {
        artifact: 'manifest',
        schemaVersion: null,
        reason: 'missing',
        supportedRange: 'v10-v12',
      },
      {
        artifact: 'catalog',
        schemaVersion: null,
        reason: 'missing',
        supportedRange: 'v1',
      },
    ]);
  });

  it('warns for unparseable schema-version metadata and still parses', () => {
    const manifestWithBadVersion = cloneJson(manifest);
    manifestWithBadVersion.metadata.dbt_schema_version = 'manifest-vNext';
    const onWarnings = vi.fn();
    const expected = parseDbtArtifacts(manifestWithBadVersion, catalog);

    const result = parseDbtArtifacts(manifestWithBadVersion, catalog, { onWarnings });

    expect(result).toEqual(expected);
    expect(onWarnings).toHaveBeenCalledTimes(1);
    expect(onWarnings).toHaveBeenCalledWith([
      {
        artifact: 'manifest',
        schemaVersion: 'manifest-vNext',
        reason: 'unparseable',
        supportedRange: 'v10-v12',
      },
    ]);
  });

  it('warns for future unsupported manifest schema versions and still parses', () => {
    const manifestWithFutureVersion = cloneJson(manifest);
    manifestWithFutureVersion.metadata.dbt_schema_version = 'https://schemas.getdbt.com/dbt/manifest/v20.json';
    const onWarnings = vi.fn();
    const expected = parseDbtArtifacts(manifestWithFutureVersion, catalog);

    const result = parseDbtArtifacts(manifestWithFutureVersion, catalog, { onWarnings });

    expect(result).toEqual(expected);
    expect(onWarnings).toHaveBeenCalledTimes(1);
    expect(onWarnings).toHaveBeenCalledWith([
      {
        artifact: 'manifest',
        schemaVersion: 'https://schemas.getdbt.com/dbt/manifest/v20.json',
        reason: 'unsupported',
        supportedRange: 'v10-v12',
      },
    ]);
  });
});
```

- [ ] **Step 4: Run the red parser tests**

Run:

```bash
npm test -- tests/dbt/parser.test.ts
```

Expected: fail. The failure should include the raw `TypeError`/missing guard behavior and empty warning callback calls, proving the tests exercise #12 and #16 before implementation.

## Task 2: Implement Parser Guards and Version Warnings

**Files:**
- Modify: `src/dbt/parser.ts`
- Test: `tests/dbt/parser.test.ts`

- [ ] **Step 1: Replace parser implementation**

Replace the full contents of `src/dbt/parser.ts` with:

```ts
import type { TableContext, ColumnContext } from './types.js';

type ArtifactKind = 'manifest' | 'catalog';

export interface DbtArtifactVersionWarning {
  artifact: ArtifactKind;
  schemaVersion: string | null;
  reason: 'missing' | 'unparseable' | 'unsupported';
  supportedRange: string;
}

interface ManifestColumn {
  name: string;
  description?: string;
  meta?: Record<string, unknown>;
}

interface ManifestNode {
  resource_type?: unknown;
  name?: unknown;
  schema?: unknown;
  description?: unknown;
  columns?: unknown;
  config?: unknown;
  depends_on?: unknown;
  tags?: unknown;
}

interface CatalogColumn {
  type?: string;
  index: number;
}

interface CatalogNode {
  columns?: unknown;
}

interface DbtArtifact {
  metadata?: { dbt_schema_version?: unknown };
  nodes?: unknown;
}

interface VersionSupport {
  min: number;
  max: number;
  supportedRange: string;
}

// Tables whose full physical column set exceeds this stay documented-columns-only
// (plus an omission marker in the DDL). Keeps wide raw-event staging tables from
// flooding the prompt while marts remain fully visible.
export const DEFAULT_MAX_COLUMNS_PER_TABLE = 64;

const MANIFEST_NODES_ERROR = 'dbt manifest has no nodes key - wrong or malformed manifest.json';

const VERSION_SUPPORT: Record<ArtifactKind, VersionSupport> = {
  manifest: { min: 10, max: 12, supportedRange: 'v10-v12' },
  catalog: { min: 1, max: 1, supportedRange: 'v1' },
};

export interface ParseDbtOptions {
  maxColumnsPerTable?: number;
  onWarnings?: (warnings: DbtArtifactVersionWarning[]) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, message: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(message);
  }
  return value;
}

function optionalRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function stringValue(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function versionWarningFor(
  artifact: ArtifactKind,
  schemaVersion: unknown,
): DbtArtifactVersionWarning | null {
  const support = VERSION_SUPPORT[artifact];

  if (typeof schemaVersion !== 'string' || schemaVersion.trim() === '') {
    return {
      artifact,
      schemaVersion: null,
      reason: 'missing',
      supportedRange: support.supportedRange,
    };
  }

  const match = schemaVersion.match(new RegExp(`/dbt/${artifact}/v(\\d+)\\.json$`));
  if (!match) {
    return {
      artifact,
      schemaVersion,
      reason: 'unparseable',
      supportedRange: support.supportedRange,
    };
  }

  const major = Number(match[1]);
  if (!Number.isInteger(major) || major < support.min || major > support.max) {
    return {
      artifact,
      schemaVersion,
      reason: 'unsupported',
      supportedRange: support.supportedRange,
    };
  }

  return null;
}

function collectVersionWarnings(
  manifest: DbtArtifact | null | undefined,
  catalog: DbtArtifact | null | undefined,
): DbtArtifactVersionWarning[] {
  return [
    versionWarningFor('manifest', manifest?.metadata?.dbt_schema_version),
    versionWarningFor('catalog', catalog?.metadata?.dbt_schema_version),
  ].filter((warning): warning is DbtArtifactVersionWarning => warning !== null);
}

function isManifestColumn(value: unknown): value is ManifestColumn {
  return isRecord(value) && typeof value.name === 'string';
}

function catalogColumnsFor(catalogNode: CatalogNode | undefined): Record<string, CatalogColumn> {
  return Object.fromEntries(
    Object.entries(optionalRecord(catalogNode?.columns))
      .filter(([, column]) => isRecord(column))
      .map(([name, column]) => [
        name.toLowerCase(),
        {
          type: stringValue((column as Record<string, unknown>).type),
          index:
            typeof (column as Record<string, unknown>).index === 'number'
              ? ((column as Record<string, unknown>).index as number)
              : Number.MAX_SAFE_INTEGER,
        },
      ]),
  );
}

function manifestColumnsFor(node: ManifestNode, catalogColumns: Record<string, CatalogColumn>): ColumnContext[] {
  return Object.values(optionalRecord(node.columns))
    .filter(isManifestColumn)
    .map((col) => ({
      name: col.name,
      description: stringValue(col.description),
      dataType: catalogColumns[col.name.toLowerCase()]?.type || 'UNKNOWN',
      meta: isRecord(col.meta) ? col.meta : {},
    }));
}

function materializationFor(node: ManifestNode): string {
  const config = optionalRecord(node.config);
  return stringValue(config.materialized, 'view');
}

function dependsOnFor(node: ManifestNode): string[] {
  const dependsOn = optionalRecord(node.depends_on);
  return stringArray(dependsOn.nodes);
}

function tagsFor(node: ManifestNode): string[] {
  return stringArray(node.tags);
}

export function parseDbtArtifacts(
  manifest: DbtArtifact | null | undefined,
  catalog: DbtArtifact | null | undefined,
  options: ParseDbtOptions = {},
): TableContext[] {
  const maxColumnsPerTable = options.maxColumnsPerTable ?? DEFAULT_MAX_COLUMNS_PER_TABLE;
  const manifestNodes = requireRecord(manifest?.nodes, MANIFEST_NODES_ERROR);
  const catalogNodes = optionalRecord(catalog?.nodes);
  const warnings = collectVersionWarnings(manifest, catalog);
  if (warnings.length > 0) {
    options.onWarnings?.(warnings);
  }

  const tables: TableContext[] = [];

  for (const [nodeId, rawNode] of Object.entries(manifestNodes)) {
    if (!isRecord(rawNode) || rawNode.resource_type !== 'model') continue;

    const node = rawNode as ManifestNode;
    const catalogNode = catalogNodes[nodeId] as CatalogNode | undefined;

    // Normalize catalog column keys to lowercase - BigQuery's catalog.json
    // reports column names in UPPERCASE while manifest.json uses lowercase.
    const catalogColumns = catalogColumnsFor(catalogNode);

    const documented = manifestColumnsFor(node, catalogColumns);

    // The manifest only carries columns documented in dbt YAML, and package
    // models cannot be doc-patched from the parent project - so the catalog
    // (the actual warehouse schema) is the column universe. Undocumented
    // columns are appended with empty descriptions so the generator can see
    // real columns the YAML never mentioned.
    const documentedNames = new Set(documented.map((c) => c.name.toLowerCase()));
    const undocumented: ColumnContext[] = Object.entries(catalogColumns)
      .filter(([name]) => !documentedNames.has(name))
      .sort(([, a], [, b]) => a.index - b.index)
      .map(([name, col]) => ({
        name,
        description: '',
        dataType: col.type || 'UNKNOWN',
        meta: {},
      }));

    const withinCap = documented.length + undocumented.length <= maxColumnsPerTable;
    const columns = withinCap ? [...documented, ...undocumented] : documented;
    const omittedColumnCount = withinCap ? 0 : undocumented.length;
    const schema = stringValue(node.schema);
    const name = stringValue(node.name, nodeId);

    const table: TableContext = {
      name: `${schema}.${name}`,
      schema,
      description: stringValue(node.description),
      materialization: materializationFor(node),
      columns,
      sampleDDL: generateDDL(schema, name, columns, omittedColumnCount),
      dependsOn: dependsOnFor(node),
      tags: tagsFor(node),
    };

    tables.push(table);
  }

  return tables;
}

export function generateDDL(
  schema: string,
  name: string,
  columns: ColumnContext[],
  omittedColumnCount = 0,
): string {
  const colDefs = columns
    .map((c) => {
      const desc = c.description.replace(/[\r\n]+/g, ' ');
      const comment = desc ? ` -- ${desc}` : '';
      return `  ${c.name} ${c.dataType}${comment}`;
    })
    .join(',\n');
  const omissionNote =
    omittedColumnCount > 0
      ? `\n  -- NOTE: ${omittedColumnCount} additional undocumented columns exist in this table but are omitted here; do not reference columns not listed above`
      : '';
  return `CREATE TABLE \`${schema}.${name}\` (\n${colDefs}${omissionNote}\n);`;
}
```

- [ ] **Step 2: Run the focused parser tests**

Run:

```bash
npm test -- tests/dbt/parser.test.ts
```

Expected: pass.

- [ ] **Step 3: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected: pass. If TypeScript errors point at parser call sites, fix only the type signatures/casts needed to preserve the existing `TableContext[]` return contract.

- [ ] **Step 4: Commit the parser slice**

Run:

```bash
git add src/dbt/parser.ts tests/dbt/parser.test.ts
git commit -m "fix: harden dbt parser artifact boundaries"
```

Expected: commit succeeds and `git status --short` is clean.

## Task 3: Add Red Startup Warning Tests

**Files:**
- Modify: `tests/dbt/startupArtifacts.test.ts`

- [ ] **Step 1: Add a reusable table fixture**

In `tests/dbt/startupArtifacts.test.ts`, add this helper after `makeLogger()`:

```ts
function makeTable(overrides: Partial<TableContext> = {}): TableContext {
  return {
    name: 'analytics.test_model',
    schema: 'analytics',
    description: '',
    materialization: 'table',
    columns: [],
    sampleDDL: 'CREATE TABLE `analytics.test_model` (\n\n);',
    dependsOn: [],
    tags: [],
    ...overrides,
  };
}
```

- [ ] **Step 2: Append startup warning tests**

Append these tests inside the existing `describe('loadDbtArtifactsForStartup', () => { ... })` block, after the current zero-model test:

```ts
  it('logs parser schema-version warnings without suppressing successful info', () => {
    const logger = makeLogger();
    const warning = {
      artifact: 'manifest',
      schemaVersion: 'https://schemas.getdbt.com/dbt/manifest/v20.json',
      reason: 'unsupported',
      supportedRange: 'v10-v12',
    } as const;
    const table = makeTable();
    const readFile = vi.fn(() => '{"nodes":{}}');
    const parseArtifacts = vi.fn(
      (
        _manifest: Parameters<typeof parseDbtArtifacts>[0],
        _catalog: Parameters<typeof parseDbtArtifacts>[1],
        options?: Parameters<typeof parseDbtArtifacts>[2],
      ): TableContext[] => {
        options?.onWarnings?.([warning]);
        return [table];
      },
    );

    const result = loadDbtArtifactsForStartup({
      manifestPath,
      catalogPath,
      logger,
      readFile,
      parseArtifacts,
    });

    expect(result).toEqual([table]);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      {
        manifestPath,
        catalogPath,
        warnings: [warning],
      },
      'dbt artifact schema version warning',
    );
    expect(logger.info).toHaveBeenCalledWith({ tableCount: 1 }, 'Loaded dbt metadata');
    expect(logger.fatal).not.toHaveBeenCalled();
  });

  it('logs parser schema-version warnings and zero-model warnings independently', () => {
    const logger = makeLogger();
    const warning = {
      artifact: 'catalog',
      schemaVersion: null,
      reason: 'missing',
      supportedRange: 'v1',
    } as const;
    const readFile = vi.fn(() => '{"nodes":{}}');
    const parseArtifacts = vi.fn(
      (
        _manifest: Parameters<typeof parseDbtArtifacts>[0],
        _catalog: Parameters<typeof parseDbtArtifacts>[1],
        options?: Parameters<typeof parseDbtArtifacts>[2],
      ): TableContext[] => {
        options?.onWarnings?.([warning]);
        return [];
      },
    );

    const result = loadDbtArtifactsForStartup({
      manifestPath,
      catalogPath,
      logger,
      readFile,
      parseArtifacts,
    });

    expect(result).toEqual([]);
    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenNthCalledWith(
      1,
      {
        manifestPath,
        catalogPath,
        warnings: [warning],
      },
      'dbt artifact schema version warning',
    );
    expect(logger.warn).toHaveBeenNthCalledWith(
      2,
      {
        tableCount: 0,
        manifestPath,
        catalogPath,
      },
      'Loaded dbt metadata with ZERO models',
    );
    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.fatal).not.toHaveBeenCalled();
  });
```

- [ ] **Step 3: Run the red startup tests**

Run:

```bash
npm test -- tests/dbt/startupArtifacts.test.ts
```

Expected: fail because `loadDbtArtifactsForStartup` does not yet pass `onWarnings` into `parseArtifacts`.

## Task 4: Wire Parser Warnings Into Startup Logging

**Files:**
- Modify: `src/dbt/startupArtifacts.ts`
- Test: `tests/dbt/startupArtifacts.test.ts`

- [ ] **Step 1: Update the parser call**

In `src/dbt/startupArtifacts.ts`, replace:

```ts
    const tables = parseArtifacts(manifest, catalog);
```

with:

```ts
    const tables = parseArtifacts(manifest, catalog, {
      onWarnings: (warnings) => {
        logger.warn(
          { manifestPath, catalogPath, warnings },
          'dbt artifact schema version warning',
        );
      },
    });
```

- [ ] **Step 2: Run focused startup tests**

Run:

```bash
npm test -- tests/dbt/startupArtifacts.test.ts
```

Expected: pass.

- [ ] **Step 3: Run focused dbt tests together**

Run:

```bash
npm test -- tests/dbt/parser.test.ts tests/dbt/startupArtifacts.test.ts
```

Expected: pass.

- [ ] **Step 4: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected: pass.

- [ ] **Step 5: Commit the startup warning slice**

Run:

```bash
git add src/dbt/startupArtifacts.ts tests/dbt/startupArtifacts.test.ts
git commit -m "fix: log dbt artifact version warnings at startup"
```

Expected: commit succeeds and `git status --short` is clean.

## Task 5: Full Local Verification Before Benchmark

**Files:**
- Verify all modified files.

- [ ] **Step 1: Confirm parser-gated file list**

Run:

```bash
git diff --name-only main...HEAD | sort
```

Expected output includes only:

```txt
docs/superpowers/plans/2026-06-22-dbt-parser-hardening-version-warnings.md
docs/superpowers/specs/2026-06-22-dbt-parser-hardening-version-warnings-design.md
src/dbt/parser.ts
src/dbt/startupArtifacts.ts
tests/dbt/parser.test.ts
tests/dbt/startupArtifacts.test.ts
```

If unrelated files appear, stop and inspect before continuing.

- [ ] **Step 2: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected: pass.

- [ ] **Step 3: Run focused tests**

Run:

```bash
npm test -- tests/dbt/parser.test.ts tests/dbt/startupArtifacts.test.ts
```

Expected: pass.

- [ ] **Step 4: Run full test suite**

Run:

```bash
npm test
```

Expected: all Vitest files pass.

- [ ] **Step 5: Check whitespace**

Run:

```bash
git diff --check main...HEAD
```

Expected: no output and exit code 0.

## Task 6: Run Accepted Benchmark Slice and Record Governance

**Files:**
- Read ignored local files: `.env`, `benchmarks/corpus.live.json`, `dbt/manifest.json`, `dbt/catalog.json`, live ReferenceCards.
- Write ignored local files: `benchmarks/results/*`.
- Modify after accepted result: `docs/trajectory-governance.md`

- [ ] **Step 1: Confirm ignored live inputs are available**

Run:

```bash
git check-ignore -v benchmarks/corpus.live.json dbt/manifest.json dbt/catalog.json
test -f benchmarks/corpus.live.json
test -f dbt/manifest.json
test -f dbt/catalog.json
test -f .env
```

Expected: `git check-ignore` reports matching ignore rules, and all `test -f` commands exit 0. If any file is missing, stop before benchmark and report the missing operator-local prerequisite.

- [ ] **Step 2: Run the accepted benchmark slice**

Run:

```bash
npx tsx --env-file=.env scripts/benchmark.ts
```

Expected: a new JSON result appears under `benchmarks/results/`. Do not commit it.

- [ ] **Step 3: Judge the newest benchmark result**

Run:

```bash
RESULT="$(ls -t benchmarks/results/*.json | head -1)"
npx tsx --env-file=.env scripts/benchmark-judge.ts "$RESULT"
```

Expected: judge enrichment succeeds for the newest result.

- [ ] **Step 4: Analyze the newest benchmark result**

Run:

```bash
RESULT="$(ls -t benchmarks/results/*.json | head -1)"
npx tsx scripts/benchmark-analyze.ts "$RESULT"
REPORT="$(ls -t benchmarks/results/*-referencecard-acceptance.md | head -1)"
grep -n "Decision" "$REPORT"
```

Expected: analyzer writes summary and ReferenceCard acceptance reports, and the report decision is `ACCEPTED`. If the decision is `NEEDS_REVISION`, stop and do not update governance for acceptance.

- [ ] **Step 5: Capture evidence filenames and commit SHA**

Run:

```bash
git rev-parse --short HEAD
basename "$(ls -t benchmarks/results/*.json | head -1)"
basename "$(ls -t benchmarks/results/*-summary.md | head -1)"
basename "$(ls -t benchmarks/results/*-referencecard-acceptance.md | head -1)"
git status --ignored --short benchmarks dbt references | head -80
```

Expected: outputs identify the commit SHA and ignored artifact filenames only. The status output must show live cards, corpus, dbt artifacts, and raw benchmark outputs as ignored, not staged.

- [ ] **Step 6: Update governance Evidence Log**

In `docs/trajectory-governance.md`, append a dated Evidence Log entry for the parser hardening and schema-version warning change. The entry must include:

- decision `ACCEPTED`;
- issue scope `#12` and `#16`;
- commit SHA printed in Step 5;
- benchmark JSON, summary, and ReferenceCard acceptance report filenames printed in Step 5;
- confirmation that live cards, live corpus, dbt artifacts, raw results, project/store identifiers, and exact client content remain ignored and uncommitted;
- statement that no new product tranche is promoted.

Do not paste raw benchmark rows, project IDs, File Search store IDs, live ReferenceCard content, live corpus questions, or dbt schema details.

- [ ] **Step 7: Commit governance evidence**

Run:

```bash
git add docs/trajectory-governance.md
git commit -m "docs: record dbt parser hardening acceptance"
```

Expected: commit succeeds and `git status --short` is clean except ignored benchmark artifacts.

## Task 7: Final Review and PR Preparation

**Files:**
- Verify all modified files.

- [ ] **Step 1: Run final verification**

Run:

```bash
npm run typecheck
npm test -- tests/dbt/parser.test.ts tests/dbt/startupArtifacts.test.ts
npm test
git diff --check main...HEAD
```

Expected: typecheck passes, focused tests pass, full suite passes, and diff check exits 0.

- [ ] **Step 2: Review final file list**

Run:

```bash
git diff --name-only main...HEAD | sort
```

Expected output includes only:

```txt
docs/superpowers/plans/2026-06-22-dbt-parser-hardening-version-warnings.md
docs/superpowers/specs/2026-06-22-dbt-parser-hardening-version-warnings-design.md
docs/trajectory-governance.md
src/dbt/parser.ts
src/dbt/startupArtifacts.ts
tests/dbt/parser.test.ts
tests/dbt/startupArtifacts.test.ts
```

- [ ] **Step 3: Prepare PR body**

Use this PR body:

```markdown
## What changed

- Hardened `parseDbtArtifacts` against partial dbt artifacts: missing catalog nodes, missing model columns, and blank catalog-only column types.
- Added clear parser failure for missing or malformed `manifest.nodes`.
- Added parser-owned dbt artifact schema-version warnings for missing, unparseable, and unsupported versions.
- Surfaced parser schema-version warnings through startup logging without changing the parser return type.
- Recorded the accepted benchmark-slice evidence required for the benchmark-gated parser change.

## Why

Issues #12 and #16 both touch `src/dbt/parser.ts`, the accepted ReferenceCard repair path. Bundling them keeps the parser change narrow and pays for one accepted-slice rerun instead of two.

## Validation

- `npm run typecheck`
- `npm test -- tests/dbt/parser.test.ts tests/dbt/startupArtifacts.test.ts`
- `npm test`
- Operator-local accepted benchmark slice rerun: `ACCEPTED` (artifact filenames recorded in `docs/trajectory-governance.md`)

Closes #12.
Closes #16.
```

Expected: the PR body makes the benchmark gate explicit and closes both issues.
