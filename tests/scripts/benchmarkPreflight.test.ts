import { describe, it, expect } from 'vitest';
import { validateGenerateContentModels } from '../../scripts/benchmarkPreflight.js';

describe('benchmark model preflight', () => {
  it('accepts model names that support generateContent with or without the models/ prefix', () => {
    const errors = validateGenerateContentModels({
      requiredModels: ['gemini-flash-latest', 'models/gemini-pro-latest'],
      availableModels: [
        { name: 'models/gemini-flash-latest', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/gemini-pro-latest', supportedGenerationMethods: ['generateContent', 'countTokens'] },
      ],
    });

    expect(errors).toEqual([]);
  });

  it('rejects missing models before benchmark corpus execution', () => {
    const errors = validateGenerateContentModels({
      requiredModels: ['gemini-3.0-flash'],
      availableModels: [
        { name: 'models/gemini-flash-latest', supportedGenerationMethods: ['generateContent'] },
      ],
    });

    expect(errors).toEqual([
      'Gemini model "gemini-3.0-flash" is not available for generateContent',
    ]);
  });

  it('rejects models that exist but do not support generateContent', () => {
    const errors = validateGenerateContentModels({
      requiredModels: ['gemini-embed'],
      availableModels: [
        { name: 'models/gemini-embed', supportedGenerationMethods: ['embedContent'] },
      ],
    });

    expect(errors).toEqual([
      'Gemini model "gemini-embed" is not available for generateContent',
    ]);
  });

  it('accepts SDK model objects that report supportedActions', () => {
    const errors = validateGenerateContentModels({
      requiredModels: ['gemini-flash-latest'],
      availableModels: [
        { name: 'models/gemini-flash-latest', supportedActions: ['generateContent', 'countTokens'] },
      ],
    });

    expect(errors).toEqual([]);
  });
});
