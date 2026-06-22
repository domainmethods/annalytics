# INFORMATION_SCHEMA Identifier Fallback Design

**Date:** 2026-06-22
**Status:** Approved for implementation planning
**Scope:** Issue #15 only

## Summary

Fix the Stage 1b INFORMATION_SCHEMA fallback so non-dbt BigQuery table
references are extracted and resolved correctly when users name fully
qualified or hyphenated identifiers. The change preserves the fallback's
current role: opportunistically add minimal schema context for unknown
warehouse tables without changing the dbt parser, SQL generation, validation,
or execution paths.

## Context

`src/pipeline.ts` currently detects non-dbt table references with two regexes
that only capture two dot-separated `\w` segments. This misses hyphenated
project IDs and truncates three-part references before fallback lookup. The
subsequent left-to-right split treats the first segment as the dataset, so a
reference like `my_project.raw_dataset.raw_events` asks BigQuery for dataset
`my_project` and table `raw_dataset`.

The defect is a silent grounding degradation. A user can name a valid
non-dbt table, but the fallback lookup returns no schema and the pipeline
continues with less context than it could have had.

## Goals

- Correctly parse `dataset.table` references.
- Correctly parse `project.dataset.table` references.
- Allow hyphenated BigQuery project IDs in explicit three-part references.
- Keep false-positive guards for prose tokens such as `e.g` and `node.js`.
- Keep numeric-segment guards for tokens such as `v1.0`.
- Keep the change outside `src/dbt/parser.ts`, so no accepted benchmark-slice
  rerun is required.

## Non-Goals

- No general SQL parser.
- No support for four-part or region-qualified identifiers.
- No change to dbt parser output or `TableContext` shape. The fallback still
  skips two-part/default-project refs already represented by dbt metadata, but
  explicit non-default project refs are looked up separately even when their
  `dataset.table` suffix matches a dbt model.
- No change to SQL generation, supervisor behavior, validation, execution, or
  response formatting.
- No new governance evidence entry.

## Recommended Approach

Add a small pipeline-local parser for candidate fallback references. The
parser should extract candidate table names with hyphen-aware segments and
right-align the split:

- `dataset.table` uses `config.gcpProjectId` as the project.
- `project.dataset.table` uses the explicit project.

The parser should reject candidates embedded inside longer dotted identifiers,
so `us.region.dataset.table` is ignored instead of being partially interpreted
as `us.region.dataset` or `region.dataset.table`.

This keeps Stage 1b narrow and avoids introducing a larger SQL parsing
dependency for a best-effort prompt-grounding helper.

## Alternatives Considered

### Minimal Regex Patch Only

Extending the existing regexes and leaving parsing inline would be the smallest
diff, but it keeps the brittle left-to-right split close to the lookup call and
makes the tests less expressive. A tiny helper makes the right-aligned contract
obvious without broad refactoring.

### Full SQL Parser

A SQL parser would be more comprehensive for generated SQL, but this stage is
looking at the user's natural-language resolved question, not an authoritative
SQL AST. A full parser adds dependency and behavior surface without matching
the input shape.

### Move Fallback Extraction to a New Module

A new module would improve isolation, but the current fallback extraction is
small and pipeline-specific. Extracting it now would be more architecture than
issue #15 needs.

## Data Flow

1. The clarification step returns `resolvedQuestion`.
2. Stage 1b extracts candidate references from that text.
3. The parser normalizes each candidate into `{ projectId, datasetId, tableId,
   displayName }`.
4. Existing dbt table matching skips candidates already covered by dbt context
   when the candidate is a two-part ref or explicitly names the default
   project. Explicit non-default project refs proceed to fallback lookup.
5. Unknown candidates call `getSchemaFallback(projectId, datasetId, tableId)`.
6. Returned fallback tables are appended to the tables passed into the quality
   loop.

## Cache Key Adjustment

`getSchemaFallback` currently caches by `dataset.table`. Once explicit project
IDs are supported, that key can collide across projects. Update the cache key
to `project.dataset.table` while leaving the returned `TableContext.name` as
`dataset.table` for existing prompt compatibility.

## Testing

Extend `tests/pipeline/informationSchemaFallback.integration.test.ts` with
regression cases for:

- two-part `raw_dataset.raw_events`
- three-part `other_project.raw_dataset.raw_events`
- explicit non-default project refs whose `dataset.table` suffix matches an
  existing dbt table
- hyphenated `gcp-project-123.raw_dataset.raw_events`
- false positives and numeric segments remaining filtered
- four-part or region-qualified refs are ignored rather than partially matched

Extend `tests/dbt/informationSchemaFallback.test.ts` for the cache-key change:

- cache read uses `project.dataset.table`
- cache write uses `project.dataset.table`
- returned `TableContext.name` remains `dataset.table`

Run:

```bash
npm run typecheck
npm test -- tests/pipeline/informationSchemaFallback.integration.test.ts tests/dbt/informationSchemaFallback.test.ts
npm test
```
