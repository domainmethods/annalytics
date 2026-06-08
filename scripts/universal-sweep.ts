import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { listGemini3xModels } from '../src/agents/modelConfig.js';
import type { ThinkingLevel } from '../src/agents/nodeProfiles.js';
import { classifySlackIntake } from '../src/agents/slackIntakeAgent.js';
import { classifyFollowUp } from '../src/agents/followUpClassifier.js';
import type { ThreadMessage } from '../src/types.js';
import {
  accuracy,
  pickFloorUp,
  type Prediction,
  type ModelRung,
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

// Thinking anchor for the model sweep. These nodes do CLOSED-SET classification
// (route / intent) — structurally the kind of task that needs no open reasoning —
// and the prior sweep found them flat-at-CEILING (1.000) at every model. So we
// hold thinking at `minimal` and let the floor-up rule pick across MODELS only;
// paying for more thinking on a task that already classifies perfectly is pure waste.
export const UNIVERSAL_ANCHOR: ThinkingLevel = 'minimal';

/**
 * The candidate ladder: EVERY Gemini 3.x model (listGemini3xModels — the registry,
 * not a hand-authored subset, so coverage can't silently drop a model) at the fixed
 * thinking anchor. listGemini3xModels() is already ordered cheapest-tier-first, which
 * is exactly the ordering pickFloorUp requires ("cheapest that passes" = "first that
 * passes"). One axis varies — the model — so a pick is attributable to the model alone.
 */
export function buildModelLadder(): ModelRung[] {
  return listGemini3xModels().map((m) => ({
    rung: `${m.tier}/${m.version}`,
    tier: m.tier,
    version: m.version,
    thinkingLevel: UNIVERSAL_ANCHOR,
  }));
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
  ladder: ModelRung[],
  threshold: number,
  runRung: (rung: ModelRung) => RungRunner,
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

// In a MEASUREMENT run we want the model's actual answer, not a production
// latency-bounded fail-open: classifySlackIntake's 8s prod cap (fail-open into
// analytics_pipeline) would score a cold-start blip as a route miss. Give it
// generous headroom — we measure the routing decision, not its p95 here.
const SWEEP_INTAKE_TIMEOUT_MS = 30_000;
// Bounded retry so a single transient timeout/429 doesn't abort the whole sweep,
// while a persistent failure still aborts (vs. silently scoring it as a miss).
const CLASSIFY_ATTEMPTS = 3;

/** Retry an async op a few times before giving up, so one transient blip doesn't
 *  abort a long measurement run. Re-throws the LAST error once attempts run out. */
export async function withRetry<T>(fn: () => Promise<T>, attempts = 3, delayMs = 1000): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

async function classifyIntakeRoute(text: string, apiKey: string, entryId: string): Promise<string> {
  const result = await classifySlackIntake(text, apiKey, { timeoutMs: SWEEP_INTAKE_TIMEOUT_MS });
  // The agent is fail-open: a model/network error returns FALLBACK_RESULT with a
  // 'fallback:' reasoning prefix. Throw so withRetry can re-attempt; a persistent
  // fallback exhausts the retries and aborts the sweep (never scored as a miss).
  if (result.reasoning.startsWith('fallback:')) {
    throw new Error(`intake fallback fired on "${entryId}" — model call degraded`);
  }
  return result.route;
}

function makeIntakeRunner(corpus: IntakeEntry[], apiKey: string): () => Promise<Prediction[]> {
  return async () => {
    const out: Prediction[] = [];
    for (const entry of corpus) {
      const route = await withRetry(
        () => classifyIntakeRoute(entry.text, apiKey, entry.id),
        CLASSIFY_ATTEMPTS,
      );
      out.push({ expected: entry.expectedRoute, predicted: route });
    }
    return out;
  };
}

function makeFollowUpRunner(corpus: FollowUpEntry[], apiKey: string): () => Promise<Prediction[]> {
  return async () => {
    const out: Prediction[] = [];
    for (const entry of corpus) {
      // classifyFollowUp throws on its own degraded paths (empty/unparseable);
      // withRetry re-attempts transient ones, then aborts the sweep if persistent.
      const result = await withRetry(
        () => classifyFollowUp(entry.message, entry.thread, apiKey),
        CLASSIFY_ATTEMPTS,
      );
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

  const ladder = buildModelLadder();
  const threshold = DEFAULT_THRESHOLD;
  const runDate = new Date().toISOString().slice(0, 10);

  console.log(`Universal-node sweep: ${runDate}`);
  console.log(`Models (@thinking=${UNIVERSAL_ANCHOR}): ${ladder.map((r) => r.rung).join(', ')}`);
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
