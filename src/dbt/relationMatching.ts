/** Normalize warehouse identifier quoting and whitespace. */
export function normalizeRelation(value: string): string {
  return value.replace(/[`"\s]/g, '').toLowerCase();
}

/** Resolve legacy names against the complete advertised inventory before comparing. */
export function matchesRelation(reference: string, relations: Iterable<string>, inventory: Iterable<string> = relations): boolean {
  const names = [...new Set([...inventory].map(normalizeRelation))];
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
