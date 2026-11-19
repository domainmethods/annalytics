import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  buildArgv,
  checkAvailable,
  LabelerOutputError,
  loadLabelers,
  parseLabelerOutput,
  runLabeler,
  type LabelerConfig,
} from '../../../scripts/template-validation/labelers.js';

const cfg: LabelerConfig = {
  id: 'claude',
  family: 'anthropic',
  argv: ['claude', '{prompt}', '{schemaPath}', '{schemaJson}', '{model}'],
  outputParser: 'claude-json',
  model: 'example-model',
  effortArgs: ['--effort', 'max'],
  versionArgv: ['--version'],
};
const schema = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] };
const batch = { prompt: 'Reply with answer=ok', schema, cacheKey: 'example-key' };
const success = { stdout: '{"type":"result","subtype":"success","structured_output":{"answer":"ok"}}', code: 0 };
let cacheDir: string;

beforeEach(() => {
  cacheDir = mkdtempSync(join(tmpdir(), 'tv-labeler-test-'));
});

afterEach(() => {
  rmSync(cacheDir, { recursive: true, force: true });
});

it('substitutes tokens once and appends effort arguments', () => {
  expect(buildArgv(cfg, { prompt: 'a {model}; b', schemaPath: '/example/schema.json', schemaJson: '{}' }))
    .toEqual(['claude', 'a {model}; b', '/example/schema.json', '{}', 'example-model', '--effort', 'max']);
});

it.each([
  ['claude', 'claude-json', 'claude-fable-5-2'],
  ['codex', 'codex-jsonl', undefined],
  ['agy', 'agy-json', undefined],
  ['gemini', 'gemini-json', 'gemini-3.1-pro-preview'],
] as const)('parses the %s fixture using its configured parser', (id, parser, reportedModel) => {
  expect(loadLabelers().find((labeler) => labeler.id === id)?.outputParser).toBe(parser);
  const stdout = readFileSync(new URL(`../../fixtures/labeler-output/${id}.txt`, import.meta.url), 'utf8');
  expect(parseLabelerOutput(parser, stdout)).toEqual({ value: { answer: 'ok' }, reportedModel });
});

it.each(['claude-json', 'codex-jsonl', 'agy-json', 'gemini-json'] as const)(
  '%s rejects fences, prose and truncated JSON',
  (parser) => {
    for (const input of ['```json\n{"answer":"ok"}\n```', 'Here is the answer: {"answer":"ok"}', '{"answer":']) {
      expect(() => parseLabelerOutput(parser, input)).toThrow(LabelerOutputError);
    }
  },
);

it('runs in a fresh directory outside the repo containing only the schema and removes it', async () => {
  let workingDir = '';
  const result = await runLabeler(cfg, batch, async (cmd, args, { cwd }) => {
    workingDir = cwd;
    const fromRepo = relative(process.cwd(), cwd);
    expect(isAbsolute(fromRepo) || fromRepo.startsWith('../')).toBe(true);
    expect(readdirSync(cwd)).toEqual(['schema.json']);
    expect(JSON.parse(readFileSync(join(cwd, 'schema.json'), 'utf8'))).toEqual(schema);
    expect(cmd).toBe('claude');
    expect(args[1]).toBe(join(cwd, 'schema.json'));
    return success;
  }, cacheDir);
  expect(result).toEqual({ value: { answer: 'ok' }, cached: false });
  expect(existsSync(workingDir)).toBe(false);
});

it('reads the cached result without spawning the CLI', async () => {
  const spawn = vi.fn(async () => success);
  await runLabeler(cfg, batch, spawn, cacheDir);
  expect(existsSync(join(cacheDir, 'claude/example-model/example-key.json'))).toBe(true);
  expect(await runLabeler(cfg, batch, spawn, cacheDir)).toEqual({ value: { answer: 'ok' }, cached: true });
  expect(spawn).toHaveBeenCalledTimes(1);
});

it.each([
  { ...success, code: 1 },
  { stdout: '{"type":"result","subtype":"success","structured_output":{"answer":7}}', code: 0 },
])('rejects failed invocations and schema violations without caching', async (output) => {
  await expect(runLabeler(cfg, batch, async () => output, cacheDir)).rejects.toThrow(LabelerOutputError);
  expect(readdirSync(cacheDir)).toEqual([]);
});

it('reports the CLI version and treats a missing executable as unavailable', async () => {
  expect(await checkAvailable(cfg, async (cmd, args) => {
    expect(cmd).toBe('claude');
    expect(args).toEqual(['--version']);
    return { stdout: '2.1.327\n', code: 0 };
  })).toEqual({ ok: true, version: '2.1.327' });
  expect(await checkAvailable(cfg, async () => { throw new Error('ENOENT'); })).toEqual({ ok: false });
});

it('places Codex effort options ahead of the separator protecting a hyphen-led prompt', () => {
  const codex = loadLabelers().find(({ id }) => id === 'codex')!;
  const argv = buildArgv(codex, { prompt: '--version', schemaPath: '/example/schema.json', schemaJson: '{}' });
  expect(argv.slice(-4)).toEqual(['-c', 'model_reasoning_effort="ultra"', '--', '--version']);
});

it('does not probe or run the disabled Gemini CLI', async () => {
  const gemini = loadLabelers().find(({ id }) => id === 'gemini')!;
  const spawn = vi.fn(async () => success);
  expect(await checkAvailable(gemini, spawn)).toEqual({ ok: false });
  await expect(runLabeler(gemini, batch, spawn, cacheDir)).rejects.toThrow(/disabled/i);
  expect(spawn).not.toHaveBeenCalled();
});
