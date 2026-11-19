import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildArgv,
  checkAvailable,
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
    expect(JSON.parse(readFileSync(join(cwd, 'schema.json'), 'utf8'))).toEqual(schema);
    expect(cmd).toBe('claude');
    expect(args[1]).toBe(join(cwd, 'schema.json'));
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
const closedSchema = { ...schema, additionalProperties: false };

it.each([
  ['open root', schema, '#'],
  ['missing required property', { ...closedSchema, required: [] }, '#'],
  ['open array item', {
    ...closedSchema,
    properties: { answer: { type: 'array', items: schema } },
  }, '#/properties/answer/items'],
  ['open referenced definition', {
    ...closedSchema,
    properties: { answer: { $ref: '#/$defs/answer' } },
    $defs: { answer: schema },
  }, '#/$defs/answer'],
  ['open union branch', {
    ...closedSchema,
    properties: { answer: { anyOf: [{ type: 'string' }, schema] } },
  }, '#/properties/answer/anyOf/1'],
] as const)('refuses a Codex schema with %s before spawn', async (_case, invalidSchema, path) => {
  const spawn = vi.fn(async () => success);
  const pending = runLabeler(codexConfig, { ...batch, schema: invalidSchema }, spawn, cacheDir);
  await expect(pending).rejects.toBeInstanceOf(LabelerOutputError);
  await expect(pending).rejects.toThrow(`Codex strict schema at ${path}`);
  expect(spawn).not.toHaveBeenCalled();
});

it('passes a compatible Codex schema through unchanged', async () => {
  const stdout = readFileSync(new URL('../../fixtures/labeler-output/codex.txt', import.meta.url), 'utf8');
  const spawn = vi.fn<SpawnFn>(async (_cmd, args) => {
    expect(JSON.parse(readFileSync(args[1], 'utf8'))).toEqual(closedSchema);
    return { stdout, code: 0 };
  });
  const scopedBatch = { ...batch, schema: closedSchema };
  await expect(runLabeler(codexConfig, scopedBatch, spawn, cacheDir))
    .resolves.toMatchObject({ value: { answer: 'ok' }, cached: false });
  await expect(runLabeler(codexConfig, scopedBatch, spawn, cacheDir))
    .resolves.toMatchObject({ value: { answer: 'ok' }, cached: true });
  expect(spawn).toHaveBeenCalledTimes(1);
});

it('loads the isolation note for each shipped labeler', () => {
  for (const labeler of loadLabelers()) {
    expect(labeler).toHaveProperty('isolation', expect.stringMatching(/\S/));
  }
});

const uniqueBatch = {
  ...batch,
  schema: {
    type: 'object',
    properties: { answers: { type: 'array', items: { type: 'object' }, uniqueItems: true } },
    required: ['answers'],
  },
};
const duplicateAnswers = { answers: [{ a: 1, b: 2 }, { b: 2, a: 1 }] };

it('rejects structurally equal array entries in fresh output without caching', async () => {
  const stdout = JSON.stringify({ type: 'result', subtype: 'success', structured_output: duplicateAnswers });
  await expect(runLabeler(cfg, uniqueBatch, async () => ({ stdout, code: 0 }), cacheDir))
    .rejects.toThrow(LabelerOutputError);
  expect(readdirSync(cacheDir)).toEqual([]);
});

it('rejects structurally equal array entries in an existing cache entry', async () => {
  const modelCache = join(cacheDir, cfg.id, cfg.model);
  mkdirSync(modelCache, { recursive: true });
  writeFileSync(join(modelCache, 'example-key.json'), JSON.stringify({ value: duplicateAnswers }));
  const spawn = vi.fn(async () => success);
  await expect(runLabeler(cfg, uniqueBatch, spawn, cacheDir)).rejects.toThrow(LabelerOutputError);
  expect(spawn).not.toHaveBeenCalled();
});

it.each([
  'https://json-schema.org/draft/2020-12/schema',
  'http://json-schema.org/draft-07/schema#',
  'http://json-schema.org/draft-04/schema#',
])('accepts and caches distinct entries with %s', async ($schema) => {
  const scopedBatch = { ...uniqueBatch, schema: { ...uniqueBatch.schema, $schema } };
  const value = { answers: [{ a: 1 }, { a: 2 }] };
  const stdout = JSON.stringify({ type: 'result', subtype: 'success', structured_output: value });
  const spawn = vi.fn(async () => ({ stdout, code: 0 }));
  expect(await runLabeler(cfg, scopedBatch, spawn, cacheDir)).toEqual({ value, cached: false });
  expect(await runLabeler(cfg, scopedBatch, spawn, cacheDir)).toEqual({ value, cached: true });
  expect(spawn).toHaveBeenCalledTimes(1);
});

