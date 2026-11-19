import { expect, it } from 'vitest';
import { resolveDbtArtifactPath } from '../../src/dbt/artifactPaths.js';

it('preserves absolute artifact paths outside the checkout', () => {
  expect(resolveDbtArtifactPath('/tmp/external/manifest.json', '/checkout')).toBe('/tmp/external/manifest.json');
});

it('resolves relative artifact paths against the working directory', () => {
  expect(resolveDbtArtifactPath('./dbt/catalog.json', '/checkout')).toBe('/checkout/dbt/catalog.json');
});

it('loads models from artifacts outside the checkout for absolute and relative configuration', async () => {
  const { mkdtempSync, copyFileSync, rmSync, readFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join, relative } = await import('node:path');
  const { parseDbtArtifacts } = await import('../../src/dbt/parser.js');
  const directory = mkdtempSync(join(tmpdir(), 'dbt-paths-'));
  try {
    for (const filename of ['manifest.json', 'catalog.json']) {
      copyFileSync(join(import.meta.dirname, '../fixtures', filename), join(directory, filename));
    }
    for (const base of [directory, relative(process.cwd(), directory)]) {
      const manifest = JSON.parse(readFileSync(resolveDbtArtifactPath(join(base, 'manifest.json')), 'utf8'));
      const catalog = JSON.parse(readFileSync(resolveDbtArtifactPath(join(base, 'catalog.json')), 'utf8'));
      expect(parseDbtArtifacts(manifest, catalog).length).toBeGreaterThan(0);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
