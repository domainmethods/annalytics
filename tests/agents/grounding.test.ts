import { describe, expect, it } from 'vitest';
import {
  citationSourceFile,
  extractGroundingCitations,
  extractReferenceIdsFromCitations,
  extractTeachingIdsFromCitations,
} from '../../src/agents/grounding.js';

describe('grounding extraction', () => {
  it('extracts retrieved contexts from Gemini grounding metadata', () => {
    const citations = extractGroundingCitations({
      candidates: [{
        groundingMetadata: {
          groundingChunks: [
            {
              retrievedContext: {
                uri: 'reference_card:revenue-canonical-definition',
                text: 'Use completed orders',
                score: 0.7,
              },
            },
            { web: { uri: 'https://example.com' } },
          ],
        },
      }],
    });

    expect(citations).toEqual([{
      sourceFile: 'reference_card:revenue-canonical-definition',
      chunkText: 'Use completed orders',
      relevanceScore: 0.7,
    }]);
  });

  it('derives source names from markdown headers when uri is missing', () => {
    expect(citationSourceFile({
      text: '# ReferenceCard: revenue-monthly-grain\nDomain: revenue',
    })).toBe('reference_card:revenue-monthly-grain');

    expect(citationSourceFile({
      text: '# Teaching: revenue-clean-room\nUse sanctioned tables',
    })).toBe('teaching:revenue-clean-room');
  });

  it('extracts sorted ReferenceCard IDs from source names and chunk text', () => {
    expect(extractReferenceIdsFromCitations([
      {
        sourceFile: 'reference_card:revenue-canonical-definition',
        chunkText: 'Canonical revenue',
      },
      {
        sourceFile: 'file-123',
        chunkText: '# ReferenceCard: revenue-monthly-grain\nMonthly revenue',
      },
    ])).toEqual([
      'revenue-canonical-definition',
      'revenue-monthly-grain',
    ]);
  });

  it('extracts teaching ids from source files and chunk text', () => {
    expect(extractTeachingIdsFromCitations([
      { sourceFile: 'teaching:revenue-grain', chunkText: '' },
      { sourceFile: 'x', chunkText: 'Teaching: session-window' },
      { sourceFile: 'reference_card:rev-001', chunkText: '' },  // not a teaching
    ])).toEqual(['revenue-grain', 'session-window']);
  });
});
