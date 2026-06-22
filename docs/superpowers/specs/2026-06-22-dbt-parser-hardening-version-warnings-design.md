# dbt Parser Hardening and Version Warning Design

**Date:** 2026-06-22
**Status:** Approved for implementation planning
**Scope:** GitHub issues #12 and #16 only

## Summary

Bundle the remaining dbt parser issues into one narrow parser PR:

- #12: harden `parseDbtArtifacts` against missing or variant dbt artifact fields.
- #16: warn when dbt artifact schema versions are missing, unparseable, or outside
  the known-good range.

Both issues touch `src/dbt/parser.ts`, which is benchmark-gated by the accepted
ReferenceCard slice. They should land together so one operator-local acceptance
slice can cover both changes.

## Context

`parseDbtArtifacts` currently assumes parsed JSON already matches the TypeScript
shape:

```ts
manifest: { nodes: Record<string, ManifestNode> }
catalog: { nodes: Record<string, CatalogNode> }
```

At runtime, those types are erased. Several partial-artifact states can either
crash with opaque `TypeError`s or silently feed weaker schema text into SQL
generation:

- missing or wrong-shaped `manifest.nodes` crashes during `Object.entries`;
- missing `catalog.nodes` crashes before the existing `catalogNode?.columns`
  guard can help;
- missing model `columns` crashes during `Object.values`;
- catalog-only columns with an empty string type produce blank DDL types instead
  of `UNKNOWN`;
- dbt `metadata.dbt_schema_version` is ignored, so future or variant schemas can
  degrade silently.

Startup now has a clean fatal wrapper in `src/dbt/startupArtifacts.ts`, so parser
fail-fast errors can become actionable startup diagnostics. The parser still
needs its own runtime boundary guards because it is also called by benchmarks,
node sweeps, teaching validation, and integration tests.

## Goals

- Replace raw parser crashes with clear, intentional parser errors only when the
  manifest cannot provide a node map.
- Tolerate partial catalogs and missing model `columns` without throwing.
- Keep valid fixture output byte-identical: table count, table names, column
  order, column union, and `sampleDDL`.
- Emit schema-version warnings for missing, unparseable, or out-of-range
  artifact versions without changing parse output.
- Preserve the existing public return type of `parseDbtArtifacts` as
  `TableContext[]`.
- Surface version warnings in startup logs through the existing startup loader.
- Bundle #12 and #16 into one benchmark-gated parser change.

## Non-Goals

- No parser rewrite, validation library, adapter framework, or multi-version
  schema support.
- No support for arbitrary third-party dbt artifact layouts.
- No behavior change to SQL generation, validation, response formatting, or
  benchmark acceptance rules.
- No committed client-specific dbt artifacts, benchmark raw results, project IDs,
  File Search store IDs, live cards, or live corpus files.
- No governance promotion of a new product tranche.

## Recommended Approach

Keep `parseDbtArtifacts` as the single parser entry point and extend its options
with a warning callback:

```ts
export interface DbtArtifactVersionWarning {
  artifact: 'manifest' | 'catalog';
  schemaVersion: string | null;
  reason: 'missing' | 'unparseable' | 'unsupported';
  supportedRange: string;
}

export interface ParseDbtOptions {
  maxColumnsPerTable?: number;
  onWarnings?: (warnings: DbtArtifactVersionWarning[]) => void;
}
```

The callback is optional. Existing call sites continue to receive `TableContext[]`
without changes. Startup opts in so operators can see version warnings in Cloud
Run logs.

## Parser Boundary Guards

### Manifest Nodes

`manifest.nodes` is required because it defines the models to parse. If it is
missing, null, an array, or not an object, throw a clear parser error:

```txt
dbt manifest has no nodes key - wrong or malformed manifest.json
```

This remains fatal by design. At startup, the loader catches it, emits the
existing fatal diagnostic, and exits non-zero.

### Catalog Nodes

`catalog.nodes` is useful but not required. Treat missing, null, array, or
wrong-shaped catalog nodes as an empty map:

```ts
const catalogNodes = objectRecordOrEmpty(catalog?.nodes);
```

This lets manifest-only runs produce table context with `UNKNOWN` data types
instead of crashing.

### Manifest Model Columns

Treat missing or wrong-shaped `node.columns` as an empty map. The table is still
emitted because the model itself exists. Catalog-only columns can still populate
the table when the catalog has matching physical columns.

### Catalog Column Types

Use `col.type || 'UNKNOWN'` for undocumented catalog-only columns, matching the
existing documented-column fallback. This prevents blank DDL types.

## Version Warning Behavior

Read `metadata.dbt_schema_version` from each artifact when available.

Known-good ranges:

- manifest: `v10` through `v12`
- catalog: `v1`

