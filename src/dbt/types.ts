export interface TableContext {
  name: string;               // e.g., "analytics.fct_orders"
  schema: string;             // e.g., "analytics"
  description: string;
  materialization: string;    // "table" | "view" | "incremental"
  columns: ColumnContext[];
  sampleDDL: string;          // CREATE TABLE DDL for prompt injection
  dependsOn: string[];        // dbt node IDs this model depends on
  tags: string[];
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

export interface MetadataState {
  lastRefreshAt: Date;
  manifestVersion: string;
  tableCount: number;
  refreshSource: 'webhook' | 'poll' | 'manual';
}
