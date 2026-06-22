# dbt Startup Artifact Load Diagnostics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix issue #13 by surfacing abnormal dbt artifact startup loads with clear fatal/warn logs while preserving happy-path behavior.

**Architecture:** Add a testable `src/dbt/startupArtifacts.ts` helper that reads, parses, logs, and returns startup table metadata. Keep `src/app.ts` as process-exit wiring only, and do not edit the benchmark-gated `src/dbt/parser.ts`.

**Tech Stack:** TypeScript, NodeNext ESM, Vitest, existing pino-style logger signatures.

---

## File Structure

- Create: `src/dbt/startupArtifacts.ts`
  - Owns startup dbt artifact read/parse diagnostics.
  - Exposes `loadDbtArtifactsForStartup`, `StartupArtifactLogger`, and `DbtStartupArtifactLoadError`.
- Create: `tests/dbt/startupArtifacts.test.ts`
  - Unit-tests loader behavior through injected filesystem/parser dependencies.
  - Avoids importing `src/app.ts`.
- Modify: `src/app.ts`
  - Removes direct `readFileSync` and `parseDbtArtifacts` usage.
  - Calls the new helper and exits non-zero on helper failure.
- Do not modify: `src/dbt/parser.ts`
  - Parser hardening belongs to issues #12 and #16 and would require acceptance-slice evidence.

## Task 1: Add Red Startup Artifact Loader Tests

**Files:**
- Create: `tests/dbt/startupArtifacts.test.ts`

- [ ] **Step 1: Create the failing test file**

Create `tests/dbt/startupArtifacts.test.ts` with this exact content:

```ts
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseDbtArtifacts } from '../../src/dbt/parser.js';
import type { TableContext } from '../../src/dbt/types.js';
import {
  DbtStartupArtifactLoadError,
  loadDbtArtifactsForStartup,
  type StartupArtifactLogger,
} from '../../src/dbt/startupArtifacts.js';

const fixturesDir = join(import.meta.dirname, '../fixtures');
const manifestPath = join(fixturesDir, 'manifest.json');
const catalogPath = join(fixturesDir, 'catalog.json');
const fatalMessage = 'Failed to load dbt artifacts at startup';

function makeLogger(): StartupArtifactLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    fatal: vi.fn(),
  };
}

describe('loadDbtArtifactsForStartup', () => {
  it('loads current fixtures and preserves the existing info log shape', () => {
    const logger = makeLogger();
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    const catalog = JSON.parse(readFileSync(catalogPath, 'utf-8'));
    const expected = parseDbtArtifacts(manifest, catalog);

    const result = loadDbtArtifactsForStartup({
      manifestPath,
      catalogPath,
      logger,
    });

    expect(result).toEqual(expected);
    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(
      { tableCount: expected.length },
      'Loaded dbt metadata',
    );
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.fatal).not.toHaveBeenCalled();
  });

  it('logs one fatal message and throws a startup error when a file cannot be read', () => {
    const logger = makeLogger();
    const readFile = vi.fn(() => {
      throw new Error('ENOENT: no such file or directory');
    });

    expect(() => loadDbtArtifactsForStartup({
      manifestPath,
      catalogPath,
      logger,
      readFile,
    })).toThrow(DbtStartupArtifactLoadError);

    expect(logger.fatal).toHaveBeenCalledTimes(1);
    expect(logger.fatal).toHaveBeenCalledWith(
      expect.objectContaining({
        manifestPath,
        catalogPath,
        error: 'ENOENT: no such file or directory',
      }),
      fatalMessage,
    );
    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('logs one fatal message and throws a startup error when artifact JSON is malformed', () => {
    const logger = makeLogger();
    const readFile = vi.fn((path: string) => (
      path === manifestPath ? '{ not valid json' : '{"nodes":{}}'
    ));

    expect(() => loadDbtArtifactsForStartup({
      manifestPath,
      catalogPath,
      logger,
      readFile,
    })).toThrow(DbtStartupArtifactLoadError);

    expect(logger.fatal).toHaveBeenCalledTimes(1);
    expect(logger.fatal).toHaveBeenCalledWith(
      expect.objectContaining({
        manifestPath,
        catalogPath,
        error: expect.any(String),
      }),
      fatalMessage,
    );
    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('logs one fatal message and throws a startup error when parser conversion fails', () => {
    const logger = makeLogger();
    const readFile = vi.fn(() => '{"nodes":{}}');
    const parseArtifacts = vi.fn((): TableContext[] => {
      throw new Error('dbt manifest has no nodes key');
    });

    expect(() => loadDbtArtifactsForStartup({
      manifestPath,
      catalogPath,
      logger,
      readFile,
      parseArtifacts,
    })).toThrow(DbtStartupArtifactLoadError);

    expect(logger.fatal).toHaveBeenCalledTimes(1);
    expect(logger.fatal).toHaveBeenCalledWith(
      expect.objectContaining({
        manifestPath,
        catalogPath,
        error: 'dbt manifest has no nodes key',
      }),
      fatalMessage,
    );
    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('warns and returns an empty table list when parsing succeeds with zero models', () => {
    const logger = makeLogger();
    const readFile = vi.fn(() => '{"nodes":{}}');
    const parseArtifacts = vi.fn((): TableContext[] => []);

    const result = loadDbtArtifactsForStartup({
      manifestPath,
      catalogPath,
      logger,
      readFile,
      parseArtifacts,
    });

    expect(result).toEqual([]);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
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
});
```

