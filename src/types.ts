import type { GroundingCitation } from './agents/types.js';

export interface SqlGenerationResult {
  sql: string;
  explanation: string;
  tablesUsed: string[];
  confidence: 'high' | 'medium' | 'low';
  assumptions: string[];
  reasoningChain: string;
  groundingCitations: GroundingCitation[];
}

export interface ValidationResult {
  valid: boolean;
  layer: string;              // which layer failed
  error?: string;
  bytesProcessed?: number;    // from dry run
}

export interface QueryResult {
  rows: Record<string, unknown>[];
  columnNames: string[];
  totalRows: number;          // from job metadata (not COUNT(*))
  bytesProcessed: number;
  truncated: boolean;         // true if totalRows > maxResultRows
}

export interface ResponseContext {
  responseId: string;
  threadTs: string;
  statusMsgTs: string;
  clarifiedQuestion: string;
  assumptions: string[];
  reasoningChain: string;
  generatedSql: string;
  explanation: string;
  tablesUsed: string[];
  confidence: 'high' | 'medium' | 'low';
  // R9.3: Store all three confidence values for observability
  clarificationConfidence?: 'high' | 'medium' | 'low';
  primaryAgentConfidence: 'high' | 'medium' | 'low';
  supervisorConfidence?: 'high' | 'medium' | 'low';
  queryResults: {
    rowCount: number;
    columnNames: string[];
    bytesProcessed: number;
  };
  pipelineDurationMs: number;
  traceId: string;
  createdAt: Date;
  groundingCitations: GroundingCitation[];
  teachingsUsed: string[];
  supervisorVerdict: 'pass' | 'fail_then_pass' | 'exhausted';
  supervisorNotes: string;
  negativeFeedback?: boolean;
}

export interface SampleRowEntry {
  tableName: string;
  rows: Record<string, unknown>[];
  fetchedAt: Date;
  stale: boolean;
}

export interface PipelineLog {
  traceId: string;
  stage: 'clarify' | 'retrieve' | 'generate' | 'validate' | 'supervise' | 'execute' | 'format';
  durationMs: number;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  confidence?: string;
  bytesProcessed?: number;
  error?: string;
}

export interface ThreadMessage {
  role: 'user' | 'assistant';
  content: string;
}
