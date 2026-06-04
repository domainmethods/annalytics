import { GoogleGenAI } from '@google/genai';

export interface GeminiModelInfo {
  name?: string;
  supportedGenerationMethods?: string[];
  supportedActions?: string[];
}

export interface ModelValidationInput {
  requiredModels: string[];
  availableModels: GeminiModelInfo[];
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