- [ ] **Step 2: Run the red test**

Run:

```bash
npm test -- tests/dbt/startupArtifacts.test.ts
```

Expected: fail with a module resolution error for `../../src/dbt/startupArtifacts.js`, because the helper does not exist yet.

## Task 2: Implement the Startup Artifact Loader

**Files:**
- Create: `src/dbt/startupArtifacts.ts`
- Test: `tests/dbt/startupArtifacts.test.ts`

- [ ] **Step 1: Add the helper implementation**

Create `src/dbt/startupArtifacts.ts` with this exact content:

```ts
import { readFileSync } from 'node:fs';
import { parseDbtArtifacts } from './parser.js';
import type { TableContext } from './types.js';

const STARTUP_LOAD_FAILURE_MESSAGE = 'Failed to load dbt artifacts at startup';

export interface StartupArtifactLogger {
  info(meta: Record<string, unknown>, message: string): void;
  warn(meta: Record<string, unknown>, message: string): void;
  fatal(meta: Record<string, unknown>, message: string): void;
}

type ReadArtifactFile = (path: string) => string;
type ParseArtifacts = typeof parseDbtArtifacts;

export interface LoadDbtArtifactsInput {
  manifestPath: string;
  catalogPath: string;
  logger: StartupArtifactLogger;
  readFile?: ReadArtifactFile;
  parseArtifacts?: ParseArtifacts;
}

export class DbtStartupArtifactLoadError extends Error {
  constructor(cause: unknown) {
    super(STARTUP_LOAD_FAILURE_MESSAGE, { cause });
    this.name = 'DbtStartupArtifactLoadError';
  }
}

function defaultReadFile(path: string): string {
  return readFileSync(path, 'utf-8');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function loadDbtArtifactsForStartup(input: LoadDbtArtifactsInput): TableContext[] {
  const {
    manifestPath,
    catalogPath,
    logger,
    readFile = defaultReadFile,
    parseArtifacts = parseDbtArtifacts,
  } = input;

  try {
    const manifest = JSON.parse(readFile(manifestPath)) as Parameters<ParseArtifacts>[0];
    const catalog = JSON.parse(readFile(catalogPath)) as Parameters<ParseArtifacts>[1];
    const tables = parseArtifacts(manifest, catalog);

    if (tables.length === 0) {
      logger.warn(
        { tableCount: 0, manifestPath, catalogPath },
        'Loaded dbt metadata with ZERO models',
      );
      return tables;
    }

    logger.info({ tableCount: tables.length }, 'Loaded dbt metadata');
    return tables;
  } catch (error) {
    logger.fatal(
      { manifestPath, catalogPath, error: errorMessage(error) },
      STARTUP_LOAD_FAILURE_MESSAGE,
    );
    throw new DbtStartupArtifactLoadError(error);
  }
}
```

- [ ] **Step 2: Run the focused loader tests**

Run:

```bash
npm test -- tests/dbt/startupArtifacts.test.ts
```

Expected: pass with 5 tests.

- [ ] **Step 3: Commit the green loader slice**

Run:

```bash
git add src/dbt/startupArtifacts.ts tests/dbt/startupArtifacts.test.ts
git commit -m "fix: add dbt startup artifact diagnostics"
```

Expected: commit succeeds. If hooks run the focused test or lint-staged reports no matching files, continue only if `git status --short` is clean after the commit.

## Task 3: Wire Startup Diagnostics Into app.ts

**Files:**
- Modify: `src/app.ts`
- Depends on: `src/dbt/startupArtifacts.ts`

- [ ] **Step 1: Update imports in `src/app.ts`**

Remove these imports:

```ts
import { readFileSync } from 'node:fs';
import { parseDbtArtifacts } from './dbt/parser.js';
```

Add this import near the other dbt imports:

```ts
import { loadDbtArtifactsForStartup } from './dbt/startupArtifacts.js';
```

After the import section, `src/app.ts` should no longer import `readFileSync` or `parseDbtArtifacts`.

- [ ] **Step 2: Replace the direct startup load block**

Replace the current block:

```ts
// Load dbt artifacts at startup - fail fast if missing
const manifest = JSON.parse(readFileSync(config.dbt.manifestPath, 'utf-8'));
const catalog = JSON.parse(readFileSync(config.dbt.catalogPath, 'utf-8'));
tables = parseDbtArtifacts(manifest, catalog);
rootLogger.info({ tableCount: tables.length }, 'Loaded dbt metadata');
```

with:

```ts
// Load dbt artifacts at startup. The helper logs a single fatal diagnostic
// before this entry point exits on malformed or missing artifacts.
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

- [ ] **Step 3: Typecheck the app wiring**

Run:

```bash
npm run typecheck
```

Expected: pass with no TypeScript errors.

- [ ] **Step 4: Re-run the focused loader tests**

Run:

```bash
npm test -- tests/dbt/startupArtifacts.test.ts
```

Expected: pass with 5 tests.

- [ ] **Step 5: Commit app wiring**

Run:

```bash
git add src/app.ts
git commit -m "fix: wire dbt startup artifact diagnostics"
```

Expected: commit succeeds and `git status --short` is clean.

## Task 4: Full Verification and Review

**Files:**
- Verify all modified files.

- [ ] **Step 1: Verify no parser changes**

Run:

```bash
git diff --name-only origin/main...HEAD
```

Expected output includes only:

```txt
docs/superpowers/specs/2026-06-22-dbt-startup-artifact-loads-design.md
docs/superpowers/plans/2026-06-22-dbt-startup-artifact-loads.md
src/app.ts
src/dbt/startupArtifacts.ts
tests/dbt/startupArtifacts.test.ts
```

If `src/dbt/parser.ts` appears, stop and review scope before continuing.

- [ ] **Step 2: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected: pass with no TypeScript errors.

- [ ] **Step 3: Run focused tests**

Run:

```bash
npm test -- tests/dbt/startupArtifacts.test.ts
```

Expected: pass with 5 tests.

- [ ] **Step 4: Run the full suite**

Run:

```bash
npm test
```

Expected: all Vitest files pass.

- [ ] **Step 5: Review the final diff**

Run:

```bash
git diff --stat origin/main...HEAD
git diff --check origin/main...HEAD
```

Expected: diff is limited to the design doc, this plan, startup loader helper, app wiring, and tests. `git diff --check` prints no whitespace errors.

- [ ] **Step 6: Prepare PR body**

Use this PR body:

```markdown
## What changed

- Added a testable dbt startup artifact loader for manifest/catalog read, parse, and diagnostic logging.
- Wired `src/app.ts` through the loader so missing, malformed, or parser-rejected artifacts produce one fatal startup diagnostic before process exit.
- Added warn-level logging for zero-model artifact loads while preserving the existing info log shape for non-zero loads.

## Why

Issue #13 identified two startup trust failures: raw artifact read/parse crashes were not actionable, and zero-model metadata loads looked like ordinary success even though every query would ground against an empty schema.

This stays outside `src/dbt/parser.ts`, so it does not require a ReferenceCard acceptance-slice rerun.

## Validation

- `npm run typecheck`
- `npm test -- tests/dbt/startupArtifacts.test.ts`
- `npm test`

Closes #13.
```

Expected: the PR description makes the governance boundary explicit and includes `Closes #13`.
