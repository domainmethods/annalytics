import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  buildArgv,
  checkAvailable,
  InvalidLabelerResponseError,
  LabelerOutputError,
  loadLabelers,
  parseLabelerOutput,
  runLabeler,
  type LabelerConfig,
  type SpawnFn,
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
const schema = z.object({ answer: z.string() });
const batch = { prompt: 'Reply with answer=ok', schema, cacheKey: 'example-key' };
const success = { stdout: '{"type":"result","subtype":"success","structured_output":{"answer":"ok"}}', code: 0 };
// The CLI validators reject the 2020-12 `$schema` URI Zod stamps, so labelers get the schema without it.
const { $schema: _dialect, ...cliSchema } = z.toJSONSchema(schema);
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
  ['claude', 'claude-json', 'claude-fable-5-2', 'ok'],
  ['codex', 'codex-jsonl', undefined, 'ok'],
  ['agy', 'agy-json', undefined, 'answer=ok'],
  ['gemini', 'gemini-json', 'gemini-3.1-pro-preview', 'ok'],
] as const)('parses the %s fixture using its configured parser', (id, parser, reportedModel, answer) => {
  expect(loadLabelers().find((labeler) => labeler.id === id)?.outputParser).toBe(parser);
  const stdout = readFileSync(new URL(`../../fixtures/labeler-output/${id}.txt`, import.meta.url), 'utf8');
  expect(parseLabelerOutput(parser, stdout)).toEqual({ value: { answer }, reportedModel });
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
    expect(JSON.parse(readFileSync(join(cwd, 'schema.json'), 'utf8'))).toStrictEqual(cliSchema);
    expect(cmd).toBe('claude');
    expect(args[1]).toBe(join(cwd, 'schema.json'));
    expect(JSON.parse(args[2])).toStrictEqual(cliSchema);
    return success;
  }, cacheDir);
  expect(result).toEqual({ value: { answer: 'ok' }, cached: false });
  expect(existsSync(workingDir)).toBe(false);
});

it('rejects an oversized UTF-8 prompt before spawning', async () => {
  const spawn = vi.fn(async () => success);
  const prompt = 'é'.repeat(65_536);
  await expect(runLabeler(cfg, { ...batch, prompt }, spawn, cacheDir))
    .rejects.toThrow(/claude.*argv\[1\].*prompt.*131072 bytes/i);
  expect(spawn).not.toHaveBeenCalled();
});

it('checks the serialized schema argument and allows a prompt below the limit', () => {
  const vars = { prompt: 'x'.repeat(131_071), schemaPath: '/example/schema.json', schemaJson: '{}' };
  expect(buildArgv(cfg, vars)[1]).toBe(vars.prompt);
  const schemaJson = JSON.stringify({ description: 'é'.repeat(65_536) });
  expect(() => buildArgv(cfg, { ...vars, schemaJson }))
    .toThrow(/claude.*argv\[3\].*--json-schema.*131090 bytes/i);
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

it('includes the end of stderr when a labeler exits non-zero', async () => {
  const stderr = 'x'.repeat(2000) + '\nError: --json-schema is not a valid JSON Schema';
  await expect(runLabeler(cfg, batch, async () => ({ stdout: '', stderr, code: 1 }), cacheDir))
    .rejects.toThrow(expect.objectContaining({ message: `claude exited with code 1: ${stderr.slice(-500)}` }));
});

it('reports the JSON error envelope on stdout when stderr is empty', async () => {
  const stdout = JSON.stringify({ type: 'result', subtype: 'success', is_error: true, api_error_status: 429, result: 'Usage limit reached' });
  await expect(runLabeler(cfg, batch, async () => ({ stdout, stderr: '', code: 1 }), cacheDir))
    .rejects.toThrow(expect.objectContaining({ message: 'claude exited with code 1: status 429: Usage limit reached' }));
});

it('includes the errors array from a stdout envelope without a result', async () => {
  const stdout = JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['Tool call failed', '  ', 'Retry exhausted'] });
  await expect(runLabeler(cfg, batch, async () => ({ stdout, stderr: '', code: 1 }), cacheDir))
    .rejects.toThrow(expect.objectContaining({ message: 'claude exited with code 1: error_during_execution: Tool call failed; Retry exhausted' }));
});

