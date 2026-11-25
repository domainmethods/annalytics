import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createStatusReporter, formatElapsed } from '../../src/slack/statusReporter.js';

/** A write whose completion the test controls. */
function deferredWrites() {
  const texts: string[] = [];
  const releases: Array<() => void> = [];
  const write = vi.fn((text: string) => {
    texts.push(text);
    return new Promise<void>((resolve) => { releases.push(resolve); });
  });
  return { texts, write, releaseNext: () => releases.shift()?.() };
}

function recordingWrites() {
  const texts: string[] = [];
  const write = vi.fn(async (text: string) => { texts.push(text); });
  return { texts, write };
}

describe('formatElapsed', () => {
  it('shows nothing until ten seconds have passed', () => {
    expect(formatElapsed(0)).toBe('');
    expect(formatElapsed(9_999)).toBe('');
  });

  it('rounds down to the last ten seconds', () => {
    expect(formatElapsed(10_000)).toBe('10s');
    expect(formatElapsed(29_999)).toBe('20s');
    expect(formatElapsed(59_999)).toBe('50s');
  });

  it('switches to minutes at one minute', () => {
    expect(formatElapsed(60_000)).toBe('1m');
    expect(formatElapsed(120_000)).toBe('2m');
  });

  it('moves in thirty-second steps after the first minute', () => {
    expect(formatElapsed(75_000)).toBe('1m');
    expect(formatElapsed(89_999)).toBe('1m');
    expect(formatElapsed(90_000)).toBe('1m 30s');
    expect(formatElapsed(130_000)).toBe('2m');
    expect(formatElapsed(150_000)).toBe('2m 30s');
  });
});

