# dbt Startup Artifact Load Diagnostics Design

**Date:** 2026-06-22
**Status:** Approved for implementation planning
**Scope:** Issue #13 only

## Summary

Surface abnormal dbt artifact loads at startup without changing dbt parser
behavior. The bot should emit a clear fatal log and exit when manifest or
catalog files cannot be read, parsed, or converted into table context. It
should also warn when parsing succeeds but produces zero models, because that
state lets the bot run while grounding every query against an empty schema.

The implementation should keep `src/app.ts` as thin wiring and move the
load-and-log behavior into a small testable helper.

## Context

`src/app.ts` currently loads dbt artifacts with bare `readFileSync` and
`JSON.parse` calls:

```ts
const manifest = JSON.parse(readFileSync(config.dbt.manifestPath, 'utf-8'));
const catalog = JSON.parse(readFileSync(config.dbt.catalogPath, 'utf-8'));
tables = parseDbtArtifacts(manifest, catalog);
rootLogger.info({ tableCount: tables.length }, 'Loaded dbt metadata');
```

This has two trust problems:

- missing or malformed artifacts crash with raw `ENOENT`, `SyntaxError`, or
  parser errors instead of one actionable startup diagnostic;
- structurally valid artifacts with zero dbt models log as ordinary success and
  let the bot answer with an empty schema layer.

`src/app.ts` is excluded from coverage and imports the full Bolt runtime, so a
pure inline `try/catch` would be difficult to test directly. A tiny helper keeps
the entry point thin while making the important behavior unit-testable.

## Goals

- Emit one clear fatal log when startup dbt artifacts fail to load or parse.
- Exit non-zero from `src/app.ts` after a fatal startup dbt load failure.
- Emit a warning when the parsed table list is empty.
- Preserve the existing info log and returned table list on the happy path.
- Avoid touching `src/dbt/parser.ts`, so no accepted benchmark-slice re-run is
  required.
- Keep the change limited to dbt startup loading and tests.

## Non-Goals

- No parser hardening for missing or variant dbt artifact fields. That belongs
  to issues #12 and #16.
- No schema-version checks.
- No validation library or new artifact schema model.
- No change to `TableContext`, SQL generation, benchmark behavior, or runtime
  query handling.
- No governance Evidence Log update.

## Recommended Approach

Add a small module, `src/dbt/startupArtifacts.ts`, that exports a function such
as `loadDbtArtifactsForStartup`.

The helper should accept:

- `manifestPath`
- `catalogPath`
- an injected logger with `info`, `warn`, and `fatal` methods
- optional injected `readFile` and `parseArtifacts` dependencies for tests

The default dependencies should use `readFileSync` and `parseDbtArtifacts`.
Keeping dependency injection local avoids mocking Node filesystem APIs or
importing `src/app.ts` in tests.

Suggested shape:

```ts
interface StartupArtifactLogger {
  info(meta: object, message: string): void;
  warn(meta: object, message: string): void;
  fatal(meta: object, message: string): void;
}

interface LoadDbtArtifactsInput {
  manifestPath: string;
  catalogPath: string;
  logger: StartupArtifactLogger;
  readFile?: (path: string) => string;
  parseArtifacts?: typeof parseDbtArtifacts;
}
```

The helper should:

1. read both files;
2. parse both JSON payloads;
3. call `parseDbtArtifacts`;
4. log `warn` and return `[]` if parsing succeeds with zero tables;
5. log `info` and return tables if at least one table is loaded;
6. catch all errors from read, JSON parse, or parser conversion, log `fatal`,
   and throw a purpose-specific startup error.

`src/app.ts` should then reduce its startup load block to:

```ts
try {
  tables = loadDbtArtifactsForStartup({
    manifestPath: config.dbt.manifestPath,
    catalogPath: config.dbt.catalogPath,
    logger: rootLogger,
  });
} catch {
  process.exit(1);
}
```

This keeps process termination in the entry point and lets the helper stay pure
enough for direct unit tests.

## Error Handling

Fatal logs should include the artifact paths and a sanitized error message or
error object, but should not print artifact contents. The message should be
stable and actionable, for example:

```txt
Failed to load dbt artifacts at startup
```

The helper should throw a new startup-load error after logging. The original
error can be attached via `cause` so local debugging still has a useful stack,
while `app.ts` intentionally suppresses a second raw stack trace and exits.

Zero-model loads are not fatal because issue #13 explicitly asks for a warning.
The warning should include `tableCount: 0` and enough path metadata for an
operator to verify which artifacts were loaded.

## Testing

Add `tests/dbt/startupArtifacts.test.ts` with injected dependencies.

Cover:

- happy path with the existing fixtures: returns the same `TableContext[]` as
  `parseDbtArtifacts` and logs one info message;
- malformed JSON or missing file: logs one fatal message, throws, and does not
  log ordinary success;
- parser failure: logs one fatal message and throws the startup wrapper;
- zero-model parse result: logs one warn message, returns `[]`, and does not
  log info as success.

`src/app.ts` remains thin and coverage-excluded. Verification for the wiring is
`npm run typecheck` plus the full suite.

## Acceptance Criteria

- Missing, unreadable, malformed, or parser-rejected artifacts produce one
  clear `fatal` log and the app exits non-zero.
- Zero-model artifacts produce a `warn` log and the app continues with an empty
  table list.
- Non-zero happy path behavior is unchanged except that it flows through the
  helper.
- No edits to `src/dbt/parser.ts`.
- `npm run typecheck` passes.
- `npm test` passes.

## Alternatives Considered

### Inline `try/catch` in `src/app.ts`

This is the smallest diff, but it leaves the behavior effectively untested
because `src/app.ts` is a coverage-excluded entry point and imports the full
runtime. It is acceptable for process-exit wiring, not for the core diagnostic
behavior.

### Parser-Level Hardening

Parser guards are valuable, but they belong to issues #12 and #16 and require a
single shared acceptance-slice re-run. Issue #13 can improve startup diagnostics
without touching the benchmark-gated parser path.

### Strictly Fail on Zero Models

Failing on zero models would be safer for most production deployments, but the
issue acceptance criteria specify warn-level behavior. The design keeps that
contract and makes the risk visible in logs.

## Governance

This is a trust and operations fix for an existing startup path. It does not
add product surface area and does not alter the benchmark-gated parser behavior.
No accepted ReferenceCard benchmark slice is required for this issue.
