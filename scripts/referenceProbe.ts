import { GoogleGenAI } from '@google/genai';
import { extractGroundingCitations, extractReferenceIdsFromCitations } from '../src/agents/grounding.js';

export interface ReferenceProbeOptions {
  question: string;
  apiKey: string;
  fileSearchStoreId: string;
  model: string;
}

export interface ReferenceProbeResult {
  referenceIds: string[];
  citations: string[];
  error?: string;
}

const referenceProbeJsonSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object' as const,
  properties: {
    reference_ids: {
      type: 'array',
      items: { type: 'string' },
      description: 'ReferenceCard IDs relevant to the question, without the reference_card: prefix',
    },
    rationale: {
      type: 'string',
      description: 'Brief explanation of why the retrieved ReferenceCards apply',
    },
  },
  required: ['reference_ids', 'rationale'],
};

export async function probeReferenceCards(options: ReferenceProbeOptions): Promise<ReferenceProbeResult> {
  if (!options.fileSearchStoreId.trim()) {
    return {
      referenceIds: [],
      citations: [],
      error: 'Reference probe skipped: FILE_SEARCH_STORE_ID is missing',
    };
  }

  try {
    const ai = new GoogleGenAI({ apiKey: options.apiKey });
    const response = await ai.models.generateContent({
      model: options.model,
      contents: [{
        role: 'user',
        parts: [{ text: buildReferenceProbePrompt(options.question) }],
      }],
      config: {
        systemInstruction: [
          'You identify synced ReferenceCard documents relevant to benchmark questions.',
          'Use Gemini File Search retrieval context and cite retrieved ReferenceCard chunks.',
          'Do not infer ReferenceCard IDs from schema names, prompt wording, or prior knowledge.',
          'Return only JSON matching the requested schema.',
        ].join(' '),
        responseMimeType: 'application/json',
        responseJsonSchema: referenceProbeJsonSchema,
        tools: [{
          fileSearch: {
            fileSearchStoreNames: [options.fileSearchStoreId],
          },
        }],
      },
    });

    const citations = extractGroundingCitations(response);
    const referenceIds = extractReferenceIdsFromCitations(citations);
    const parseError = validateProbeJson(response.text);

    return {
      referenceIds,
      citations: citations.map(citation => citation.sourceFile).filter(Boolean),
      ...(parseError ? { error: parseError } : {}),
    };
  } catch (err) {
    return {
      referenceIds: [],
      citations: [],
      error: `Reference probe failed: ${sanitizeProbeError(
        err,
        options.apiKey,
        options.fileSearchStoreId,
      )}`,
    };
  }
}

function buildReferenceProbePrompt(question: string): string {
  return [
    'Find any ReferenceCard documents that should govern this benchmark question.',
    'Only include ReferenceCard IDs that are supported by retrieved File Search chunks.',
    'If no ReferenceCard applies, return an empty reference_ids array.',
    '',
    `Question: ${question}`,
    '',
    'Return JSON: {"reference_ids":["example-card-id"],"rationale":"brief reason"}.',
  ].join('\n');
}

function validateProbeJson(text: string | undefined): string | undefined {
  if (!text) return 'Reference probe returned empty JSON response';

  try {
    const parsed = JSON.parse(text) as { reference_ids?: unknown; rationale?: unknown };
    if (
      !Array.isArray(parsed.reference_ids)
      || !parsed.reference_ids.every(item => typeof item === 'string')
      || typeof parsed.rationale !== 'string'
    ) {
      return 'Reference probe returned malformed JSON response';
    }
    return undefined;
  } catch {
    return 'Reference probe returned malformed JSON response';
  }
}

function sanitizeProbeError(error: unknown, apiKey: string, fileSearchStoreId: string): string {
  let message = error instanceof Error ? error.message : String(error);
  for (const value of [apiKey, fileSearchStoreId]) {
    if (value) {
      message = message.split(value).join('[redacted]');
    }
  }
  return message
    .replace(/AIza[0-9A-Za-z_-]+/g, '[redacted-secret]')
    .slice(0, 500);
}
