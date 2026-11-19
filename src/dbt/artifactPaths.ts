import { resolve } from 'node:path';

export function resolveDbtArtifactPath(path: string, cwd = process.cwd()): string {
  return resolve(cwd, path);
}
