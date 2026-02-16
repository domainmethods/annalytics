export interface Teaching {
  id: string;
  question_patterns: string[];
  sanctioned_sql: string | null;
  reasoning: string;
  models_referenced: string[];
  tags: string[];
  author: string;
  updated: string; // ISO date string
}

export interface TeachingFile {
  teachings: Teaching[];
}

export interface TeachingSummary {
  term: string;
  definition: string;
  canonical_table: string;
}
