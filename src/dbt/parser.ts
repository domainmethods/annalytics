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
  database?: unknown;
  alias?: unknown;
  relation_name?: unknown;
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

/**
 * Collects columns covered by an unconditional, enabled, un-namespaced dbt
 * `unique` test, keyed by the model node id. Fail closed: any unknown shape is
 * skipped, since a wrongly-unique column would yield wrong percentages.
 */
function uniqueColumnsByModel(manifestNodes: Record<string, unknown>): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  const isModel = (id: unknown): id is string =>
    typeof id === 'string' && isRecord(manifestNodes[id]) && manifestNodes[id].resource_type === 'model';

  for (const rawNode of Object.values(manifestNodes)) {
    if (!isRecord(rawNode) || rawNode.resource_type !== 'test') continue;
    const meta = rawNode.test_metadata;
    if (!isRecord(meta) || meta.name !== 'unique') continue;
    if (meta.namespace !== undefined && meta.namespace !== null && meta.namespace !== '') continue;

    const config = optionalRecord(rawNode.config);
    if (config.enabled === false) continue;
    if (typeof config.where === 'string' && config.where.trim() !== '') continue;
    // A non-error severity or a tolerance threshold lets duplicates pass the build.
    if (typeof config.severity === 'string' && config.severity.trim().toLowerCase() !== 'error') continue;
    const tolerant = (v: unknown): boolean =>
      v !== undefined && v !== null && (typeof v !== 'string' || v.replace(/\s+/g, '') !== '!=0');
    if (tolerant(config.error_if) || tolerant(config.warn_if)) continue;

    let modelId: string | undefined;
    if (rawNode.attached_node !== undefined && rawNode.attached_node !== null) {
      if (!isModel(rawNode.attached_node)) continue;
      modelId = rawNode.attached_node;
    } else {
      const deps = stringArray(optionalRecord(rawNode.depends_on).nodes);
      const models = deps.filter(isModel);
      if (deps.length !== 1 || models.length !== 1) continue;
      modelId = models[0];
    }

    const column = rawNode.column_name ?? optionalRecord(meta.kwargs).column_name;
    if (typeof column !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(column.trim())) continue;

    const set = result.get(modelId) ?? new Set<string>();
    set.add(column.trim().toLowerCase());
    result.set(modelId, set);
  }
  return result;
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

  const uniqueByModel = uniqueColumnsByModel(manifestNodes);
  const tables: TableContext[] = [];

  for (const [nodeId, rawNode] of Object.entries(manifestNodes)) {
    if (!isRecord(rawNode) || rawNode.resource_type !== 'model') continue;

    const node = rawNode as ManifestNode;
    if (materializationFor(node) === 'ephemeral') continue;
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
    const relation = stringValue(node.relation_name).replace(/[`"\s]/g, '').split('.');
    const hasRelation = Boolean(stringValue(node.relation_name).trim());
    if (hasRelation && (relation.length !== 3 || relation.some(part => !part))) {
      console.warn('Invalid dbt relation_name: skipping node; expected three non-empty identifiers');
      continue;
    }
    const schema = (hasRelation ? relation.at(-2) : stringValue(node.schema)) || '';
    const name = (hasRelation ? relation.at(-1) : stringValue(node.alias)) || stringValue(node.name, nodeId);
    const database = hasRelation ? (relation.length === 3 ? relation[0] : '') : stringValue(node.database);
    const qualifiedSchema = database ? `${database}.${schema}` : schema;

    const table: TableContext = {
      name: `${qualifiedSchema}.${name}`,
      schema,
      description: stringValue(node.description),
      materialization: materializationFor(node),
      columns,
      sampleDDL: generateDDL(qualifiedSchema, name, columns, omittedColumnCount),
      dependsOn: dependsOnFor(node),
      tags: tagsFor(node),
      ...(uniqueByModel.get(nodeId)?.size
        ? { uniqueColumns: [...uniqueByModel.get(nodeId)!].sort() }
        : {}),
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
