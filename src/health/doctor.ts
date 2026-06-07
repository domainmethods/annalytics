import type { AppConfig } from '../config.js';

/**
 * Diagnostic ("doctor") report for the bot's runtime health.
 *
 * Distinct from the plain `/health` liveness ping: this actively probes every
 * external dependency and reports which optional features are configured. The
 * payload is intentionally INFO-SAFE — booleans, enums, counts, durations, and
 * generic status summaries only. No project IDs, store IDs, channel IDs,
 * tokens, or raw error strings ever appear here (raw probe errors are logged
 * server-side instead). This keeps the endpoint safe to expose to uptime
 * monitors without leaking infrastructure posture or secrets.
 */

export type CheckStatus = 'ok' | 'error' | 'timeout';
export type OverallStatus = 'ok' | 'degraded' | 'error';

export interface CheckResult {
  name: string;
  /** Critical checks fail the whole report (HTTP 503); non-critical degrade it. */
  critical: boolean;
  status: CheckStatus;
  durationMs: number;
  /** Generic, info-safe summary present only when status !== 'ok'. */
  detail?: string;
}

export interface DiagnosticReport {
  status: OverallStatus;
  revision: string;
  uptimeSeconds: number;
  timestamp: string;
  features: {
    fileSearch: boolean;
    dbtWebhookIngestion: boolean;
    escalation: {
      mode: 'channel' | 'dm';
      targetConfigured: boolean;
      onNegativeFeedback: boolean;
    };
  };
  limits: {
    costGateMaxBytes: number;
    queryTimeoutMs: number;
    maxResultRows: number;
    rateLimitPerHour: number;
  };
  checks: CheckResult[];
}

/** A dependency probe: resolves if the dependency is reachable, throws otherwise. */
export type Probe = () => Promise<void>;

export interface DoctorDeps {
  config: AppConfig;
  /** Number of dbt tables loaded into memory at boot (0 ⇒ semantic layer absent). */
  tableCount: number;
  uptimeSeconds: number;
  revision: string;
  /** ISO timestamp — injected so the report is deterministic for tests. */
  timestamp: string;
  probes: {
    firestore: Probe;
    bigquery: Probe;
    gemini: Probe;
    slack: Probe;
  };
  /** Per-probe timeout. A probe slower than this is reported as `timeout`. */
  timeoutMs?: number;
  /** Callback to log raw connection/probe errors server-side. */
  onError?: (name: string, err: unknown) => void;
}

const DEFAULT_TIMEOUT_MS = 5_000;
const TIMEOUT_SENTINEL = Symbol('probe-timeout');

/** Race a probe against a timeout without leaving a dangling timer. */
async function withTimeout(probe: Probe, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(TIMEOUT_SENTINEL), timeoutMs);
  });
  try {
    await Promise.race([probe(), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function runProbe(
  name: string,
  critical: boolean,
  probe: Probe,
  timeoutMs: number,
  onError?: (name: string, err: unknown) => void
): Promise<CheckResult> {
  const start = Date.now();
  try {
    await withTimeout(probe, timeoutMs);
    return { name, critical, status: 'ok', durationMs: Date.now() - start };
  } catch (err) {
    const timedOut = err === TIMEOUT_SENTINEL;
    if (onError) {
      try {
        onError(name, err);
      } catch {
        // Prevent logging errors from crashing the healthcheck pipeline itself
      }
    }
    return {
      name,
      critical,
      status: timedOut ? 'timeout' : 'error',
      durationMs: Date.now() - start,
      // Generic, info-safe detail only — never the raw error (which may carry
      // project IDs, table names, or URLs). The caller logs the real error.
      detail: timedOut ? 'timed out' : 'unreachable',
    };
  }
}

function escalationTargetConfigured(esc: AppConfig['escalation']): boolean {
  return esc.mode === 'channel' ? Boolean(esc.channelId) : Boolean(esc.analystUserId);
}

export async function runDiagnostics(deps: DoctorDeps): Promise<DiagnosticReport> {
  const { config, tableCount } = deps;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // dbt artifacts are an in-memory, synchronous check. Non-critical: if they're
  // absent the pipeline still answers via the INFORMATION_SCHEMA fallback route
  // (with a ⚠️ warning), so missing artifacts degrade rather than break the bot.
  const dbtCheck: CheckResult = {
    name: 'dbtArtifacts',
    critical: false,
    status: tableCount > 0 ? 'ok' : 'error',
    durationMs: 0,
    ...(tableCount > 0 ? {} : { detail: 'no tables loaded' }),
  };

  // The four external dependencies — all critical to serving a query. Probed in
  // parallel so the endpoint's latency is the slowest single probe, not the sum.
  const [firestore, bigquery, gemini, slack] = await Promise.all([
    runProbe('firestore', true, deps.probes.firestore, timeoutMs, deps.onError),
    runProbe('bigquery', true, deps.probes.bigquery, timeoutMs, deps.onError),
    runProbe('gemini', true, deps.probes.gemini, timeoutMs, deps.onError),
    runProbe('slack', true, deps.probes.slack, timeoutMs, deps.onError),
  ]);

  const checks = [dbtCheck, firestore, bigquery, gemini, slack];

  const criticalFailed = checks.some((c) => c.critical && c.status !== 'ok');
  const anyFailed = checks.some((c) => c.status !== 'ok');
  const status: OverallStatus = criticalFailed ? 'error' : anyFailed ? 'degraded' : 'ok';

  return {
    status,
    revision: deps.revision,
    uptimeSeconds: deps.uptimeSeconds,
    timestamp: deps.timestamp,
    features: {
      fileSearch: Boolean(config.gemini.fileSearchStoreId),
      dbtWebhookIngestion: Boolean(config.dbt.webhookSecret),
      escalation: {
        mode: config.escalation.mode,
        targetConfigured: escalationTargetConfigured(config.escalation),
        onNegativeFeedback: config.escalation.onNegativeFeedback,
      },
    },
    limits: {
      costGateMaxBytes: config.limits.costGateMaxBytes,
      queryTimeoutMs: config.limits.queryTimeoutMs,
      maxResultRows: config.limits.maxResultRows,
      rateLimitPerHour: config.limits.rateLimitPerHour,
    },
    checks,
  };
}

/** Map a report to its HTTP status: degraded still serves (200), error is 503. */
export function httpStatusForReport(report: DiagnosticReport): number {
  return report.status === 'error' ? 503 : 200;
}
