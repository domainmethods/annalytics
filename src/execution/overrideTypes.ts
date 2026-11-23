export interface OverrideConfig {
  maxBytesProcessed: number;
  queryTimeoutMs: number;
  maxResultRows: number;
  geminiApiKey: string;
  /** Verified Share column / Total row on Table override and Summary fallback tables. */
  answerSharesEnabled?: boolean;
  /** Unique keys the loaded dbt metadata declares now; a saved key missing here is not trusted on re-render. Absent: no key is trusted. */
  currentUniqueKeys?: () => string[];
}
