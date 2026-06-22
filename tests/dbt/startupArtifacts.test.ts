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
      path === manifestPath ? 'not json' : '{"nodes":{}}'
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
        error: 'Invalid JSON in manifest artifact',
      }),
      fatalMessage,
    );
    const [[fatalMeta]] = vi.mocked(logger.fatal).mock.calls;
    expect(String(fatalMeta.error)).not.toContain('not json');
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
