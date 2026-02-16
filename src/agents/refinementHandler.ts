import type { ResponseContext } from '../types.js';

export function buildRefinementInput(
  refinementText: string,
  previousCtx: ResponseContext,
): { compositeQuestion: string; previousSql: string } {
  return {
    compositeQuestion: `${previousCtx.clarifiedQuestion} (Refinement: ${refinementText})`,
    previousSql: previousCtx.generatedSql,
  };
}