Parse schema URLs of the form:

```txt
https://schemas.getdbt.com/dbt/manifest/v11.json
https://schemas.getdbt.com/dbt/catalog/v1.json
```

Warnings:

- `missing`: no string `metadata.dbt_schema_version`;
- `unparseable`: present string does not match the expected dbt schema URL;
- `unsupported`: parsed major version outside the known-good range.

Warnings never throw and never change table output. They are observability only.
Emit all warnings in a single `onWarnings` call per parse.

## Startup Logging

`src/dbt/startupArtifacts.ts` should pass `onWarnings` when calling
`parseDbtArtifacts`:

```ts
parseArtifacts(manifest, catalog, {
  onWarnings: (warnings) => {
    logger.warn(
      { manifestPath, catalogPath, warnings },
      'dbt artifact schema version warning',
    );
  },
});
```

The injected `parseArtifacts` type in the startup loader should continue to be
`typeof parseDbtArtifacts`, so once parser options include `onWarnings`, tests
can pass warning-producing parser fakes through the same dependency seam.
Warning logs are separate from the existing zero-model warning. If a parse also
returns zero tables, both signals are useful and should be emitted.

## Testing

Add focused tests in `tests/dbt/parser.test.ts`:

- missing `manifest.nodes` (`{}` and `{ nodes: null }`) throws the clear parser
  error, not a raw `TypeError`;
- missing or null `catalog.nodes` does not throw and emits tables with
  `UNKNOWN` types where catalog types are unavailable;
- a model without `columns` does not throw and still emits a table;
- a catalog-only column with `type: ''` becomes `UNKNOWN`;
- current fixtures emit no warnings and produce output identical to the existing
  parser behavior;
- missing metadata emits warnings and still parses;
- unparseable metadata emits warnings and still parses;
- future manifest `v20` emits an unsupported-version warning and still parses.

Add startup-loader tests in `tests/dbt/startupArtifacts.test.ts`:

- parser warnings are logged through `logger.warn` with artifact paths;
- parser warning logs do not suppress the existing info log on a non-empty
  successful parse;
- parser warning logs can coexist with the zero-model warning when applicable.

The implementation plan should preserve TDD: write the failing tests first, watch
them fail for the intended reasons, then implement the parser and startup-loader
changes.

## Benchmark and Governance Gate

This change edits `src/dbt/parser.ts`, the path that produced the accepted
ReferenceCard repair run. It is allowed as a defect fix, but it is not merge-ready
until the accepted benchmark slice is rerun.

Implementation acceptance flow:

1. Run `npm run typecheck`.
2. Run focused parser/startup tests.
3. Run `npm test`.
4. Run the operator-local accepted benchmark slice with live ignored artifacts.
5. Run judge and analyzer on the new benchmark result.
6. If the acceptance report says `ACCEPTED`, update
   `docs/trajectory-governance.md` in the same PR with:
   - date;
   - decision;
   - commit SHA;
   - artifact filenames only;
   - confirmation that live cards, corpus, dbt artifacts, raw results, project
     IDs, and store IDs remain ignored.
7. If the report says `NEEDS_REVISION`, stop. Do not merge until the new failing
   category is understood and repaired.

Raw benchmark output remains gitignored and must not be committed.

## Alternatives Considered

### Return `{ tables, warnings }`

This is explicit, but it forces broad call-site churn across benchmarks, teaching
validation, scripts, and tests. The warning channel is operational metadata; it
does not justify changing the core parser return type.

### Put Version Checks Only in Startup Loader

This would be lower churn, but direct parser consumers would remain version-blind.
Since #16 is specifically about `parseDbtArtifacts` ignoring schema versions,
the parser should own warning detection while startup owns log emission.

### Strictly Fail Unknown Schema Versions

Failing on unknown versions would be safer in a generic artifact-ingestion
product, but Anna Lytics loads operator-controlled artifacts at deploy time.
#16 explicitly asks to warn and continue, not branch into speculative adapters or
block controlled upgrades.

## Acceptance Criteria

- `parseDbtArtifacts` no longer crashes on missing catalog nodes or missing model
  columns.
- Missing or wrong-shaped `manifest.nodes` throws a clear parser error.
- Catalog-only empty string types become `UNKNOWN`.
- Current fixture output remains unchanged.
- Missing, unparseable, and unsupported schema versions emit warnings through an
  optional parser callback without changing output.
- Startup logs parser schema-version warnings once per parse when present.
- `src/dbt/parser.ts`, `src/dbt/startupArtifacts.ts`, and focused tests cover the
  behavior.
- `npm run typecheck` and `npm test` pass.
- The accepted benchmark slice is rerun and the governance Evidence Log is
  updated before merge.