describe('createStatusReporter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('set', () => {
    it('writes the text as given outside a heartbeat region', async () => {
      const { texts, write } = recordingWrites();
      const status = createStatusReporter({ write });

      await vi.advanceTimersByTimeAsync(30_000);
      await status.set('Reading your question...');

      expect(texts).toEqual(['Reading your question...']);
    });

    it('never rejects when the write fails, and reports the failure', async () => {
      const failure = new Error('ratelimited');
      const onError = vi.fn();
      const status = createStatusReporter({ write: vi.fn().mockRejectedValue(failure), onError });

      await expect(status.set('Reading your question...')).resolves.toBeUndefined();

      expect(onError).toHaveBeenCalledWith(failure, 'Reading your question...');
    });

    it('keeps writes in the order they were requested', async () => {
      const { texts, write, releaseNext } = deferredWrites();
      const status = createStatusReporter({ write });

      const first = status.set('one');
      const second = status.set('two');
      await vi.advanceTimersByTimeAsync(0);
      expect(texts).toEqual(['one']);

      releaseNext();
      await first;
      await vi.advanceTimersByTimeAsync(0);
      expect(texts).toEqual(['one', 'two']);

      releaseNext();
      await second;
    });
  });

  describe('withHeartbeat', () => {
    it('rewrites the current status with the elapsed time while the work runs', async () => {
      const { texts, write } = recordingWrites();
      const status = createStatusReporter({ write });

      await status.withHeartbeat(async () => {
        await status.set('Researching the best approach...');
        await vi.advanceTimersByTimeAsync(25_000);
      });

      expect(texts).toEqual([
        'Researching the best approach...',
        'Researching the best approach... (10s)',
        'Researching the best approach... (20s)',
      ]);
    });

    it('counts elapsed time from when the reporter was created, not from the region', async () => {
      const { texts, write } = recordingWrites();
      const status = createStatusReporter({ write });
      await vi.advanceTimersByTimeAsync(42_000);

      await status.withHeartbeat(async () => {
        await status.set('Retrieving the data...');
        await vi.advanceTimersByTimeAsync(10_000);
      });

      expect(texts).toEqual(['Retrieving the data... (40s)', 'Retrieving the data... (50s)']);
    });

    it('rewrites every thirty seconds once the request is past its first minute', async () => {
      const { texts, write } = recordingWrites();
      const status = createStatusReporter({ write });

      await status.withHeartbeat(async () => {
        await status.set('Retrieving the data...');
        await vi.advanceTimersByTimeAsync(125_000);
      });

      expect(texts).toEqual([
        'Retrieving the data...',
        'Retrieving the data... (10s)',
        'Retrieving the data... (20s)',
        'Retrieving the data... (30s)',
        'Retrieving the data... (40s)',
        'Retrieving the data... (50s)',
        'Retrieving the data... (1m)',
        'Retrieving the data... (1m 30s)',
        'Retrieving the data... (2m)',
      ]);
    });

    it('writes a new status at once after the first minute', async () => {
      const { texts, write } = recordingWrites();
      const status = createStatusReporter({ write });
      await vi.advanceTimersByTimeAsync(75_000);

      await status.withHeartbeat(async () => {
        await status.set('Checking the cost...');
        await vi.advanceTimersByTimeAsync(5_000);
        await status.set('Retrieving the data...');
      });

      expect(texts).toEqual(['Checking the cost... (1m)', 'Retrieving the data... (1m)']);
    });

    it('does not rewrite when the text would not change', async () => {
      const { texts, write } = recordingWrites();
      const status = createStatusReporter({ write, intervalMs: 2_000 });

      await status.withHeartbeat(async () => {
        await status.set('Researching the best approach...');
        await vi.advanceTimersByTimeAsync(9_000); // four ticks, all under ten seconds
      });

      expect(texts).toEqual(['Researching the best approach...']);
    });

    it('skips ticks while a write is still in flight', async () => {
      const { texts, write, releaseNext } = deferredWrites();
      const status = createStatusReporter({ write });
      let finishWork!: () => void;

      const region = status.withHeartbeat(() => new Promise<void>((resolve) => { finishWork = resolve; }));
      void status.set('Researching the best approach...');

      await vi.advanceTimersByTimeAsync(35_000); // three ticks, first write never returned
      expect(texts).toEqual(['Researching the best approach...']);

      releaseNext();
      await vi.advanceTimersByTimeAsync(10_000); // the next tick is free to write
      expect(texts).toEqual([
        'Researching the best approach...',
        'Researching the best approach... (40s)',
      ]);

      releaseNext();
      finishWork();
      await region;
    });

    it('does not resolve until an in-flight tick write has finished', async () => {
      const { texts, write, releaseNext } = deferredWrites();
      const status = createStatusReporter({ write });
      let regionDone = false;

      const set = status.set('Researching the best approach...');
      await vi.advanceTimersByTimeAsync(0);
      releaseNext();
      await set;

      const region = status
        .withHeartbeat(() => new Promise<void>((resolve) => { setTimeout(resolve, 10_500); }))
        .then(() => { regionDone = true; });

      await vi.advanceTimersByTimeAsync(11_000); // tick at 10s is in flight, work done at 10.5s
      expect(texts).toEqual(['Researching the best approach...', 'Researching the best approach... (10s)']);
      expect(regionDone).toBe(false);

      releaseNext();
      await region;
      expect(regionDone).toBe(true);
    });

    it('stops ticking once the work is done', async () => {
      const { texts, write } = recordingWrites();
      const status = createStatusReporter({ write });

      await status.withHeartbeat(async () => {
        await status.set('Researching the best approach...');
        await vi.advanceTimersByTimeAsync(10_000);
      });
      await vi.advanceTimersByTimeAsync(120_000);

      expect(texts).toEqual([
        'Researching the best approach...',
        'Researching the best approach... (10s)',
      ]);
    });

    it('writes later statuses without the elapsed time once the region has ended', async () => {
      const { texts, write } = recordingWrites();
      const status = createStatusReporter({ write });

      await status.withHeartbeat(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });
      await status.set('I was not able to answer that.');

      expect(texts).toEqual(['I was not able to answer that.']);
    });

    it('keeps rewriting when a nested region ends before the outer one', async () => {
      const { texts, write } = recordingWrites();
      const status = createStatusReporter({ write });

      await status.withHeartbeat(async () => {
        await status.set('Researching the best approach...');
        await status.withHeartbeat(async () => {
          await vi.advanceTimersByTimeAsync(10_000);
        });
        await vi.advanceTimersByTimeAsync(10_000);
      });

      expect(texts).toEqual([
        'Researching the best approach...',
        'Researching the best approach... (10s)',
        'Researching the best approach... (20s)',
      ]);
    });

    it('stops rewriting once the outermost of nested regions has ended', async () => {
      const { texts, write } = recordingWrites();
      const status = createStatusReporter({ write });

      await status.withHeartbeat(async () => {
        await status.set('Researching the best approach...');
        await status.withHeartbeat(async () => {
          await vi.advanceTimersByTimeAsync(10_000);
        });
      });
      await vi.advanceTimersByTimeAsync(120_000);

      expect(texts).toEqual([
        'Researching the best approach...',
        'Researching the best approach... (10s)',
      ]);
    });

    it('returns what the work returns', async () => {
      const status = createStatusReporter({ write: vi.fn().mockResolvedValue(undefined) });

      await expect(status.withHeartbeat(async () => 42)).resolves.toBe(42);
    });

    it('passes the work failure through and stops ticking', async () => {
      const { texts, write } = recordingWrites();
      const status = createStatusReporter({ write });
      await status.set('Researching the best approach...');

      await expect(status.withHeartbeat(async () => { throw new Error('generation failed'); }))
        .rejects.toThrow('generation failed');
      await vi.advanceTimersByTimeAsync(60_000);

      expect(texts).toEqual(['Researching the best approach...']);
    });

    it('keeps ticking after a failed write', async () => {
      const texts: string[] = [];
      const write = vi.fn(async (text: string) => {
        texts.push(text);
        if (text.endsWith('(10s)')) throw new Error('ratelimited');
      });
      const status = createStatusReporter({ write, onError: vi.fn() });

      await status.withHeartbeat(async () => {
        await status.set('Researching the best approach...');
        await vi.advanceTimersByTimeAsync(20_000);
      });

      expect(texts).toEqual([
        'Researching the best approach...',
        'Researching the best approach... (10s)',
        'Researching the best approach... (20s)',
      ]);
    });

    it('retries a failed rewrite at the next check, without waiting for the next step', async () => {
      const texts: string[] = [];
      let failed = false;
      const write = vi.fn(async (text: string) => {
        texts.push(text);
        if (text.endsWith('(1m)') && !failed) {
          failed = true;
          throw new Error('ratelimited');
        }
      });
      const status = createStatusReporter({ write, onError: vi.fn() });
      await vi.advanceTimersByTimeAsync(55_000);

      await status.withHeartbeat(async () => {
        await status.set('Retrieving the data...');
        await vi.advanceTimersByTimeAsync(30_000); // checks at 1m 05s, 1m 15s, 1m 25s
      });

      expect(texts).toEqual([
        'Retrieving the data... (50s)',
        'Retrieving the data... (1m)',
        'Retrieving the data... (1m)',
      ]);
    });
  });
});
