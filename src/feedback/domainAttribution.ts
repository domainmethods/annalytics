export interface DomainMapEntry {
  /** A canonical table from a ReferenceCard, e.g. 'analytics.fct_orders'. */
  table: string;
  domain: string;
}

/** Dataset segment of a qualified table: 'a.b.c' -> 'b', 'a.b' -> 'a'. */
export function tableFallbackTag(table: string): string {
  const parts = table.split('.').filter(Boolean);
  if (parts.length >= 2) return parts[parts.length - 2];
  return parts[0] ?? 'unclassified';
}

/** Strip enclosing/embedded backticks and lowercase. `tablesUsed` comes from
 *  LLM output (untrusted boundary) and BigQuery is case-insensitive, so a raw
 *  `===` compare would miss `Analytics.FCT_Orders` or `` `analytics.fct_orders` ``. */
function normalizeTable(table: string): string {
  return table.replace(/`/g, '').toLowerCase();
}

/**
 * Coarse domain for a response, derived from the tables it touched.
 * Cards-first (any table that maps to a card domain wins), else the dataset
 * tag of the first table, else 'unclassified'.
 */
export function resolveDomain(tablesUsed: string[], domainMap: DomainMapEntry[]): string {
  if (tablesUsed.length === 0) return 'unclassified';
  for (const t of tablesUsed) {
    const clean = normalizeTable(t);
    const hit = domainMap.find((e) => normalizeTable(e.table) === clean);
    if (hit) return hit.domain;
  }
  return tableFallbackTag(normalizeTable(tablesUsed[0]));
}
