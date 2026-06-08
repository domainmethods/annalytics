import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { resolveModelId } from '../src/agents/modelConfig.js';
import { DEFAULT_LADDER, type LadderRung } from './node-sweep-types.js';
import { classifySlackIntake } from '../src/agents/slackIntakeAgent.js';
import { classifyFollowUp } from '../src/agents/followUpClassifier.js';
import type { ThreadMessage } from '../src/types.js';
import {
  accuracy,
  pickFloorUp,
  type Prediction,
  type RungAccuracy,
  type FloorUpResult,
} from './universal-sweep-core.js';

// ── Live floor-up sweep for the data-invariant classifier nodes ──────────────
//
// Sizes slackIntake + followUpClassifier against a hand-labeled corpus using an
// OBJECTIVE exact-match metric (route / intent). No LLM judge is involved, so
// this track is immune to the holistic-score noise that makes the SQL-path
// supervisor node unsizable. The picks land in the TEMPLATE nodeProfiles.ts
// defaults (these nodes are install-invariant), not in NODE_PROFILE_OVERRIDES.
//
// IMPORTANT: do not run this concurrently with scripts/node-sweep.ts — that
// sweep fail-fast aborts on any rung error (including a shared-quota 429), so a
// second live consumer can corrupt its results. Serialize the two.

export interface IntakeEntry {
  id: string;
  text: string;
  expectedRoute: 'immediate_response' | 'analytics_pipeline';
}

export interface FollowUpEntry {
  id: string;
  thread: ThreadMessage[];
  message: string;
  expectedIntent: 'new_query' | 'refinement' | 'meta_question' | 'discrepancy';
}

/** Runs one node's whole corpus at the override currently set in process.env,
 *  returning a graded prediction per entry. Throws on a degraded/fallback result
 *  so the caller can abort rather than score a rate-limited rung as "wrong". */
export type RungRunner = () => Promise<Prediction[]>;

/** Default accuracy bar a rung must clear to be "good enough". Exact-match on a
 *  small clean label set is strict, so 1.0 is the floor; lower it only with a
 *  documented reason (e.g. a deliberately adversarial corpus). */
export const DEFAULT_THRESHOLD = 1.0;

/** Drop ladder rungs whose (tier, version) has no resolvable 3.x model, mirroring
 *  node-sweep's buildLadder so both sweeps walk an identical, valid ladder. */
export function buildLadder(): LadderRung[] {
  return DEFAULT_LADDER.filter((rung) => {
    try {
      resolveModelId(rung.tier, rung.version);
      return true;
    } catch {
      return false;
    }
  });
}

/**
 * Sweep one node across the ladder and pick its floor-up rung.
 *
 * For each rung: set NODE_PROFILE_OVERRIDES for THIS node only, run the corpus
 * via the injected `runRung`, score accuracy, then restore the prior env in a
 * finally (so a throw can't leak an override into the next node). A thrown
 * runner error aborts the whole sweep — we never silently treat an API failure
 * as a classification miss, which would gate out a perfectly good rung.
 */
export async function sweepNode(
  nodeId: string,
  ladder: LadderRung[],
  threshold: number,
  runRung: (rung: LadderRung) => RungRunner,
): Promise<{ nodeId: string; rungs: RungAccuracy[]; pick: FloorUpResult }> {
  const rungs: RungAccuracy[] = [];

  for (const rung of ladder) {
    const prev = process.env.NODE_PROFILE_OVERRIDES;
    process.env.NODE_PROFILE_OVERRIDES = JSON.stringify({
      [nodeId]: { tier: rung.tier, version: rung.version, thinkingLevel: rung.thinkingLevel },
    });
    try {
      const predictions = await runRung(rung)();
      rungs.push({
        rung: rung.rung,
        tier: rung.tier,
        version: rung.version,
        thinkingLevel: rung.thinkingLevel,
        accuracy: accuracy(predictions),
      });
    } catch (err) {
      // Match node-sweep: a transient API error must abort, not zero-fill — a
      // gated-out rung from a 429 would be a fabricated downsizing.
      throw new Error(
        `[${nodeId}] rung ${rung.rung} (${rung.tier}/${rung.version}) failed: ` +
          `${(err as Error).message}. Aborting universal sweep to avoid corrupted sizing.`,
      );
    } finally {
      if (prev === undefined) delete process.env.NODE_PROFILE_OVERRIDES;
      else process.env.NODE_PROFILE_OVERRIDES = prev;
    }
  }

  return { nodeId, rungs, pick: pickFloorUp(rungs, threshold) };
}

// ── Live runners (bind the real agents to the corpus + apiKey) ───────────────

function makeIntakeRunner(corpus: IntakeEntry[], apiKey: string): () => Promise<Prediction[]> {
  return async () => {
    const out: Prediction[] = [];
    for (const entry of corpus) {
      const result = await classifySlackIntake(entry.text, apiKey);
      // The agent is fail-open: a model/network error returns FALLBACK_RESULT
      // with a 'fallback:' reasoning prefix. Scoring that as a route miss would
      // unfairly fail the rung, so surface it as an abort-worthy error instead.
      if (result.reasoning.startsWith('fallback:')) {
        throw new Error(`intake fallback fired on "${entry.id}" — model call degraded`);
      }
      out.push({ expected: entry.expectedRoute, predicted: result.route });
    }
    return out;
  };
}

