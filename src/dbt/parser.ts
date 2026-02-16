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

export function parseDbtArtifacts(
  manifest: { nodes: Record<string, ManifestNode> },
  catalog: { nodes: Record<string, CatalogNode> },
): TableContext[] {
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

    const columns: ColumnContext[] = Object.values(node.columns).map((col) => ({
      name: col.name,
      description: col.description || '',
      dataType: catalogColumns[col.name.toLowerCase()]?.type || 'UNKNOWN',
      meta: col.meta || {},
    }));

    const table: TableContext = {
      name: `${node.schema}.${node.name}`,
      schema: node.schema,
      description: node.description || '',
      materialization: node.config?.materialized || 'view',
      columns,
      sampleDDL: generateDDL(node.schema, node.name, columns),
      dependsOn: node.depends_on?.nodes || [],
      tags: node.tags || [],
    };

    tables.push(table);
  }

  return tables;
}

function generateDDL(schema: string, name: string, columns: ColumnContext[]): string {
  const colDefs = columns
    .map((c) => {
      const desc = c.description.replace(/[\r\n]+/g, ' ');
      const comment = desc ? ` -- ${desc}` : '';
      return `  ${c.name} ${c.dataType}${comment}`;
    })
    .join(',\n');
  return `CREATE TABLE \`${schema}.${name}\` (\n${colDefs}\n);`;
}
