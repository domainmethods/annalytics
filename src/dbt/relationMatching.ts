/** Normalize warehouse identifier quoting and whitespace. */
export function normalizeRelation(value: string): string {
  return value.replace(/[`"\s]/g, '').toLowerCase();
}

/** Resolve legacy names against the complete advertised inventory before comparing. */
export function matchesRelation(reference: string, relations: Iterable<string>, inventory: Iterable<string> = relations): boolean {
  const normalized = [...new Set([...inventory].map(normalizeRelation))];
  // A legacy suffix represents the same physical candidates, never an extra relation.
  const names = normalized.filter(name => name.split('.').length !== 2
    || !normalized.some(candidate => candidate.split('.').length === 3 && candidate.endsWith(`.${name}`)));
  const resolve = (value: string): string | null => {
    const name = normalizeRelation(value);
    const parts = name.split('.');
    const candidates = names.filter(candidate => candidate === name || (parts.length === 2 && candidate.endsWith(`.${name}`)));
    if (candidates.length === 1) return candidates[0];
    return candidates.length === 0 && parts.length === 3 && parts.every(Boolean) ? name : null;
  };
  const target = resolve(reference);
  return target !== null && [...relations].some(name => resolve(name) === target);
}
