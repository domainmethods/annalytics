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
