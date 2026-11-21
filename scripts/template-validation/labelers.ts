import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
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

export class InvalidLabelerResponseError extends LabelerOutputError {
  override name = 'InvalidLabelerResponseError';
}

interface LabelerOutput {
  value: unknown;
  reportedModel?: string;
}

export type SpawnFn = (
  cmd: string,
  args: string[],
  opts: { cwd: string; timeoutMs: number; outputParser: LabelerConfig['outputParser'] },
) => Promise<{ stdout: string; stderr?: string; code: number; timedOut?: boolean }>;

// A 20-item batch at max reasoning effort can take well over 5 minutes.
const LABEL_TIMEOUT_MS = 20 * 60_000;

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
  for (const [index, arg] of argv.entries()) {
    const size = Buffer.byteLength(arg, 'utf8');
    // Linux MAX_ARG_STRLEN includes the terminating NUL byte.
    if (size >= 131_072) {
      const name = arg === vars.prompt ? ' (prompt)' : arg === vars.schemaJson ? ' (--json-schema)' : '';
      throw new LabelerOutputError(`${cfg.id} argv[${index}]${name} is ${size} bytes, exceeding the 131071-byte argument limit`);
    }
  }
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

// The claude CLI in JSON mode reports failures (quota, API errors) as a JSON envelope on
// stdout and leaves stderr empty, so a non-zero exit needs stdout to explain itself.
function stdoutErrorDetail(stdout: string | undefined): string | undefined {
  const text = stdout?.trim();
  if (!text) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const env = parsed as Record<string, unknown>;
      const parts = [
        env.api_error_status !== undefined && env.api_error_status !== null ? `status ${String(env.api_error_status)}` : '',
        typeof env.subtype === 'string' && env.subtype !== 'success' ? env.subtype : '',
        typeof env.result === 'string' ? env.result.trim() : '',
      ].filter(Boolean);
      if (parts.length) return parts.join(': ').slice(0, 500);
    }
  } catch {
    // Not JSON; fall back to the raw tail.
  }
  return text.slice(-500);
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
  batch: { prompt: string; schema: z.ZodType; cacheKey: string },
  spawn: SpawnFn,
  cacheDir: string,
): Promise<LabelerOutput & { cached: boolean }> {
  if (cfg.enabled === false) throw new LabelerOutputError(`${cfg.id} is disabled`);
  // The Claude CLI rejects the 2020-12 `$schema` URI Zod emits, and no labeler needs it.
  const { $schema: _dialect, ...schema } = z.toJSONSchema(batch.schema);
  if (cfg.outputParser === 'codex-jsonl') {
    if (schema.type !== 'object' || Object.hasOwn(schema, 'anyOf')) {
      throw new LabelerOutputError('Codex strict schema root must be an object without anyOf');
    }
    visitSchemaNodes(schema, assertCodexStrictSchema);
  }
  const cachePath = join(cacheDir, cacheSegment.parse(cfg.id), cacheSegment.parse(cfg.model),
    cacheSegment.parse(batch.cacheKey) + '.json');
  const validate = (value: unknown) => {
    const parsed = batch.schema.safeParse(value);
    // Zod strips unknown object keys by default. The emitted schema rejects them.
    if (!parsed.success || !isDeepStrictEqual(value, parsed.data)) {
      throw new LabelerOutputError('Response did not match the batch schema');
    }
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
    const schemaJson = JSON.stringify(schema);
    await writeFile(schemaPath, schemaJson);
    const [cmd, ...args] = buildArgv(cfg, { prompt: batch.prompt, schemaPath, schemaJson });
    const { stdout, stderr, code, timedOut } =
      await spawn(cmd, args, { cwd, timeoutMs: LABEL_TIMEOUT_MS, outputParser: cfg.outputParser });
    if (timedOut) throw new LabelerOutputError(`${cfg.id} timed out after ${LABEL_TIMEOUT_MS / 60_000} minutes`);
    if (code !== 0) {
      const detail = stderr?.trim().slice(-500) || stdoutErrorDetail(stdout);
      throw new LabelerOutputError(`${cfg.id} exited with code ${code}${detail ? `: ${detail}` : ''}`);
    }
    try {
      result = parseLabelerOutput(cfg.outputParser, stdout);
      validate(result.value);
    } catch (error) {
      if (!(error instanceof LabelerOutputError)) throw error;
      throw new InvalidLabelerResponseError(error.message);
    }
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
    const { stdout, code } = await spawn(cfg.argv[0], cfg.versionArgv, { cwd: await externalTempRoot(), timeoutMs: 10_000, outputParser: cfg.outputParser });
    return code === 0 ? { ok: true, version: stdout.trim() } : { ok: false };
  } catch {
    return { ok: false };
  }
}
