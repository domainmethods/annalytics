export interface CorpusEntry {
  id: string;
  question: string;
  category: 'simple' | 'join' | 'aggregate' | 'time_series' | 'ambiguous' | 'edge_case';
  source: 'manual' | 'production_positive' | 'production_negative' | 'escalation';
  expectedTables?: string[];
  knownGoodSql?: string;
  notes?: string;
}

export interface BenchmarkResult {
  corpusId: string;
  question: string;
  generatedSql: string | null;
  confidence: 'high' | 'medium' | 'low';
  qualityVerdict: 'pass' | 'fail_then_pass' | 'exhausted' | 'cost_exceeded';
  retryCount: number;
  validationResults: { l1: boolean; l2: boolean; l3: boolean; l4: boolean };
  bytesProcessed: number | null;
  supervisorNotes: string;
  teachingCompliance: string;
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
  corpusSize: number;
  results: BenchmarkResult[];
  judgeResults: JudgeResult[];
}
