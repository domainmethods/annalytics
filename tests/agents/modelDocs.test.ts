import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('documents serving overrides and separates legacy aliases', () => {
  const readme = readFileSync(new URL('../../README.md', import.meta.url), 'utf8');
  expect(readme).toContain('NODE_PROFILE_OVERRIDES');
  expect(readme).toContain('MODEL_ID_OVERRIDES');
  expect(readme).not.toContain('SQL generation and supervisor model');
  expect(readme).not.toContain('Lightweight classification and summary model');
});
