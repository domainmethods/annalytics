import { getBigQueryClient } from '../execution/runner.js';
import { getCachedSchema, cacheSchema } from '../state/informationSchemaCache.js';
import { generateDDL } from './parser.js';
import type { TableContext, ColumnContext } from './types.js';

const VALID_IDENTIFIER = /^[a-zA-Z0-9_-]+$/;

export async function getSchemaFallback(
  projectId: string,
  datasetId: string,
  tableId: string,
): Promise<TableContext | null> {
  // Validate identifiers to prevent injection
  if (!VALID_IDENTIFIER.test(projectId) || !VALID_IDENTIFIER.test(tableId) || !VALID_IDENTIFIER.test(datasetId)) {
    return null;
  }

  const cacheKey = `${datasetId}.${tableId}`;

  // Check cache first
  const cached = await getCachedSchema(cacheKey);
  if (cached) {
    return cached;
  }

  try {
    const bq = getBigQueryClient();
    const [rows] = await bq.query({
      query: `SELECT column_name, data_type, description FROM \`${projectId}.${datasetId}.INFORMATION_SCHEMA.COLUMN_FIELD_PATHS\` WHERE table_name = @tableName AND field_path = column_name`,
      params: { tableName: tableId },
    });

    if (!rows || (rows as unknown[]).length === 0) {
      return null;
    }

    const columns: ColumnContext[] = (rows as Array<{ column_name: string; data_type: string; description: string | null }>).map((row) => ({
      name: row.column_name,
      dataType: row.data_type,
      description: row.description || '',
      meta: {},
    }));

    const tableContext: TableContext = {
      name: cacheKey,
      schema: datasetId,
      description: '',
      materialization: 'unknown',
      columns,
      sampleDDL: generateDDL(datasetId, tableId, columns),
      dependsOn: [],
      tags: ['no-dbt-metadata'],
    };

    await cacheSchema(cacheKey, tableContext);

    return tableContext;
  } catch (err) {
    console.error(
      `Failed to fetch INFORMATION_SCHEMA for ${cacheKey}:`,
      (err as Error).message,
    );
    return null;
  }
}
