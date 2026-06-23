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
type ArtifactKind = 'manifest' | 'catalog';

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

class DbtArtifactJsonParseError extends Error {
  constructor(artifact: ArtifactKind, cause: unknown) {
    super(`Invalid JSON in ${artifact} artifact`, { cause });
    this.name = 'DbtArtifactJsonParseError';
  }
}

function defaultReadFile(path: string): string {
  return readFileSync(path, 'utf-8');
}

function parseArtifactJson(contents: string, artifact: ArtifactKind): unknown {
  try {
    return JSON.parse(contents);
  } catch (error) {
    throw new DbtArtifactJsonParseError(artifact, error);
  }
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
    const manifest = parseArtifactJson(readFile(manifestPath), 'manifest') as Parameters<ParseArtifacts>[0];
    const catalog = parseArtifactJson(readFile(catalogPath), 'catalog') as Parameters<ParseArtifacts>[1];
    const tables = parseArtifacts(manifest, catalog, {
      onWarnings: (warnings) => {
        logger.warn(
          { manifestPath, catalogPath, warnings },
          'dbt artifact schema version warning',
        );
      },
    });

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
