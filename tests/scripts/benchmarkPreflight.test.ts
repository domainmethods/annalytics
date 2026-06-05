import { describe, it, expect } from 'vitest';
import {
  validateBenchmarkAcceptanceInputs,
  validateGenerateContentModels,
} from '../../scripts/benchmarkPreflight.js';

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

describe('benchmark acceptance input preflight', () => {
  it('requires File Search when corpus expects reference-card retrieval', () => {
    const errors = validateBenchmarkAcceptanceInputs({
      corpus: [{
        id: 'revenue-ref-001',
        question: 'What was revenue?',
        category: 'simple',
        source: 'manual',
        expectedReferenceIds: ['revenue-canonical-definition'],
      }],
      fileSearchStoreId: undefined,
      manifestExists: true,
      catalogExists: true,
    });

    expect(errors).toEqual([
      'FILE_SEARCH_STORE_ID is required because benchmark corpus expects ReferenceCard retrieval',
    ]);
  });

  it('requires dbt artifacts when corpus validates table selection or SQL shape', () => {
    const errors = validateBenchmarkAcceptanceInputs({
      corpus: [{
        id: 'revenue-ref-002',
        question: 'Monthly revenue',
        category: 'time_series',
        source: 'manual',
        expectedTables: ['analytics.fct_orders'],
        expectedSqlContains: ['DATE_TRUNC'],
      }],
      fileSearchStoreId: 'fileSearchStores/revenue',
      manifestExists: false,
      catalogExists: false,
    });

    expect(errors).toEqual([
      'dbt manifest is required because benchmark corpus validates table selection or SQL shape',
      'dbt catalog is required because benchmark corpus validates table selection or SQL shape',
    ]);
  });

  it('allows lightweight corpus cases without File Search or dbt artifacts', () => {
    const errors = validateBenchmarkAcceptanceInputs({
      corpus: [{
        id: 'seed-ambiguous',
        question: 'revenue',
        category: 'ambiguous',
        source: 'manual',
        expectedClarificationConfidence: 'low',
      }],
      fileSearchStoreId: undefined,
      manifestExists: false,
      catalogExists: false,
    });

    expect(errors).toEqual([]);
  });
});
