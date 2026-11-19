import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv, { type ValidateFunction } from 'ajv';
import Ajv2020 from 'ajv/dist/2020.js';
import AjvDraft4 from 'ajv-draft-04';
import addFormats from 'ajv-formats';
import { z } from 'zod';

const cacheSegment = z.string().regex(/^[\w-][\w.-]*$/);
export interface LabelerConfig {
  id: string;
  enabled?: boolean;
  isolation?: string;
  family: 'anthropic' | 'openai' | 'google';
  argv: string[];
  outputParser: 'claude-json' | 'codex-jsonl' | 'agy-json' | 'gemini-json';
  model: string;
  effortArgs: string[];
  versionArgv: string[];
}

const labelerConfigSchema = z.object({
  id: cacheSegment,
  enabled: z.boolean().optional(),
  isolation: z.string().trim().min(1).optional(),
  family: z.enum(['anthropic', 'openai', 'google']),
  argv: z.array(z.string()).min(1),
  outputParser: z.enum(['claude-json', 'codex-jsonl', 'agy-json', 'gemini-json']),
  model: cacheSegment,
  effortArgs: z.array(z.string()),
  versionArgv: z.array(z.string()),
});

export class LabelerOutputError extends Error {
  override name = 'LabelerOutputError';
}

interface LabelerOutput {
  value: unknown;
  reportedModel?: string;
}

export type SpawnFn = (
  cmd: string,
  args: string[],
  opts: { cwd: string; timeoutMs: number },
) => Promise<{ stdout: string; code: number }>;

export function loadLabelers(path = 'benchmarks/template-validation/labelers.json'): LabelerConfig[] {
  return z.array(labelerConfigSchema).parse(JSON.parse(readFileSync(path, 'utf8')));
}

export function buildArgv(
  cfg: LabelerConfig,
  vars: { prompt: string; schemaPath: string; schemaJson: string },
): string[] {
  const tokens = { ...vars, model: cfg.model };
  const argv = cfg.argv.map((arg) => arg.replace(
    /\{(prompt|schemaPath|schemaJson|model)\}/g,
    (_, token: keyof typeof tokens) => tokens[token],
  ));
  const separator = cfg.argv.indexOf('--');
  argv.splice(separator === -1 ? argv.length : separator, 0, ...cfg.effortArgs);
  return argv;
}

function parseJson(text: unknown): unknown {
  if (typeof text !== 'string') throw new LabelerOutputError('Missing JSON response');
  try {
    return JSON.parse(text);
  } catch {
    throw new LabelerOutputError('Invalid JSON response');
  }
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new LabelerOutputError('Expected a JSON envelope');
  }
  return value as Record<string, unknown>;
}

function output(value: unknown, reportedModel: unknown): LabelerOutput {
  return typeof reportedModel === 'string' && reportedModel
    ? { value, reportedModel }
    : { value };
}

export function parseLabelerOutput(parser: LabelerConfig['outputParser'], stdout: string): LabelerOutput {
  if (parser === 'codex-jsonl') {
    const events = stdout.trim().split(/\r?\n/).map((line) => record(parseJson(line)));
    if (events.at(-1)?.type !== 'turn.completed' ||
        events.some((event) => event.type === 'turn.failed' || event.type === 'error')) {
      throw new LabelerOutputError('Codex did not complete the turn');
    }
    const messages = events.filter((event) => event.type === 'item.completed')
      .map((event) => record(event.item));
    const message = messages.filter((item) => item.type === 'agent_message').at(-1);
    const thread = events.find((event) => event.type === 'thread.started');
    return output(parseJson(message?.text), message?.model ?? thread?.model);
  }

  const parsed = parseJson(stdout);
  if (parser === 'claude-json') {
    const events = Array.isArray(parsed) ? parsed.map(record) : [record(parsed)];
    const result = events.at(-1);
    if (result?.type !== 'result' || result.subtype !== 'success' || result.is_error === true) {
      throw new LabelerOutputError('Claude did not return a successful result');
    }
    const init = events.find((event) => event.type === 'system' && event.subtype === 'init');
    return output(
      'structured_output' in result ? result.structured_output : parseJson(result.result),
      result.model ?? init?.model,
    );
  }

  const envelope = record(parsed);
  if (parser === 'agy-json') {
    if (envelope.status !== 'SUCCESS') throw new LabelerOutputError('AGY did not return a successful result');
    return output(
      'structured_output' in envelope ? envelope.structured_output : parseJson(envelope.response),
      envelope.model,
    );
  }

  if (envelope.error) throw new LabelerOutputError('Gemini did not return a successful result');
  const stats = envelope.stats as { models?: Record<string, unknown> } | undefined;
  const models = Object.keys(stats?.models ?? {});
  return output(parseJson(envelope.response), envelope.model ?? (models.length === 1 ? models[0] : undefined));
}

