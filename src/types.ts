import type { GroundingCitation } from './agents/types.js';
import type { FailureRecord } from './qualityLoop.js';

export interface SqlGenerationResult {
  sql: string;
  explanation: string;
  headline: string;
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
  /**
   * Set by dryRunValidation for errors beyond invalidQuery and billingTierLimitExceeded,
   * including accessDenied, notFound, and quotaExceeded, and when a dry run reports no usable
   * byte count. Lets a caller tell infrastructure failures apart from model errors.
   */
  warehouseFailure?: true;
}

export interface QueryResult {
  rows: Record<string, unknown>[];
  columnNames: string[];
  /** BigQuery type per column, aligned with columnNames; REPEATED adds a `[]` suffix. Absent when the schema is unavailable or misaligned. */
  columnTypes?: string[];
  totalRows: number;          // full result count from the results response (at least rows.length)
  bytesProcessed: number;
  truncated: boolean;         // true if the result holds more rows than were returned
}

export interface ResponseContext {
  responseId: string;
  threadTs: string;
  /** Conversation that owns `threadTs`. Absent on legacy records, which thread lookups never reuse. */
  channel?: string;
  statusMsgTs: string;
  surface?: 'slack' | 'whatsapp';
  clarifiedQuestion: string;
  /**
   * The user's own wording as given to the SQL supervisor, which clarification
   * may have narrowed. Refinements review against it (#44). Absent on legacy
   * records; readers fall back to `clarifiedQuestion`.
   */
  userQuestion?: string;
  assumptions: string[];
  reasoningChain: string;
  generatedSql: string;
  explanation: string;
  /**
   * The generator's one-line label for the answer, re-shown as the table
   * caption when the Table override re-renders. Omitted when empty and absent
   * on legacy records (Firestore rejects undefined).
   */
  headline?: string;
  /**
   * dbt unique keys (`project.dataset.table.column`; column lower-cased, table case kept) a verified
   * composition proof relied on (COUNT(DISTINCT) on a key, or a many-to-one
   * LEFT JOIN onto a keyed table), so the Table override re-verifies the same
   * shares. Omitted when no key was used and absent on legacy
   * records (Firestore rejects undefined).
   */
  compositionUniqueKeys?: string[];
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
  pipelineMode?: 'full_quality_loop' | 'routine_fast_path';
  supervisorDecision?: 'skipped' | 'required';
  supervisorTriggers?: string[];
  fastPathIneligibleReasons?: string[];
  failureHistory?: FailureRecord[];
  negativeFeedback?: boolean;
  schemaDetailsTrimmed?: boolean;
  retrievedSchema?: {
    name: string;
    description: string;
    columns: { name: string; description: string; dataType: string }[];
  }[];
}

export interface EscalationState {
  escalationId: string;
  originalThreadTs: string;
  originalChannel: string;
  pipelineState: 'awaiting_human' | 'resolving' | 'resolved' | 'timed_out';
  trigger: 'supervisor_exhausted' | 'mid_pipeline_ambiguity' | 'quality_loop_exhausted' | 'user_negative_feedback';
  behavior: 'best_effort_verify' | 'park_wait';
  stageToResume: 'sql_generation' | 'supervisor_review';
  context: {
    clarifiedQuestion: string;
    userQuestion: string;
    groundingCitations: GroundingCitation[];
    previousSql?: string;
    supervisorNotes?: string;
    ambiguityDescription?: string;
    feedbackReason?: string;
    feedbackUserId?: string;
  };
  escalationChannel: string;
  escalationTs: string;
  statusMsgTs: string;
  bestEffortSql?: string;
  createdAt: Date;
  expiresAt: Date;
  lastReminderAt?: Date;
  traceId: string;
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
