import { GoogleGenAI } from '@google/genai';
import type { CorpusEntry } from './benchmark-types.js';

export interface GeminiModelInfo {
  name?: string;
  supportedGenerationMethods?: string[];
  supportedActions?: string[];
}

export interface ModelValidationInput {
  requiredModels: string[];
  availableModels: GeminiModelInfo[];
}

export interface BenchmarkAcceptanceInputValidation {
  corpus: CorpusEntry[];
  fileSearchStoreId?: string | null;
  manifestExists: boolean;
  catalogExists: boolean;
}

function normalizeModelName(name: string): string {
  return name.replace(/^models\//, '');
}

export function validateGenerateContentModels(input: ModelValidationInput): string[] {
  const available = new Set(
    input.availableModels
      .filter(model =>
        model.name &&
        (
          model.supportedGenerationMethods?.includes('generateContent') ||
          model.supportedActions?.includes('generateContent')
        )
      )
      .flatMap(model => {
        const name = model.name!;
        return [name, normalizeModelName(name)];
      }),
  );

  return [...new Set(input.requiredModels)]
    .filter(model => !available.has(model) && !available.has(normalizeModelName(model)))
    .map(model => `Gemini model "${model}" is not available for generateContent`);
}

export async function listGeminiModels(apiKey: string): Promise<GeminiModelInfo[]> {
  const ai = new GoogleGenAI({ apiKey });
  const pager = await ai.models.list({ config: { pageSize: 100 } });
  const models: GeminiModelInfo[] = [];
  for await (const model of pager) {
    models.push({
      name: model.name,
      supportedGenerationMethods: model.supportedGenerationMethods,
      supportedActions: model.supportedActions,
    });
  }
  return models;
}

export async function assertGenerateContentModelsAvailable(
  apiKey: string,
  requiredModels: string[],
): Promise<void> {
  const availableModels = await listGeminiModels(apiKey);
  const errors = validateGenerateContentModels({ requiredModels, availableModels });
  if (errors.length > 0) {
    throw new Error(`Benchmark preflight failed:\n${errors.map(error => `- ${error}`).join('\n')}`);
  }
}

export function validateBenchmarkAcceptanceInputs(
  input: BenchmarkAcceptanceInputValidation,
): string[] {
  const expectsReferenceCards = input.corpus.some(
    entry => (entry.expectedReferenceIds?.length ?? 0) > 0,
  );
  const validatesTablesOrSql = input.corpus.some(
    entry =>
      (entry.expectedTables?.length ?? 0) > 0 ||
      (entry.expectedSqlContains?.length ?? 0) > 0,
  );
  const errors: string[] = [];

  if (expectsReferenceCards && !input.fileSearchStoreId) {
    errors.push('FILE_SEARCH_STORE_ID is required because benchmark corpus expects ReferenceCard retrieval');
  }

  if (validatesTablesOrSql && !input.manifestExists) {
    errors.push('dbt manifest is required because benchmark corpus validates table selection or SQL shape');
  }

  if (validatesTablesOrSql && !input.catalogExists) {
    errors.push('dbt catalog is required because benchmark corpus validates table selection or SQL shape');
  }

  return errors;
}