function visitSchemaNodes(
  schema: unknown,
  visit: (node: Record<string, unknown>, path: string) => void,
  path = '#',
): void {
  if (Array.isArray(schema)) {
    schema.forEach((child, index) => visitSchemaNodes(child, visit, `${path}/${index}`));
    return;
  }
  if (schema === null || typeof schema !== 'object') return;

  const node = schema as Record<string, unknown>;
  visit(node, path);

  // Visit schema locations only. Examples and defaults can contain arbitrary objects.
  for (const keyword of ['properties', '$defs', 'definitions', 'patternProperties', 'dependentSchemas', 'dependencies']) {
    const children = node[keyword];
    if (children && typeof children === 'object') {
      for (const [key, child] of Object.entries(children)) {
        const segment = key.replaceAll('~', '~0').replaceAll('/', '~1');
        visitSchemaNodes(child, visit, `${path}/${keyword}/${segment}`);
      }
    }
  }
  for (const keyword of [
    'items', 'prefixItems', 'additionalItems', 'contains', 'additionalProperties', 'unevaluatedItems',
    'unevaluatedProperties', 'propertyNames', 'anyOf', 'allOf', 'oneOf', 'not', 'if', 'then', 'else', 'contentSchema',
  ]) {
    visitSchemaNodes(node[keyword], visit, `${path}/${keyword}`);
  }
}

function assertCodexStrictSchema(node: Record<string, unknown>, path: string): void {
  const objectKeywords = [
    'properties', 'required', 'additionalProperties', 'patternProperties', 'propertyNames',
    'minProperties', 'maxProperties', 'dependentRequired', 'dependentSchemas', 'dependencies', 'unevaluatedProperties',
  ];
  if (node.type === 'object' || (Array.isArray(node.type) && node.type.includes('object')) ||
      objectKeywords.some((keyword) => Object.hasOwn(node, keyword))) {
    const properties = Object.keys(node.properties ?? {});
    const required = node.required;
    if (node.additionalProperties !== false || !Array.isArray(required) ||
        required.length !== properties.length || properties.some((key) => !required.includes(key))) {
      throw new LabelerOutputError(
        `Codex strict schema at ${path} requires additionalProperties: false and a required array listing every property exactly once`,
      );
    }
  }
}

// Keep Zod's former JSON Schema checks for formats that ajv-formats lacks.
const zodResponseFormats = {
  guid: z.uuid(),
  mac: z.mac(),
  cidr: z.cidrv4(),
  'cidr-v6': z.cidrv6(),
  base64: z.base64(),
  base64url: z.base64url(),
  e164: z.e164(),
  jwt: z.jwt(),
  emoji: z.emoji(),
  nanoid: z.nanoid(),
  cuid: z.cuid(),
  cuid2: z.cuid2(),
  ulid: z.ulid(),
  xid: z.xid(),
  ksuid: z.ksuid(),
};

function compileResponseSchema(schema: Record<string, unknown>): ValidateFunction {
  // Ajv throws for unknown formats in 'log' mode and only logs unknown keywords.
  const options = { strict: false, strictSchema: 'log', logger: false, allowMatchingProperties: true, ownProperties: true } as const;
  const dialect = schema.$schema;
  const ajv = dialect === 'http://json-schema.org/draft-04/schema#' ? new AjvDraft4(options)
    : dialect === 'http://json-schema.org/draft-07/schema#' ? new Ajv(options)
      : new Ajv2020(options);
  addFormats(ajv);
  for (const [format, definition] of Object.entries(ajv.formats)) {
    if (definition === true) ajv.formats[format] = undefined;
  }
  for (const [format, check] of Object.entries(zodResponseFormats)) {
    ajv.addFormat(format, (value: string) => check.safeParse(value).success);
  }
  let validator: ValidateFunction;
  try {
    validator = ajv.compile(schema);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new LabelerOutputError(`Invalid response schema: ${message}`, { cause: error });
  }
  if ('$async' in validator && validator.$async) {
    throw new LabelerOutputError('Async response schemas are unsupported');
  }
  return validator;
}

