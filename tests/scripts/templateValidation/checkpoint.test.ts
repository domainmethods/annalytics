import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { openSweepCheckpoint } from '../../../scripts/template-validation/checkpoint.js';

it('keeps a pass appended after a truncated line readable on the next resume', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sweep-checkpoint-'));
  const path = join(dir, 'cp.jsonl');
  try {
    await writeFile(path, '{"key":"cut-off', 'utf8');
    const pass = { perEntry: [{ id: 'a', overallScore: 1 }], nodeUsage: new Map() } as never;
    const first = await openSweepCheckpoint(path, 'h', true, () => {});
    await first.wrap('slackIntake', async () => pass)();
    expect((await readFile(path, 'utf8')).split('\n')).toHaveLength(3);
    const second = await openSweepCheckpoint(path, 'h', true, () => {});
    let ran = false;
    await second.wrap('slackIntake', async () => { ran = true; return pass; })();
    expect(ran).toBe(false);
    expect(second.replayed).toBe(1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

async function withDir(fn: (path: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'sweep-checkpoint-'));
  try {
    await fn(join(dir, 'cp.jsonl'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
const passOf = (score: number) => ({ perEntry: [{ id: 'a', overallScore: score }], nodeUsage: new Map() }) as never;

it('gives identical passes distinct ordinals and replays both in order', () => withDir(async path => {
  const first = await openSweepCheckpoint(path, 'h', false, () => {});
  let n = 0;
  const counting = first.wrap('slackIntake', async () => passOf(++n));
  await counting();
  await counting();
  expect(n).toBe(2);
  const second = await openSweepCheckpoint(path, 'h', true, () => {});
  const replay = second.wrap('slackIntake', async () => { throw new Error('should replay'); });
  expect(((await replay()) as { perEntry: { overallScore: number }[] }).perEntry[0].overallScore).toBe(1);
  expect(((await replay()) as { perEntry: { overallScore: number }[] }).perEntry[0].overallScore).toBe(2);
  expect(second.replayed).toBe(2);
}));

it('misses the checkpoint when a node profile changed', () => withDir(async path => {
  const first = await openSweepCheckpoint(path, 'h', false, () => {});
  await first.wrap('slackIntake', async () => passOf(1))();
  const second = await openSweepCheckpoint(path, 'h', true, () => {});
  vi.stubEnv('NODE_PROFILE_OVERRIDES', JSON.stringify({ slackIntake: { tier: 'flash', version: '3', thinkingLevel: 'high' } }));
  let ran = false;
  try {
    await second.wrap('slackIntake', async () => { ran = true; return passOf(1); })();
  } finally {
    vi.unstubAllEnvs();
  }
  expect(ran).toBe(true);
  expect(second.replayed).toBe(0);
}));

it('starts empty when --resume finds no checkpoint, and refuses a fresh run over a leftover one', () => withDir(async path => {
  const resumed = await openSweepCheckpoint(path, 'h', true, () => {});
  await resumed.wrap('slackIntake', async () => passOf(1))();
  expect(resumed.replayed).toBe(0);
  await expect(openSweepCheckpoint(path, 'h', false, () => {})).rejects.toThrow(/--resume/);
  await resumed.discard();
  await expect(openSweepCheckpoint(path, 'h', false, () => {})).resolves.toBeDefined();
}));

it('surfaces a filesystem error other than ENOENT instead of treating it as no checkpoint', () => withDir(async path => {
  await writeFile(path, 'not a directory', 'utf8');
  await expect(openSweepCheckpoint(join(path, 'cp.jsonl'), 'h', false, () => {})).rejects.toMatchObject({ code: 'ENOTDIR' });
}));
