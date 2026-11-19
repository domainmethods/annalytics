import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const tsx = createRequire(import.meta.url).resolve('tsx/cli');
const judgePath = fileURLToPath(new URL('../../scripts/benchmark-judge.ts', import.meta.url));
const validCorpus = '[{"id":"q1","question":"Example","category":"simple","source":"manual"}]';
const hash = (raw: string) => createHash('sha256').update(raw).digest('hex');

describe('benchmark judge corpus validation', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'benchmark-judge-'));
    mkdirSync(join(root, 'benchmarks'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function runJudge(corpusRaw: string | undefined, corpusHash: string | undefined) {
    if (corpusRaw !== undefined) {
      writeFileSync(join(root, 'benchmarks', 'corpus.json'), corpusRaw);
    }
    const results = JSON.stringify({ runDate: '2026-01-01', metadata: { corpusHash }, results: [] });
    const resultsPath = join(root, 'results.json');
    writeFileSync(resultsPath, results);

    const child = spawnSync(process.execPath, [tsx, judgePath, resultsPath], {
      cwd: root,
      env: { ...process.env, GEMINI_API_KEY: 'unused-test-key' },
      encoding: 'utf8',
      timeout: 10_000,
    });
    expect(child.error).toBeUndefined();
    expect(readFileSync(resultsPath, 'utf8')).toBe(results);
    return child;
  }

  it.each([
    { name: 'missing hash', raw: validCorpus, hash: undefined, message: 'no recorded corpusHash' },
    { name: 'missing file', raw: undefined, hash: hash(validCorpus), message: 'Could not load corpus' },
    { name: 'invalid JSON', raw: '[', hash: hash('['), message: 'Could not load corpus' },
    { name: 'non-array JSON', raw: '{}', hash: hash('{}'), message: 'Expected a JSON array' },
    {
      name: 'hash mismatch',
      raw: validCorpus,
      hash: hash('[]'),
      message: "does not match this run's recorded corpusHash",
    },
  ])('aborts before judging on $name', ({ raw, hash: recordedHash, message }) => {
    const result = runJudge(raw, recordedHash);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(message);
    expect(result.stdout).not.toContain('Judging');
  }, 12_000);

  it('accepts the exact recorded corpus', () => {
    const result = runJudge(validCorpus, hash(validCorpus));
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Judging 0 result(s)');
  }, 12_000);
});
