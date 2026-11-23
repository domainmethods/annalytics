import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
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
