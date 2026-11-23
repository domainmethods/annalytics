export interface OverrideConfig {
  maxBytesProcessed: number;
  queryTimeoutMs: number;
  maxResultRows: number;
  geminiApiKey: string;
  /** Verified Share column / Total row on Table override and Summary fallback tables. */
  answerSharesEnabled?: boolean;
}