it.each([
  { type: 'array', items: { type: 'string' } },
  { ...closedSchema, anyOf: [closedSchema] },
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

function formattedBatch(format: string) {
  return { ...batch, schema: { ...schema, properties: { answer: { type: 'string', format } } } };
}

it.each([
  ['guid', '44631d48-0490-4afe-b7d7-a3f683cb028d'],
  ['mac', '02:00:00:00:00:01'],
  ['cidr', '192.0.2.0/24'],
  ['cidr-v6', '2001:db8::/32'],
  ['base64', 'b2s='],
  ['base64url', 'b2s'],
  ['e164', '+12025550123'],
  ['jwt', 'eyJhbGciOiJIUzI1NiJ9.e30.c2ln'],
  ['emoji', '🍎'],
  ['nanoid', 'V1StGXR8_Z5jdHi6B-myT'],
  ['cuid', 'cjld2cjxh0000qzrmn831i7rn'],
  ['cuid2', 'tz4a98xxat96iws9zmbrgj3a'],
  ['ulid', '01ARZ3NDEKTSV4RRFFQ69G5FAV'],
  ['xid', '9m4e2mr0ui3e8a215n4g'],
  ['ksuid', '0ujtsYcgvSTl8PAuAdqWYSMnLOv'],
])('enforces %s on fresh and cached labeler output', async (format, answer) => {
  const scopedBatch = formattedBatch(format);
  const value = { answer };
  const invalid = { answer: format === 'e164' ? '+01234567' : '!' };
  const spawn = vi.fn<SpawnFn>();
  for (const response of [invalid, value]) {
    spawn.mockResolvedValueOnce({
      stdout: JSON.stringify({ type: 'result', subtype: 'success', structured_output: response }),
      code: 0,
    });
  }
  await expect(runLabeler(cfg, scopedBatch, spawn, cacheDir)).rejects.toThrow(/response did not match/i);
  expect(readdirSync(cacheDir)).toEqual([]);
  await expect(runLabeler(cfg, scopedBatch, spawn, cacheDir)).resolves.toEqual({ value, cached: false });
  await expect(runLabeler(cfg, scopedBatch, spawn, cacheDir)).resolves.toEqual({ value, cached: true });
  writeFileSync(join(cacheDir, cfg.id, cfg.model, 'example-key.json'), JSON.stringify({ value: invalid }));
  await expect(runLabeler(cfg, scopedBatch, spawn, cacheDir)).rejects.toThrow(/response did not match/i);
  expect(spawn).toHaveBeenCalledTimes(2);
});

const unknownFormat = { type: 'string', format: 'unknown-labeler-format' };
const unsupportedSchemas = [
  ['an unregistered format', formattedBatch(unknownFormat.format).schema, unknownFormat.format],
  ['an annotation-only binary format', formattedBatch('binary').schema, 'binary'],
  ['an annotation-only password format', formattedBatch('password').schema, 'password'],
  ['a $ref into examples', {
    ...schema,
    properties: { answer: { $ref: '#/examples/0' } },
    examples: [unknownFormat],
  }, unknownFormat.format],
  ['a $ref into $defs', {
    ...schema,
    properties: { answer: { $ref: '#/$defs/answer' } },
    $defs: { answer: unknownFormat },
  }, unknownFormat.format],
  ['a $ref into draft-07 definitions', {
    ...schema,
    $schema: 'http://json-schema.org/draft-07/schema#',
    properties: { answer: { $ref: '#/definitions/answer' } },
    definitions: { answer: unknownFormat },
  }, unknownFormat.format],
  ['a format in an allOf inside items', {
    ...schema,
    properties: { answer: { type: 'array', items: { allOf: [unknownFormat] } } },
  }, unknownFormat.format],
] as const;

describe.each(['cache miss', 'unreadable cache entry'] as const)('%s', (cacheState) => {
  it.each(unsupportedSchemas)('rejects %s before cache reads or spawn', async (_case, responseSchema, format) => {
    if (cacheState === 'unreadable cache entry') {
      // Reading a directory as a cache file fails before JSON parsing.
      mkdirSync(join(cacheDir, cfg.id, cfg.model, 'example-key.json'), { recursive: true });
    }
    const spawn = vi.fn(async () => success);
    const result = runLabeler(cfg, { ...batch, schema: responseSchema }, spawn, cacheDir);
    await expect(result).rejects.toBeInstanceOf(LabelerOutputError);
    await expect(result).rejects.toThrow(new RegExp(`format "${format}"`, 'i'));
    expect(spawn).not.toHaveBeenCalled();
  });
});

it('accepts a schema with overlapping named and pattern properties', async () => {
  const overlappingSchema = { ...schema, patternProperties: { '^a': { type: 'string' } } };
  const spawn = vi.fn(async () => success);
  const scopedBatch = { ...batch, schema: overlappingSchema };
  await expect(runLabeler(cfg, scopedBatch, spawn, cacheDir)).resolves.toEqual({ value: { answer: 'ok' }, cached: false });
  await expect(runLabeler(cfg, scopedBatch, spawn, cacheDir)).resolves.toEqual({ value: { answer: 'ok' }, cached: true });
  expect(spawn).toHaveBeenCalledTimes(1);
});

it('ignores custom schema annotations and their contents', async () => {
  const annotatedSchema = {
    ...schema,
    'x-labeler-note': { format: 'documentation-only' },
    examples: [{ format: 'documentation-only' }],
    properties: { answer: { type: 'string', reviewerNote: 'Example answer' } },
  };
  const spawn = vi.fn(async () => success);
  const scopedBatch = { ...batch, schema: annotatedSchema };
  await expect(runLabeler(cfg, scopedBatch, spawn, cacheDir)).resolves.toEqual({ value: { answer: 'ok' }, cached: false });
  await expect(runLabeler(cfg, scopedBatch, spawn, cacheDir)).resolves.toEqual({ value: { answer: 'ok' }, cached: true });
  expect(spawn).toHaveBeenCalledTimes(1);
});
