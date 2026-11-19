/** Normalize warehouse identifier quoting and whitespace. */
export function normalizeRelation(value: string): string {
  return value.replace(/[`"\s]/g, '').toLowerCase();
}

/** Resolve legacy names against the complete advertised inventory before comparing. */
export function matchesRelation(reference: string, relations: Iterable<string>, inventory: Iterable<string> = relations): boolean {
  const ref = normalizeRelation(reference);
  const names = [...new Set([...inventory].map(normalizeRelation))];
  const candidates = names.filter(name => name === ref || (ref.split('.').length === 2 && name.endsWith(`.${ref}`)));
  return candidates.length === 1 && [...relations].some(name => normalizeRelation(name) === candidates[0]);
}
