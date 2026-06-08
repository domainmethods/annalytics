import { describe, it, expect, afterEach } from 'vitest';
import {
  accuracy,
  pickFloorUp,
  type RungAccuracy,
} from '../../scripts/universal-sweep-core.js';
import { sweepNode, withRetry } from '../../scripts/universal-sweep.js';
import { DEFAULT_LADDER } from '../../scripts/node-sweep-types.js';

describe('accuracy', () => {
  it('returns 1.0 when every prediction matches its label', () => {
    const result = accuracy([
      { expected: 'a', predicted: 'a' },
      { expected: 'b', predicted: 'b' },
    ]);
    expect(result).toBe(1.0);
  });

  it('returns the fraction of exact-match predictions', () => {
    const result = accuracy([
      { expected: 'a', predicted: 'a' },
      { expected: 'b', predicted: 'a' },
      { expected: 'c', predicted: 'c' },
      { expected: 'd', predicted: 'x' },
    ]);
    expect(result).toBe(0.5);
  });

  it('returns 0 for an empty set rather than dividing by zero', () => {
    expect(accuracy([])).toBe(0);
  });
});

describe('pickFloorUp', () => {
  // The ladder is ordered cheapest → most expensive. Floor-up means: take the
  // CHEAPEST rung that clears the accuracy threshold — don't pay for capability
  // a simple classifier doesn't need.
  const ladder: RungAccuracy[] = [
    { rung: 'R0', tier: 'flash-lite', version: '3.1', thinkingLevel: 'minimal', accuracy: 1.0 },
    { rung: 'R2', tier: 'flash', version: '3', thinkingLevel: 'minimal', accuracy: 1.0 },
    { rung: 'R4', tier: 'pro', version: '3.1', thinkingLevel: 'low', accuracy: 1.0 },
  ];

  it('picks the cheapest rung that meets the threshold', () => {
    const result = pickFloorUp(ladder, 1.0);
    expect(result.chosen.rung).toBe('R0');
    expect(result.metThreshold).toBe(true);
  });

  it('climbs past rungs that fail the threshold to the first that passes', () => {
    const climbed: RungAccuracy[] = [
      { rung: 'R0', tier: 'flash-lite', version: '3.1', thinkingLevel: 'minimal', accuracy: 0.6 },
      { rung: 'R2', tier: 'flash', version: '3', thinkingLevel: 'minimal', accuracy: 0.9 },
      { rung: 'R4', tier: 'pro', version: '3.1', thinkingLevel: 'low', accuracy: 1.0 },
    ];
    const result = pickFloorUp(climbed, 0.9);
    expect(result.chosen.rung).toBe('R2');
    expect(result.metThreshold).toBe(true);
  });

  it('falls back to the highest-accuracy rung when none meet the threshold, tie-breaking to cheapest', () => {
    const allShort: RungAccuracy[] = [
      { rung: 'R0', tier: 'flash-lite', version: '3.1', thinkingLevel: 'minimal', accuracy: 0.7 },
      { rung: 'R2', tier: 'flash', version: '3', thinkingLevel: 'minimal', accuracy: 0.8 },
      { rung: 'R4', tier: 'pro', version: '3.1', thinkingLevel: 'low', accuracy: 0.8 },
    ];
    const result = pickFloorUp(allShort, 1.0);
    expect(result.chosen.rung).toBe('R2'); // first (cheapest) of the 0.8 tie
    expect(result.metThreshold).toBe(false);
  });

  it('throws on an empty ladder rather than returning a bogus pick', () => {
    expect(() => pickFloorUp([], 1.0)).toThrow();
  });
});

describe('withRetry', () => {
  it('resolves once an attempt succeeds, tolerating earlier transient failures', async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls += 1;
        if (calls < 3) throw new Error('transient blip');
        return 'ok';
      },
      3,
      0, // no backoff delay in tests
    );
    expect(result).toBe('ok');
    expect(calls).toBe(3);
  });

  it('re-throws the last error after exhausting all attempts', async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls += 1;
          throw new Error(`persistent failure ${calls}`);
        },
        3,
        0,
      ),
    ).rejects.toThrow('persistent failure 3');
    expect(calls).toBe(3);
  });
});

describe('sweepNode', () => {
  afterEach(() => {
    delete process.env.NODE_PROFILE_OVERRIDES;
  });

  it('sets a per-rung override and picks the cheapest perfect rung, restoring env after', async () => {
    const prevSeen: Array<string | undefined> = [];
    const result = await sweepNode('slackIntake', DEFAULT_LADDER, 1.0, (rung) => async () => {
      // The override for THIS node/rung must be live while the runner executes.
      prevSeen.push(process.env.NODE_PROFILE_OVERRIDES);
      // Every rung classifies perfectly → floor-up should take the cheapest (R0).
      return [
        { expected: 'immediate_response', predicted: 'immediate_response' },
        { expected: 'analytics_pipeline', predicted: 'analytics_pipeline' },
      ];
    });

    expect(result.pick.chosen.rung).toBe('R0');
    expect(result.pick.metThreshold).toBe(true);
    // Each rung saw its own override JSON set.
    expect(prevSeen.every((o) => o && o.includes('slackIntake'))).toBe(true);
    // Env restored to undefined after the sweep.
    expect(process.env.NODE_PROFILE_OVERRIDES).toBeUndefined();
  });

  it('aborts the whole sweep when a rung runner throws, and restores env', async () => {
    let calls = 0;
    await expect(
      sweepNode('followUpClassifier', DEFAULT_LADDER, 1.0, () => async () => {
        calls += 1;
        if (calls >= 2) throw new Error('simulated 429');
        return [{ expected: 'refinement', predicted: 'refinement' }];
      }),
    ).rejects.toThrow(/simulated 429/);
    // Aborted on the 2nd rung — did not silently continue through all six.
    expect(calls).toBe(2);
    // Env restored despite the throw.
    expect(process.env.NODE_PROFILE_OVERRIDES).toBeUndefined();
  });
});