it('reads the last event of an array-form stdout envelope', async () => {
  const stdout = JSON.stringify([{ type: 'system' }, { type: 'result', is_error: true, api_error_status: 529, result: 'Overloaded' }]);
  await expect(runLabeler(cfg, batch, async () => ({ stdout, stderr: '', code: 1 }), cacheDir))
    .rejects.toThrow(expect.objectContaining({ message: 'claude exited with code 1: status 529: Overloaded' }));
});

it('falls back to raw stdout when the JSON envelope has no error fields', async () => {
  const stdout = '{"type":"result","subtype":"success"}';
  await expect(runLabeler(cfg, batch, async () => ({ stdout, stderr: '', code: 1 }), cacheDir))
    .rejects.toThrow(expect.objectContaining({ message: `claude exited with code 1: ${stdout}` }));
});

it('falls back to the tail of non-JSON stdout when stderr is empty', async () => {
  const stdout = 'y'.repeat(2000) + '\nfatal: something broke';
  await expect(runLabeler(cfg, batch, async () => ({ stdout, stderr: '', code: 1 }), cacheDir))
    .rejects.toThrow(expect.objectContaining({ message: `claude exited with code 1: ${stdout.slice(-500)}` }));
});

it('prefers stderr over stdout when both are present', async () => {
  const stdout = JSON.stringify({ is_error: true, result: 'from stdout' });
  await expect(runLabeler(cfg, batch, async () => ({ stdout, stderr: 'from stderr', code: 1 }), cacheDir))
    .rejects.toThrow(expect.objectContaining({ message: 'claude exited with code 1: from stderr' }));
});

