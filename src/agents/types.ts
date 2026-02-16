export interface ClarificationResult {
  route: 'data_query' | 'dbt_status';
  confidence: 'high' | 'medium' | 'low';
  reasoning: string;
  ambiguities: string[];
  assumptions: string[];
  clarifying_questions: string[];
  resolved_question: string;
  follow_up_intent?: 'new_query' | 'refinement' | 'meta_question' | 'discrepancy';
}

export interface SupervisorVerdict {
  verdict: 'PASS' | 'FAIL';
  confidence: 'high' | 'medium' | 'low';
  issues: string[];
  suggestions: string[];
  teaching_compliance: 'compliant' | 'deviated' | 'no_relevant_teaching';
}

export interface GroundingCitation {
  sourceFile: string;
  chunkText: string;
  relevanceScore: number;
}
