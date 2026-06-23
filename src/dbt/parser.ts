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

  if (typeof schemaVersion !== 'string') {
    return {
      artifact,
      schemaVersion: null,
      reason: 'missing',
      supportedRange: support.supportedRange,
    };
  }

  const match = schemaVersion.match(
    new RegExp(`^https://schemas\\.getdbt\\.com/dbt/${artifact}/v(\\d+)\\.json$`),
  );
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