it('names a labeler timeout and allows 20 minutes per batch', async () => {
  const spawn = vi.fn(async () => ({ stdout: '', stderr: 'Warning: no stdin data received', code: 1, timedOut: true }));
  await expect(runLabeler(cfg, batch, spawn, cacheDir)).rejects.toThrow(/^claude timed out after 20 minutes$/);
  expect(spawn).toHaveBeenCalledWith(expect.any(String), expect.any(Array), expect.objectContaining({ timeoutMs: 1_200_000 }));
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

const codexConfig = { ...cfg, id: 'codex', family: 'openai', outputParser: 'codex-jsonl' } as const;
const openSchema = z.looseObject({ answer: z.string() });

it.each([
  ['open root', openSchema, '#'],
  ['optional property', z.object({ answer: z.string().optional() }), '#'],
  ['open array item', z.object({ answer: z.array(openSchema) }), '#/properties/answer/items'],
  ['open referenced definition', z.object({
    answer: z.looseObject({ answer: z.string() }).meta({ id: 'openAnswer' }),
  }), '#/$defs/openAnswer'],
  ['open union branch', z.object({ answer: z.union([z.string(), openSchema]) }), '#/properties/answer/anyOf/1'],
] as const)('refuses a Codex schema with %s before spawn', async (_case, invalidSchema, path) => {
  const spawn = vi.fn(async () => success);
  const pending = runLabeler(codexConfig, { ...batch, schema: invalidSchema }, spawn, cacheDir);
  await expect(pending).rejects.toBeInstanceOf(LabelerOutputError);
  await expect(pending).rejects.toThrow(`Codex strict schema at ${path}`);
  expect(spawn).not.toHaveBeenCalled();
});

it('passes the Codex schema through without its $schema dialect', async () => {
  const stdout = readFileSync(new URL('../../fixtures/labeler-output/codex.txt', import.meta.url), 'utf8');
  const spawn = vi.fn<SpawnFn>(async (_cmd, args) => {
    expect(JSON.parse(readFileSync(args[1], 'utf8'))).toStrictEqual(cliSchema);
    return { stdout, code: 0 };
  });
  await expect(runLabeler(codexConfig, batch, spawn, cacheDir))
    .resolves.toMatchObject({ value: { answer: 'ok' }, cached: false });
  await expect(runLabeler(codexConfig, batch, spawn, cacheDir))
    .resolves.toMatchObject({ value: { answer: 'ok' }, cached: true });
  expect(spawn).toHaveBeenCalledTimes(1);
});

it('loads the isolation note for each shipped labeler', () => {
  for (const labeler of loadLabelers()) {
    expect(labeler).toHaveProperty('isolation', expect.stringMatching(/\S/));
  }
});

it.each([
  z.array(z.string()),
  z.union([schema, z.object({ other: z.string() })]),
])('rejects an incompatible Codex root before cache reads or spawn (%j)', async (rootSchema) => {
  const spawn = vi.fn(async () => success);
  const scopedBatch = { ...batch, schema: rootSchema };
  await expect(runLabeler(codexConfig, scopedBatch, spawn, cacheDir)).rejects.toThrow(/root.*object.*anyOf/i);
  mkdirSync(join(cacheDir, codexConfig.id, codexConfig.model, 'example-key.json'), { recursive: true });
  await expect(runLabeler(codexConfig, scopedBatch, spawn, cacheDir)).rejects.toThrow(/root.*object.*anyOf/i);
  expect(spawn).not.toHaveBeenCalled();
});

it.each(['direct', 'symlink'] as const)('refuses a TMPDIR inside the checkout (%s)', async (kind) => {
  const internalRoot = mkdtempSync(join(process.cwd(), '.tv-labeler-test-'));
  const alias = join(cacheDir, 'alias');
  try {
    if (kind === 'symlink') symlinkSync(internalRoot, alias, 'dir');
    vi.stubEnv('TMPDIR', kind === 'direct' ? internalRoot : alias);
    const spawn = vi.fn(async () => success);
    await expect(runLabeler(cfg, batch, spawn, cacheDir)).rejects.toThrow(/temp.*inside.*checkout/i);
    expect(await checkAvailable(cfg, spawn)).toEqual({ ok: false });
    expect(spawn).not.toHaveBeenCalled();
    expect(readdirSync(internalRoot)).toEqual([]);
  } finally {
    vi.unstubAllEnvs();
    rmSync(internalRoot, { recursive: true, force: true });
  }
});

it.each([
  { answer: 'no' },
  { answer: 'ok', unexpected: true },
])('rejects invalid responses before caching and on cache hits (%j)', async value => {
  const scopedBatch = { ...batch, schema: z.object({ answer: z.string().refine(answer => answer === 'ok') }) };
  const stdout = JSON.stringify({ type: 'result', subtype: 'success', structured_output: value });
  const spawn = vi.fn<SpawnFn>()
    .mockResolvedValueOnce({ stdout, code: 0 })
    .mockResolvedValueOnce(success);
  await expect(runLabeler(cfg, scopedBatch, spawn, cacheDir)).rejects.toThrow(InvalidLabelerResponseError);
  expect(readdirSync(cacheDir)).toEqual([]);
  await expect(runLabeler(cfg, scopedBatch, spawn, cacheDir)).resolves.toEqual({ value: { answer: 'ok' }, cached: false });
  await expect(runLabeler(cfg, scopedBatch, spawn, cacheDir)).resolves.toEqual({ value: { answer: 'ok' }, cached: true });

  writeFileSync(join(cacheDir, cfg.id, cfg.model, 'example-key.json'), JSON.stringify({ value }));
  await expect(runLabeler(cfg, scopedBatch, spawn, cacheDir)).rejects.toThrow('Response did not match the batch schema');
  expect(spawn).toHaveBeenCalledTimes(2);
});
