import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('agents module boundaries', () => {
  it('does not import the root logger directly', () => {
    const agentsDir = new URL('../../src/agents/', import.meta.url);
    const offenders = readdirSync(agentsDir)
      .filter((name) => name.endsWith('.ts'))
      .filter((name) => {
        const source = readFileSync(join(agentsDir.pathname, name), 'utf-8');
        return /from\s+['"]\.\.\/logging/.test(source);
      });

    expect(offenders).toEqual([]);
  });
});
