import type { ResponseContext } from '../types.js';

/**
 * `compositeQuestion` drives SQL generation from the previous clarified
 * question; `originalQuestion` gives the supervisor the user's own wording,
 * which clarification may have narrowed (#44). Legacy contexts without a
 * stored `userQuestion` fall back to the clarified text.
 */
export function buildRefinementInput(
  refinementText: string,
  previousCtx: ResponseContext,
): { compositeQuestion: string; originalQuestion: string; previousSql: string } {
  const refinement = `(Refinement: ${refinementText})`;
  return {
    compositeQuestion: `${previousCtx.clarifiedQuestion} ${refinement}`,
    originalQuestion: `${previousCtx.userQuestion ?? previousCtx.clarifiedQuestion} ${refinement}`,
    previousSql: previousCtx.generatedSql,
  };
}
