import type { TableContext, ColumnContext } from './types.js';

interface ManifestNode {
  resource_type: string;
  name: string;
  schema: string;
  description?: string;
  columns: Record<string, { name: string; description?: string; meta?: Record<string, unknown> }>;
  config?: { materialized?: string };
  depends_on?: { nodes?: string[] };
  tags?: string[];
}

interface CatalogNode {
  columns: Record<string, { type: string; index: number }>;
}

// Tables whose full physical column set exceeds this stay documented-columns-only
// (plus an omission marker in the DDL). Keeps wide raw-event staging tables from
// flooding the prompt while marts remain fully visible.
export const DEFAULT_MAX_COLUMNS_PER_TABLE = 64;

export interface ParseDbtOptions {
  maxColumnsPerTable?: number;
}

export function parseDbtArtifacts(
  manifest: { nodes: Record<string, ManifestNode> },
  catalog: { nodes: Record<string, CatalogNode> },
  options: ParseDbtOptions = {},
): TableContext[] {
  const maxColumnsPerTable = options.maxColumnsPerTable ?? DEFAULT_MAX_COLUMNS_PER_TABLE;
  const tables: TableContext[] = [];

  for (const [nodeId, node] of Object.entries(manifest.nodes)) {
    if (node.resource_type !== 'model') continue;

    const catalogNode = catalog.nodes[nodeId];

    // Normalize catalog column keys to lowercase — BigQuery's catalog.json
    // reports column names in UPPERCASE while manifest.json uses lowercase.
    const catalogColumns = catalogNode?.columns
      ? Object.fromEntries(
          Object.entries(catalogNode.columns).map(([k, v]) => [k.toLowerCase(), v]),
        )
      : {};

    const documented: ColumnContext[] = Object.values(node.columns).map((col) => ({
      name: col.name,
      description: col.description || '',
      dataType: catalogColumns[col.name.toLowerCase()]?.type || 'UNKNOWN',
      meta: col.meta || {},
    }));

    // The manifest only carries columns documented in dbt YAML, and package
    // models cannot be doc-patched from the parent project — so the catalog
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
        dataType: col.type,
        meta: {},
      }));

    const withinCap = documented.length + undocumented.length <= maxColumnsPerTable;
    const columns = withinCap ? [...documented, ...undocumented] : documented;
    const omittedColumnCount = withinCap ? 0 : undocumented.length;

    const table: TableContext = {
      name: `${node.schema}.${node.name}`,
      schema: node.schema,
      description: node.description || '',
      materialization: node.config?.materialized || 'view',
      columns,
      sampleDDL: generateDDL(node.schema, node.name, columns, omittedColumnCount),
      dependsOn: node.depends_on?.nodes || [],
      tags: node.tags || [],
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
