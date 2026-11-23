export interface TableContext {
  name: string;               // Physical relation, e.g., "project.analytics.fct_orders"
  schema: string;             // e.g., "analytics"
  description: string;
  materialization: string;    // "table" | "view" | "incremental"
  columns: ColumnContext[];
  sampleDDL: string;          // CREATE TABLE DDL for prompt injection
  dependsOn: string[];        // dbt node IDs this model depends on
  tags: string[];
  /**
   * Lower-cased columns DECLARED unique by an unconditional dbt `unique` test.
   * A declaration, not an observation: `dbt build` materializes a model before
   * its tests run, so a failing test can leave duplicates in place. Omitted when none.
   */
  uniqueColumns?: string[];
}

export interface ColumnContext {
  name: string;
  description: string;
  dataType: string;           // from catalog.json, e.g., "STRING", "INT64"
  meta: Record<string, unknown>;
}

export interface TableQuality {
  descriptionPresent: boolean;
  columnDescriptionCoverage: number;  // 0-1
  qualityTier: 'high' | 'medium' | 'low';
}
