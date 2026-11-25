/**
 * Status text for a request that is being worked on.
 *
 * The status lives in one message that is edited in place, and the answer is
 * later written to that same message. Two rules follow from that:
 *
 *  - Writes are sequential, so an older status can never land on top of a newer one.
 *  - A heartbeat region does not finish until every write it started has
 *    finished, so a late rewrite can never land on top of the answer.
 *
 * Inside a heartbeat region the current status is rewritten with the time
 * elapsed, so a long step still shows that the request is alive. The time moves
 * in ten-second steps for the first minute and thirty-second steps after it,
 * and a rewrite happens only when the text changes, so a long request settles
 * at two rewrites a minute. Every rewrite counts against the same Slack rate
 * budget as the answers.
 */

export interface StatusReporterOptions {
  /** Writes the status text. May reject; the reporter never does. */
  write: (text: string) => Promise<unknown>;
  /** Called with the failure and the text that could not be written. */
  onError?: (err: unknown, text: string) => void;
  /**
   * How often a heartbeat region checks whether the elapsed time has moved on
   * a step. It rewrites the status only when it has.
   */
  intervalMs?: number;
}

export interface StatusReporter {
  /** Write a status. Resolves once the write has settled; never rejects. */
  set(text: string): Promise<void>;
  /**
   * Run `work`, refreshing the elapsed time on the current status while it
   * runs. Resolves or rejects with `work`, after the last status write.
   */
  withHeartbeat<T>(work: () => Promise<T>): Promise<T>;
}

const DEFAULT_INTERVAL_MS = 10_000;
const FIRST_MINUTE_STEP_SECONDS = 10;
const LATER_STEP_SECONDS = 30;

/**
 * Elapsed time in steps: '' under ten seconds, then '10s' to '50s', then
 * '1m', '1m 30s', '2m'. The steps set how often the heartbeat writes, because
 * it rewrites the status only when this text changes.
 */
export function formatElapsed(ms: number): string {
  const elapsed = Math.floor(ms / 1000);
  const step = elapsed < 60 ? FIRST_MINUTE_STEP_SECONDS : LATER_STEP_SECONDS;
  const total = Math.floor(elapsed / step) * step;
  if (total < FIRST_MINUTE_STEP_SECONDS) return '';
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes === 0) return `${seconds}s`;
  return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
}

export function createStatusReporter(options: StatusReporterOptions): StatusReporter {
  const { write, onError, intervalMs = DEFAULT_INTERVAL_MS } = options;
  const startedAt = Date.now();

  let current: string | undefined;
  let lastWritten: string | undefined;
  let pendingWrites = 0;
  let regionDepth = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  let tail: Promise<void> = Promise.resolve();

  const render = (text: string): string => {
    if (regionDepth === 0) return text;
    const elapsed = formatElapsed(Date.now() - startedAt);
    return elapsed ? `${text} (${elapsed})` : text;
  };

  const enqueue = (text: string): Promise<void> => {
    pendingWrites++;
    tail = tail.then(async () => {
      // Rendered when the write starts, so a queued status shows the current time.
      const rendered = render(text);
      try {
        await write(rendered);
        lastWritten = rendered;
      } catch (err) {
        try {
          onError?.(err, rendered);
        } catch {
          // A failing error handler must not break the write chain.
        }
      } finally {
        pendingWrites--;
      }
    });
    return tail;
  };

  const tick = (): void => {
    // A write still in flight means the last one has not returned (slow or
    // rate-limited); adding another would only queue up stale text.
    if (pendingWrites > 0 || current === undefined) return;
    if (render(current) === lastWritten) return;
    void enqueue(current);
  };

  return {
    set(text: string): Promise<void> {
      current = text;
      return enqueue(text);
    },

    async withHeartbeat<T>(work: () => Promise<T>): Promise<T> {
      regionDepth++;
      if (regionDepth === 1) {
        timer = setInterval(tick, intervalMs);
        timer.unref?.();
      }
      try {
        return await work();
      } finally {
        regionDepth--;
        if (regionDepth === 0 && timer) {
          clearInterval(timer);
          timer = undefined;
        }
        await tail;
      }
    },
  };
}
