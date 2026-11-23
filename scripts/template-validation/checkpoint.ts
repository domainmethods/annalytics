// Per-pass checkpoint for `sweep:template`. Every full corpus pass (calibration,
// each Stage 1/2 point, the paired SQL cross-pass) is appended as one JSONL line
// once it completes. A `--resume` run replays matching passes instead of paying
// for them again, so a sweep stopped by a provider outage or a job time limit
// continues from the last finished pass.
//
// A pass is keyed by everything that determines its result: the frozen set hash,
// the runner, the effective (model, thinking) profile and resolved model id of
// every node, and the pass's ordinal among identical keys (baseline A vs B).
// Code changes are NOT in the key: resume only with the code the checkpoint was
// written with.
import { appendFile, readFile, rm } from 'node:fs/promises';
import { formatSweepProfile } from '../node-sweep-types.js';
import { getNodeProfile, NODE_IDS, resolveNodeModel } from '../../src/agents/nodeProfiles.js';
import type { CorpusRunResult } from '../node-sweep.js';

interface CheckpointLine {
  key: string;
  perEntry: CorpusRunResult['perEntry'];
  nodeUsage: [string, { latencies: number[]; inputTokens: number; outputTokens: number }][];
}

export interface SweepCheckpoint {
  /** Wrap a corpus runner so its passes are replayed from, and recorded to, the checkpoint. */
  wrap(runnerKey: string, run: () => Promise<CorpusRunResult>): () => Promise<CorpusRunResult>;
  /** Number of passes served from the checkpoint so far. */
  readonly replayed: number;
  /** Delete the checkpoint (after the report is written). */
  discard(): Promise<void>;
}

export function effectiveProfileKey(): string {
  return NODE_IDS.map(node => `${node}=${formatSweepProfile(getNodeProfile(node))}:${resolveNodeModel(node)}`).join(',');
}

export async function openSweepCheckpoint(
  path: string, setHash: string, resume: boolean, log: (message: string) => void = console.log,
): Promise<SweepCheckpoint> {
  const saved = new Map<string, CorpusRunResult>();
  if (resume) {
    let text = '';
    try {
      text = await readFile(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let parsed: CheckpointLine;
      try {
        parsed = JSON.parse(line) as CheckpointLine;
      } catch {
        continue; // a pass interrupted mid-write; it is simply re-run
      }
      saved.set(parsed.key, { perEntry: parsed.perEntry, nodeUsage: new Map(parsed.nodeUsage) as CorpusRunResult['nodeUsage'] });
    }
    log(`Checkpoint: resuming from ${path} (${saved.size} completed pass${saved.size === 1 ? '' : 'es'})`);
  } else {
    await rm(path, { force: true });
    log(`Checkpoint: ${path} (rerun with --resume to continue after an interruption)`);
  }

  const ordinals = new Map<string, number>();
  let replayed = 0;
  return {
    get replayed() { return replayed; },
    wrap(runnerKey, run) {
      return async () => {
        const base = `${setHash}|${runnerKey}|${effectiveProfileKey()}`;
        const ordinal = ordinals.get(base) ?? 0;
        ordinals.set(base, ordinal + 1);
        const key = `${base}|#${ordinal}`;
        const hit = saved.get(key);
        if (hit) {
          replayed++;
          return hit;
        }
        const result = await run();
        const line: CheckpointLine = { key, perEntry: result.perEntry, nodeUsage: [...result.nodeUsage] };
        await appendFile(path, `${JSON.stringify(line)}\n`, 'utf8');
        return result;
      };
    },
    async discard() {
      await rm(path, { force: true });
    },
  };
}
