/** Resolve legacy dataset.table references only against an unambiguous inventory. */
export function matchesRelation(reference: string, relations: Iterable<string>): boolean {
  const normalize = (value: string) => value.replace(/[`\s]/g, '').toLowerCase();
  const ref = normalize(reference);
  const names = [...new Set([...relations].map(normalize))];
  if (names.includes(ref)) return true;
  const candidates = names.filter(name => ref.split('.').length === 2 && name.endsWith(`.${ref}`));
  return candidates.length === 1;
}
