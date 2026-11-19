import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const readme = readFileSync(new URL('../../README.md', import.meta.url), 'utf8');
const envExample = readFileSync(new URL('../../.env.example', import.meta.url), 'utf8');

function configRow(name: string): string {
  const row = readme.split('\n').find((line) => line.startsWith(`| \`${name}\` |`));
  expect(row, `README configuration table row for ${name}`).toBeDefined();
  return row as string;
}

describe('model-control documentation', () => {
  it('documents the serving overrides in the configuration table', () => {
    expect(configRow('NODE_PROFILE_OVERRIDES')).toMatch(/serving generation/i);
    expect(configRow('MODEL_ID_OVERRIDES')).toMatch(/model ID/i);
  });

  it('marks the legacy aliases as not selecting serving models', () => {
    expect(configRow('GEMINI_MODEL')).toMatch(/ignored by serving nodes/i);
    expect(configRow('GEMINI_FLASH_MODEL')).toMatch(/ignored by serving nodes/i);
  });

  it('lists every thinking level NODE_PROFILE_OVERRIDES accepts in .env.example', () => {
    expect(envExample).toContain('default|minimal|low|medium|high');
  });
});
