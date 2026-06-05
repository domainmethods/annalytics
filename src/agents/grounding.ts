import type { GroundingCitation } from './types.js';

type RetrievedContext = {
  uri?: unknown;
  title?: unknown;
  text?: unknown;
  score?: unknown;
};

export function extractGroundingCitations(response: unknown): GroundingCitation[] {
  try {
    const candidate = response as {
      candidates?: Array<{
        groundingMetadata?: {
          groundingChunks?: unknown[];
        };
      }>;
    };
    const chunks = candidate.candidates?.[0]?.groundingMetadata?.groundingChunks;
    if (!Array.isArray(chunks)) return [];
    return chunks
      .filter(hasRetrievedContext)
      .map(chunk => {
        const retrievedContext = chunk.retrievedContext;
        return {
          sourceFile: citationSourceFile(retrievedContext),
          chunkText: typeof retrievedContext.text === 'string' ? retrievedContext.text : '',
          relevanceScore: typeof retrievedContext.score === 'number' ? retrievedContext.score : 1.0,
        };
      });
  } catch {
    return [];
  }
}

export function extractReferenceIdsFromCitations(
  citations: Pick<GroundingCitation, 'sourceFile' | 'chunkText'>[],
): string[] {
  const ids = new Set<string>();
  for (const citation of citations) {
    const sourceMatch = citation.sourceFile.match(/reference_card:([a-z0-9-]+)/i);
    if (sourceMatch) ids.add(sourceMatch[1]);

    const chunkMatch = citation.chunkText.match(/ReferenceCard:\s*([a-z0-9-]+)/i);
    if (chunkMatch) ids.add(chunkMatch[1]);
  }
  return [...ids].sort();
}

export function citationSourceFile(retrievedContext: RetrievedContext): string {
  const uri = retrievedContext.uri;
  if (typeof uri === 'string' && uri.trim()) return uri;

  const title = retrievedContext.title;
  if (typeof title === 'string' && title.trim()) return title;

  const text = retrievedContext.text;
  if (typeof text !== 'string') return '';

  const referenceMatch = text.match(/ReferenceCard:\s*([a-z0-9-]+)/i);
  if (referenceMatch) return `reference_card:${referenceMatch[1]}`;

  const teachingMatch = text.match(/Teaching:\s*([a-z0-9-]+)/i);
  if (teachingMatch) return `teaching:${teachingMatch[1]}`;

  return '';
}

function hasRetrievedContext(value: unknown): value is { retrievedContext: RetrievedContext } {
  return (
    typeof value === 'object'
    && value !== null
    && 'retrievedContext' in value
    && typeof (value as { retrievedContext?: unknown }).retrievedContext === 'object'
    && (value as { retrievedContext?: unknown }).retrievedContext !== null
  );
}
