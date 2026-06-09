import type { ValidationLayerRecord } from '../src/qualityLoop.js';

export interface CorpusEntry {
  id: string;
  question: string;
  category: 'simple' | 'join' | 'aggregate' | 'time_series' | 'ambiguous' | 'edge_case';
  source: 'manual' | 'production_positive' | 'production_negative' | 'escalation';
  expectedTables?: string[];
  expectedTeachingIds?: string[];
  expectedReferenceIds?: string[];
  expectedSqlContains?: string[];
  expectedClarificationConfidence?: 'high' | 'medium' | 'low';
  knownGoodSql?: string;
  notes?: string;
}

export interface BenchmarkMetadata {
  runId: string;
  runStartedAt: string;
  gitSha: string | null;
  gitDirty: boolean;
  packageVersion: string;
  corpusHash: string;
  dbtManifestHash: string | null;
  dbtCatalogHash: string | null;
  geminiModel: string | null;
  judgeModel: string | null;
  fileSearchStoreId: string | null;
  gcpProjectId: string | null;
}

export interface BenchmarkResult {
  corpusId: string;
  question: string;
  generatedSql: string | null;
  confidence: 'high' | 'medium' | 'low';
  qualityVerdict: 'pass' | 'fail_then_pass' | 'exhausted' | 'cost_exceeded';
  pipelineMode?: 'full_quality_loop' | 'routine_fast_path';
  supervisorDecision?: 'skipped' | 'required';
  supervisorTriggers?: string[];
  fastPathIneligibleReasons?: string[];
  retryCount: number;
  validationResults: { l1: boolean; l2: boolean; l3: boolean; l4: boolean };
  validationHistory?: ValidationLayerRecord[];   // NEW: full per-attempt trace
  bytesProcessed: number | null;
  supervisorNotes: string;
  teachingCompliance: string;
  expectedTeachingIds?: string[];
  observedTeachingIds: string[];
  teachingRetrievalPassed: boolean | null;
  expectedReferenceIds?: string[];
  observedReferenceIds: string[];
  referenceRetrievalPassed: boolean | null;
  referenceProbeReferenceIds?: string[];
  sqlGroundingReferenceIds?: string[];
  referenceProbeCitations?: string[];
  referenceRetrievalSource?: 'explicit_probe' | 'sql_grounding' | 'none';
  referenceProbeError?: string;
  expectedTables?: string[];
  observedTables: string[];
  tableSelectionPassed: boolean | null;
  expectedSqlContains?: string[];
  sqlShapePassed: boolean | null;
  expectedClarificationConfidence?: 'high' | 'medium' | 'low';
  clarificationPassed: boolean | null;
  latencyMs: {
    clarification: number;
    generation: number;
    validation: number;
    supervisor: number;
    total: number;
  };
  groundingCitations: string[];
}

export interface JudgeResult {
  corpusId: string;
  scores: {
    correctness: number;
    efficiency: number;
    readability: number;
    teachingCompliance: number;
    safety: number;
  };
  overallScore: number;
  rationale: string;
  suggestedImprovement?: string;
  flaggedForReview: boolean;
}

export interface BenchmarkRun {
  runDate: string;
  metadata: BenchmarkMetadata;
  corpusSize: number;
  results: BenchmarkResult[];
  judgeResults: JudgeResult[];
}
