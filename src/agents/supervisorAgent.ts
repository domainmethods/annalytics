import { GoogleGenAI } from '@google/genai';
import { z } from 'zod';
import { toJSONSchema } from 'zod/v4/core';
import type { SupervisorVerdict, GroundingCitation } from './types.js';
import { generateForNode } from './modelGateway.js';

const SupervisorSchema = z.object({
  verdict: z.enum(['PASS', 'FAIL']),
  confidence: z.enum(['high', 'medium', 'low']),
  issues: z.array(z.string()),
  suggestions: z.array(z.string()),
  teaching_compliance: z.enum(['compliant', 'deviated', 'no_relevant_teaching']),
});

export interface SupervisorInput {
  userQuestion: string;
  clarifiedQuestion: string;
  generatedSql: string;
  explanation: string;
  reasoningChain: string;
  groundingCitations: GroundingCitation[];
  apiKey: string;
  dryRunMetadata?: {
    bytesProcessed: number;
  };
}

export async function reviewSql(input: SupervisorInput): Promise<SupervisorVerdict> {
  const ai = new GoogleGenAI({ apiKey: input.apiKey });

  const prompt = buildSupervisorPrompt(input);

  const response = await generateForNode('supervisor', ai, {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    config: {
      systemInstruction: 'You are a senior data analyst reviewing a generated SQL query. Be specific about issues and suggestions.',
      responseMimeType: 'application/json',
      responseJsonSchema: toJSONSchema(SupervisorSchema),
    },
  });

  const text = response.text;
  if (!text) throw new Error('Empty response from Gemini');

  const parsed = JSON.parse(text);

  // Runtime validation
  if (parsed.verdict !== 'PASS' && parsed.verdict !== 'FAIL') {
    throw new Error(`Invalid verdict: ${String(parsed.verdict)}`);
  }

  return parsed as SupervisorVerdict;
}

function buildSupervisorPrompt(input: SupervisorInput): string {
  const teachingContext = input.groundingCitations.length > 0
    ? input.groundingCitations.map(c =>
        `[Source: ${c.sourceFile}]\n${c.chunkText}`
      ).join('\n\n')
    : 'No relevant teachings found for this question.';

  return `ORIGINAL QUESTION: ${input.userQuestion}
CLARIFIED QUESTION: ${input.clarifiedQuestion}

RELEVANT TEACHINGS (from Primary Agent's File Search citations):
${teachingContext}

GENERATED SQL:
${input.generatedSql}

EXPLANATION:
${input.explanation}

REASONING CHAIN:
${input.reasoningChain}

REVIEW CHECKLIST:
1. Does the SQL correctly answer the question?
2. Are the right tables and columns used?
3. If teachings exist for this topic, does the SQL follow them?
4. ReferenceCard compliance checks when retrieved ReferenceCard context exists:
   - Are the canonical table and grain followed?
   - Are required filters present?
   - Are exclusions and avoid tables respected?
   - Are aliases and routing triggers interpreted faithfully?
   - If a mart-level metric is available, did the query avoid reconstructing it from lower-grain sources?
5. Preserve metric and dimension fidelity. Do not approve substituting a broader category for a narrower user term.
6. Contradicting retrieved ReferenceCard constraints is a FAIL unless the SQL cannot answer the question otherwise and the explanation clearly says why.
7. Are the joins correct?
8. Are there missing WHERE clauses or filters that should exist?
9. Is the explanation accurate and matches the SQL?
10. Are the stated assumptions reasonable and valid?
11. Is the query safe (no DML/DDL, no unbounded scans, no sensitive data exposure)?
12. If the query uses ML.* functions:
   - Is the function appropriate for the user's question?
   - Are parameters reasonable (e.g., forecast horizon isn't absurdly large)?
   - Is the referenced model likely to exist in the dataset context?

${buildValidationContext(input)}Respond with your verdict.`;
}

function formatBytesAsGb(bytes: number): string {
  const gb = bytes / (1024 * 1024 * 1024);
  return `${gb.toFixed(2)} GB`;
}

function buildValidationContext(input: SupervisorInput): string {
  if (!input.dryRunMetadata) return '\n';

  return `
VALIDATION CONTEXT:
- BigQuery dry-run confirmed this query is syntactically valid
- Estimated scan size: ${formatBytesAsGb(input.dryRunMetadata.bytesProcessed)}

`;
}
