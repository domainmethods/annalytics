const TOTAL_LIKE_RE = /^\s*(total|grand total|all|overall|\(all\)|sum)\s*$/i;

/**
 * True for a dimension label that names the whole rather than a part ("Total",
 * "All", "Overall"). Shared by the share proof (R5) and the answer caption, so a
 * grand-total row appended by UNION ALL is never a part and never "the highest".
 */
export function isTotalLikeLabel(label: string): boolean {
  return TOTAL_LIKE_RE.test(label);
}
