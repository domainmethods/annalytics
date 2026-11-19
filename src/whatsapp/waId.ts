export function normalizeWaId(value: string): string {
  return value.replace(/[+\s.()-]/g, '');
}