function makeFollowUpRunner(corpus: FollowUpEntry[], apiKey: string): () => Promise<Prediction[]> {
  return async () => {
    const out: Prediction[] = [];
    for (const entry of corpus) {
      // classifyFollowUp throws on its own degraded paths (empty/unparseable),
      // which propagates up to abort the sweep — the desired behavior.
      const result = await classifyFollowUp(entry.message, entry.thread, apiKey);
      out.push({ expected: entry.expectedIntent, predicted: result.intent });
    }
    return out;
  };
}

function renderResults(
  runDate: string,
  threshold: number,
  results: Array<{ nodeId: string; rungs: RungAccuracy[]; pick: FloorUpResult }>,
): string {
  const lines: string[] = [];
  lines.push(`# Universal-node sizing — ${runDate}`);
  lines.push('');
  lines.push(
    'Judge-free floor-up sweep (objective exact-match metric). Picks belong in the ' +
      'TEMPLATE `nodeProfiles.ts` defaults — these nodes are install-invariant.',
  );
  lines.push('');
  lines.push(`Accuracy threshold: ${threshold}`);
  lines.push('');
  for (const r of results) {
    lines.push(`## ${r.nodeId}`);
    lines.push('');
    lines.push('| Rung | Model | Thinking | Accuracy |');
    lines.push('|------|-------|----------|----------|');
    for (const rung of r.rungs) {
      const mark = rung.rung === r.pick.chosen.rung ? ' ✅' : '';
      lines.push(
        `| ${rung.rung}${mark} | ${rung.tier}/${rung.version} | ${rung.thinkingLevel} | ${rung.accuracy.toFixed(3)} |`,
      );
    }
    lines.push('');
    const p = r.pick;
    const confidence = p.metThreshold
      ? `cleared threshold (${threshold})`
      : `**did NOT clear threshold** — best-effort pick (max accuracy ${p.chosen.accuracy.toFixed(3)})`;
    lines.push(
      `**Pick:** \`${p.chosen.tier}/${p.chosen.version}\` thinking=\`${p.chosen.thinkingLevel}\` — ${confidence}`,
    );
    lines.push('');
  }
  return lines.join('\n');
}

async function main(): Promise<void> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error('GEMINI_API_KEY is required for the live universal sweep.');
    process.exit(1);
  }

  const root = process.cwd();
  const corpusPath = join(root, 'benchmarks/universal-corpus.json');
  const corpus = JSON.parse(readFileSync(corpusPath, 'utf-8')) as {
    slackIntake: IntakeEntry[];
    followUpClassifier: FollowUpEntry[];
  };

  const ladder = buildLadder();
  const threshold = DEFAULT_THRESHOLD;
  const runDate = new Date().toISOString().slice(0, 10);

  console.log(`Universal-node sweep: ${runDate}`);
  console.log(`Ladder: ${ladder.map((r) => `${r.rung}(${r.tier}/${r.version})`).join(', ')}`);
  console.log(
    `Corpus: slackIntake=${corpus.slackIntake.length}, followUpClassifier=${corpus.followUpClassifier.length}\n`,
  );

  const results: Array<{ nodeId: string; rungs: RungAccuracy[]; pick: FloorUpResult }> = [];

  console.log('── Node: slackIntake ──');
  results.push(
    await sweepNode('slackIntake', ladder, threshold, (rung) => {
      const run = makeIntakeRunner(corpus.slackIntake, apiKey);
      return async () => {
        const preds = await run();
        const acc = accuracy(preds);
        console.log(`  ${rung.rung} (${rung.tier}/${rung.version}): accuracy=${acc.toFixed(3)}`);
        return preds;
      };
    }),
  );

  console.log('── Node: followUpClassifier ──');
  results.push(
    await sweepNode('followUpClassifier', ladder, threshold, (rung) => {
      const run = makeFollowUpRunner(corpus.followUpClassifier, apiKey);
      return async () => {
        const preds = await run();
        const acc = accuracy(preds);
        console.log(`  ${rung.rung} (${rung.tier}/${rung.version}): accuracy=${acc.toFixed(3)}`);
        return preds;
      };
    }),
  );

  for (const r of results) {
    const p = r.pick;
    console.log(
      `\n→ ${r.nodeId}: ${p.chosen.tier}/${p.chosen.version} thinking=${p.chosen.thinkingLevel} ` +
        `(${p.metThreshold ? 'met threshold' : 'BEST-EFFORT — below threshold'})`,
    );
  }

  const outDir = join(root, 'benchmarks/results');
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `universal-sweep-${runDate}.md`);
  writeFileSync(outPath, renderResults(runDate, threshold, results), 'utf-8');
  console.log(`\nWrote ${outPath}`);
}

if (process.argv[1]?.endsWith('universal-sweep.ts') || process.argv[1]?.endsWith('universal-sweep.js')) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
