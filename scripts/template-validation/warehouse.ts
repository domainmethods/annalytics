import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BigQuery } from '@google-cloud/bigquery';
import { parse } from 'yaml';

export const TV_DATASET = 'tv_thelook';
export const TV_SOURCE_PROJECT = 'bigquery-public-data';
export const TV_SOURCE_DATASET = 'thelook_ecommerce';
export const TV_TABLES = ['orders', 'order_items', 'users', 'products', 'inventory_items', 'events', 'distribution_centers'] as const;
export const TV_ROOT = 'benchmarks/template-validation';

type Column = { table: string; column: string; dataType: string };
type Model = {
  name: string;
  schema: string;
  description: string;
  columns: { name: string; description: string }[];
};

export function viewDdl(projectId: string, table: string): string {
  if (!/^[a-z0-9-]+$/.test(projectId) || !TV_TABLES.some((name) => name === table)) {
    throw new Error('Invalid project ID or template validation table.');
  }
  return `CREATE OR REPLACE VIEW \`${projectId}.${TV_DATASET}.${table}\` AS SELECT * FROM \`${TV_SOURCE_PROJECT}.${TV_SOURCE_DATASET}.${table}\``;
}

export function checkSchemaDrift(modelsYaml: string, columns: Column[]): string[] {
  const { models } = parse(modelsYaml) as { models: Model[] };
  const liveTables = new Set(columns.map(({ table }) => table));
  const liveColumns = new Set(columns.map(({ table, column }) => `${table}.${column}`));
  const documentedColumns = new Set(models.flatMap(({ name, columns }) =>
    columns.map((column) => `${name}.${column.name}`),
  ));

  return [
    ...TV_TABLES.filter((table) => !liveTables.has(table)).map((table) => `Missing live view: ${table}`),
    ...[...documentedColumns].filter((column) => !liveColumns.has(column)).map((column) => `Missing live column: ${column}`),
    ...[...liveColumns].filter((column) => !documentedColumns.has(column)).map((column) => `Undocumented live column: ${column}`),
  ];
}

export function buildArtifacts(modelsYaml: string, columns: Column[]) {
  const { models } = parse(modelsYaml) as { models: Model[] };
  const manifest = {
    metadata: { dbt_schema_version: 'https://schemas.getdbt.com/dbt/manifest/v12.json' },
    nodes: Object.fromEntries(models.map((model) => [
      `model.template_validation.${model.name}`,
      {
        resource_type: 'model',
        name: model.name,
        schema: model.schema,
        description: model.description,
        config: { materialized: 'view' },
        columns: Object.fromEntries(model.columns.map(({ name, description }) => [name, { name, description }])),
      },
    ])),
  };
  const catalog = {
    metadata: { dbt_schema_version: 'https://schemas.getdbt.com/dbt/catalog/v1.json' },
    nodes: Object.fromEntries(models.map(({ name }) => [
      `model.template_validation.${name}`,
      {
        columns: Object.fromEntries(columns.filter(({ table }) => table === name).map(
          ({ column, dataType }, index) => [column, { name: column, type: dataType, index: index + 1 }],
        )),
      },
    ])),
  };
  return { manifest, catalog };
}

async function main(): Promise<void> {
  if (existsSync('.env') && typeof process.loadEnvFile === 'function') {
    process.loadEnvFile('.env');
  }
  const projectId = process.env.GCP_PROJECT_ID;
  if (!projectId) {
    console.error('Set GCP_PROJECT_ID in the environment or .env before running tv:setup.');
    process.exitCode = 1;
    return;
  }
  const views = TV_TABLES.map((table) => viewDdl(projectId, table));
  const dbtDir = `${TV_ROOT}/dbt`;
  const modelsYaml = readFileSync(`${dbtDir}/models.yml`, 'utf8');
  const location = 'US';
  const bigquery = new BigQuery({ projectId, location });
  await bigquery.dataset(TV_DATASET).get({ autoCreate: true, location });
  for (const query of views) {
    await bigquery.query({ query, location });
  }
  const [columns] = await bigquery.query({
    query: `
      SELECT table_name AS \`table\`, column_name AS \`column\`, data_type AS dataType
      FROM \`${projectId}.${TV_DATASET}.INFORMATION_SCHEMA.COLUMNS\`
      WHERE table_name IN UNNEST(@tables)
      ORDER BY table_name, ordinal_position
    `,
    params: { tables: [...TV_TABLES] },
    location,
  });

  const drift = checkSchemaDrift(modelsYaml, columns);
  if (drift.length > 0) {
    console.error(['Template validation warehouse schema drift. Artifacts were not written.', ...drift].join('\n'));
    process.exitCode = 1;
    return;
  }

  const artifacts = buildArtifacts(modelsYaml, columns);
  for (const [name, artifact] of Object.entries(artifacts)) {
    writeFileSync(`${dbtDir}/${name}.json`, JSON.stringify(artifact, null, 2) + '\n');
  }
  console.log(`Created or replaced ${views.length} views in ${TV_DATASET} and wrote dbt artifacts.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    const detail = error instanceof Error ? error.message : String(error);
    const projectId = process.env.GCP_PROJECT_ID;
    console.error('Template validation warehouse setup failed.', projectId ? detail.replaceAll(projectId, '<project>') : detail);
    process.exitCode = 1;
  });
}
