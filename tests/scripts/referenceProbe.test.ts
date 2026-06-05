import { beforeEach, describe, expect, it, vi } from 'vitest';
import { probeReferenceCards } from '../../scripts/referenceProbe.js';

const mockGenerateContent = vi.fn();

vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    models = { generateContent: mockGenerateContent };
  },
}));

describe('probeReferenceCards', () => {
  beforeEach(() => {
    mockGenerateContent.mockReset();
  });

  it('returns ReferenceCard IDs supported by File Search citations', async () => {
    mockGenerateContent.mockResolvedValue({
      text: JSON.stringify({
        reference_ids: ['revenue-canonical-definition'],
        rationale: 'Revenue question',
      }),
      candidates: [{
        groundingMetadata: {
          groundingChunks: [{
            retrievedContext: {
              uri: '',
              text: '# ReferenceCard: revenue-canonical-definition\nCanonical table: analytics.fct_orders',
              score: 0.9,
            },
          }],
        },
      }],
    });

    const result = await probeReferenceCards({
      question: 'total revenue last month',
      apiKey: 'api-key',
      fileSearchStoreId: 'fileSearchStores/revenue',
      model: 'gemini-pro-latest',
    });

    expect(result).toEqual({
      referenceIds: ['revenue-canonical-definition'],
      citations: ['reference_card:revenue-canonical-definition'],
    });
    const call = mockGenerateContent.mock.calls[0][0];
    expect(call.config.tools[0].fileSearch.fileSearchStoreNames).toEqual([
      'fileSearchStores/revenue',
    ]);
    expect(call.contents[0].parts[0].text).toContain('total revenue last month');
  });

  it('returns empty evidence when File Search retrieves no ReferenceCards', async () => {
    mockGenerateContent.mockResolvedValue({
      text: JSON.stringify({
        reference_ids: [],
        rationale: 'No matching ReferenceCard',
      }),
      candidates: [{ groundingMetadata: { groundingChunks: [] } }],
    });

    await expect(probeReferenceCards({
      question: 'unrelated question',
      apiKey: 'api-key',
      fileSearchStoreId: 'fileSearchStores/revenue',
      model: 'gemini-pro-latest',
    })).resolves.toEqual({
      referenceIds: [],
      citations: [],
    });
  });

  it('unions cited ReferenceCards across bounded probe attempts', async () => {
    mockGenerateContent
      .mockResolvedValueOnce({
        text: JSON.stringify({
          reference_ids: [],
          rationale: 'No citation on first attempt',
        }),
        candidates: [{ groundingMetadata: { groundingChunks: [] } }],
      })
      .mockResolvedValueOnce({
        text: JSON.stringify({
          reference_ids: ['revenue-monthly-grain'],
          rationale: 'Second attempt retrieved the governing card',
        }),
        candidates: [{
          groundingMetadata: {
            groundingChunks: [{
              retrievedContext: {
                text: '# ReferenceCard: revenue-monthly-grain\nMonthly revenue',
              },
            }],
          },
        }],
      });

    const result = await probeReferenceCards({
      question: 'monthly revenue',
      apiKey: 'api-key',
      fileSearchStoreId: 'fileSearchStores/revenue',
      model: 'gemini-pro-latest',
    });

    expect(mockGenerateContent).toHaveBeenCalledTimes(2);
    expect(result.referenceIds).toEqual(['revenue-monthly-grain']);
    expect(result.citations).toEqual(['reference_card:revenue-monthly-grain']);
  });

  it('records malformed JSON without discarding cited ReferenceCards', async () => {
    mockGenerateContent.mockResolvedValue({
      text: 'not json',
      candidates: [{
        groundingMetadata: {
          groundingChunks: [{
            retrievedContext: {
              text: '# ReferenceCard: revenue-monthly-grain\nMonthly revenue',
            },
          }],
        },
      }],
    });

    const result = await probeReferenceCards({
      question: 'monthly revenue',
      apiKey: 'api-key',
      fileSearchStoreId: 'fileSearchStores/revenue',
      model: 'gemini-pro-latest',
    });

    expect(result.referenceIds).toEqual(['revenue-monthly-grain']);
    expect(result.citations).toEqual(['reference_card:revenue-monthly-grain']);
    expect(result.error).toBe('Reference probe returned malformed JSON response');
  });

  it('returns a redacted error when the File Search probe fails', async () => {
    mockGenerateContent.mockRejectedValue(
      new Error('failed for api-key and fileSearchStores/revenue with AIzaExampleSecret'),
    );

    const result = await probeReferenceCards({
      question: 'revenue?',
      apiKey: 'api-key',
      fileSearchStoreId: 'fileSearchStores/revenue',
      model: 'gemini-pro-latest',
    });

    expect(result.referenceIds).toEqual([]);
    expect(result.citations).toEqual([]);
    expect(result.error).toContain('Reference probe failed:');
    expect(result.error).not.toContain('api-key');
    expect(result.error).not.toContain('fileSearchStores/revenue');
    expect(result.error).not.toContain('AIzaExampleSecret');
  });
});