async function externalTempRoot(): Promise<string> {
  const [checkout, tempRoot] = await Promise.all([
    realpath(fileURLToPath(new URL('../../', import.meta.url))),
    realpath(tmpdir()),
  ]);
  const fromCheckout = relative(checkout, tempRoot);
  if (!isAbsolute(fromCheckout) && fromCheckout !== '..' && !fromCheckout.startsWith(`..${sep}`)) {
    throw new LabelerOutputError('Labeler temp directory is inside the checkout');
  }
  return tempRoot;
}

export async function runLabeler(
  cfg: LabelerConfig,
  batch: { prompt: string; schema: object; cacheKey: string },
  spawn: SpawnFn,
  cacheDir: string,
): Promise<LabelerOutput & { cached: boolean }> {
  if (cfg.enabled === false) throw new LabelerOutputError(`${cfg.id} is disabled`);
  const schema = { ...batch.schema } as Record<string, unknown>;
  if (cfg.outputParser === 'codex-jsonl') {
    if (schema.type !== 'object' || Object.hasOwn(schema, 'anyOf')) {
      throw new LabelerOutputError('Codex strict schema root must be an object without anyOf');
    }
    visitSchemaNodes(schema, assertCodexStrictSchema);
  }
  const cachePath = join(cacheDir, cacheSegment.parse(cfg.id), cacheSegment.parse(cfg.model),
    cacheSegment.parse(batch.cacheKey) + '.json');
  const validator = compileResponseSchema(schema);
  const validate = (value: unknown) => {
    if (!validator(value)) throw new LabelerOutputError('Response did not match the batch schema');
  };

  const cached = await readFile(cachePath, 'utf8').catch((err: NodeJS.ErrnoException) => {
    if (err.code !== 'ENOENT') throw err;
    return undefined;
  });
  if (cached !== undefined) {
    const result = record(parseJson(cached));
    if (!Object.hasOwn(result, 'value')) throw new LabelerOutputError('Cache entry missing a response');
    validate(result.value);
    return { ...output(result.value, result.reportedModel), cached: true };
  }

  const cwd = await mkdtemp(join(await externalTempRoot(), 'tv-labeler-'));
  let result: LabelerOutput;
  try {
    const schemaPath = join(cwd, 'schema.json');
    const schemaJson = JSON.stringify(batch.schema);
    await writeFile(schemaPath, schemaJson);
    const [cmd, ...args] = buildArgv(cfg, { prompt: batch.prompt, schemaPath, schemaJson });
    const { stdout, code } = await spawn(cmd, args, { cwd, timeoutMs: 300_000 });
    if (code !== 0) throw new LabelerOutputError(`${cfg.id} exited with code ${code}`);
    result = parseLabelerOutput(cfg.outputParser, stdout);
    validate(result.value);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }

  await mkdir(dirname(cachePath), { recursive: true, mode: 0o700 });
  const stagingPath = cachePath + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(stagingPath, JSON.stringify(result) + '\n', { flag: 'wx', mode: 0o600 });
    await rename(stagingPath, cachePath);
  } finally {
    await rm(stagingPath, { force: true });
  }
  return { ...result, cached: false };
}

export async function checkAvailable(
  cfg: LabelerConfig,
  spawn: SpawnFn,
): Promise<{ ok: boolean; version?: string }> {
  if (cfg.enabled === false) return { ok: false };
  try {
    const { stdout, code } = await spawn(cfg.argv[0], cfg.versionArgv, { cwd: await externalTempRoot(), timeoutMs: 10_000 });
    return code === 0 ? { ok: true, version: stdout.trim() } : { ok: false };
  } catch {
    return { ok: false };
  }
}
