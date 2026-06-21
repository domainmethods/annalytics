import { describe, it, expect } from 'vitest';
import { runDiagnostics, httpStatusForReport, type DoctorDeps } from '../../src/health/doctor.js';
import type { AppConfig } from '../../src/config.js';

/** A fully-populated config; tests override slices as needed. */
function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    slack: { botToken: 'xoxb-test', signingSecret: 'sek' },
    gemini: { apiKey: 'key', model: 'gemini-pro', fileSearchStoreId: undefined },
    gcp: { projectId: 'proj' },
    dbt: { manifestPath: './dbt/manifest.json', catalogPath: './dbt/catalog.json', webhookSecret: undefined },
    limits: {
      costGateMaxBytes: 10_737_418_240,
      queryTimeoutMs: 30_000,
      maxResultRows: 1_000,
      rateLimitPerHour: 30,
    },
    escalation: {
      mode: 'channel',
      channelId: undefined,
      analystUserId: undefined,
      reminderIntervalMinutes: 30,
      timeoutHours: 4,
      onNegativeFeedback: true,
    },
    whatsapp: {
      enabled: false,
      graphApiVersion: 'v23.0',
      allowedWaIds: [],
    },
    port: 3000,
    ...overrides,
  };
}

const ok = async () => {};
const fail = async () => {
  throw new Error('connection refused to bigquery.googleapis.com project=proj');
};
const never = () => new Promise<void>(() => {}); // hangs → must hit timeout

function makeDeps(overrides: Partial<DoctorDeps> = {}): DoctorDeps {
  return {
    config: makeConfig(),
    tableCount: 12,
    uptimeSeconds: 123,
    revision: 'anna-lytics-00018-z6p',
    timestamp: '2026-06-07T00:00:00.000Z',
    probes: { firestore: ok, bigquery: ok, gemini: ok, slack: ok },
    timeoutMs: 50,
    ...overrides,
  };
}

describe('runDiagnostics', () => {
  it('reports ok with HTTP 200 when every probe and dbt are green', async () => {
    const report = await runDiagnostics(makeDeps());

    expect(report.status).toBe('ok');
    expect(httpStatusForReport(report)).toBe(200);
    expect(report.revision).toBe('anna-lytics-00018-z6p');
    expect(report.uptimeSeconds).toBe(123);
    expect(report.timestamp).toBe('2026-06-07T00:00:00.000Z');

    // every check is present and ok
    const byName = Object.fromEntries(report.checks.map((c) => [c.name, c]));
    for (const name of ['dbtArtifacts', 'firestore', 'bigquery', 'gemini', 'slack']) {
      expect(byName[name].status).toBe('ok');
      expect(typeof byName[name].durationMs).toBe('number');
    }
  });

  it('returns error + HTTP 503 when a critical probe fails', async () => {
    const report = await runDiagnostics(makeDeps({ probes: { firestore: ok, bigquery: fail, gemini: ok, slack: ok } }));

    expect(report.status).toBe('error');
    expect(httpStatusForReport(report)).toBe(503);
    const bq = report.checks.find((c) => c.name === 'bigquery')!;
    expect(bq.status).toBe('error');
    expect(bq.critical).toBe(true);
  });

  it('never leaks raw error text or identifiers into the payload detail', async () => {
    const report = await runDiagnostics(makeDeps({ probes: { firestore: fail, bigquery: ok, gemini: ok, slack: ok } }));
    const fs = report.checks.find((c) => c.name === 'firestore')!;
    expect(fs.status).toBe('error');
    // detail must be a generic, info-safe summary — not the raw error string
    expect(fs.detail).toBe('unreachable');
    expect(JSON.stringify(report)).not.toContain('googleapis.com');
    expect(JSON.stringify(report)).not.toContain('project=proj');
  });

  it('calls onError with the raw error when a probe fails', async () => {
    let loggedName: string | undefined;
    let loggedError: any;
    const testError = new Error('bq connection failed');

    await runDiagnostics(
      makeDeps({
        probes: {
          firestore: ok,
          bigquery: async () => {
            throw testError;
          },
          gemini: ok,
          slack: ok,
        },
        onError: (name, err) => {
          loggedName = name;
          loggedError = err;
        },
      })
    );

    expect(loggedName).toBe('bigquery');
    expect(loggedError).toBe(testError);
  });

  it('classifies a hung probe as timeout and overall error', async () => {
    const report = await runDiagnostics(makeDeps({ probes: { firestore: ok, bigquery: ok, gemini: never, slack: ok }, timeoutMs: 20 }));
    const gem = report.checks.find((c) => c.name === 'gemini')!;
    expect(gem.status).toBe('timeout');
    expect(gem.detail).toBe('timed out');
    expect(report.status).toBe('error'); // gemini is critical
  });

  it('degrades (not errors) when dbt artifacts are absent but all critical deps are up', async () => {
    const report = await runDiagnostics(makeDeps({ tableCount: 0 }));

    expect(report.status).toBe('degraded');
    expect(httpStatusForReport(report)).toBe(200); // degraded is still serving
    const dbt = report.checks.find((c) => c.name === 'dbtArtifacts')!;
    expect(dbt.status).toBe('error');
    expect(dbt.critical).toBe(false); // INFORMATION_SCHEMA fallback exists
  });

  it('derives the feature report from config', async () => {
    const report = await runDiagnostics(
      makeDeps({
        config: makeConfig({
          gemini: { apiKey: 'k', model: 'm', fileSearchStoreId: 'store-123' },
          dbt: { manifestPath: 'm', catalogPath: 'c', webhookSecret: 'shh' },
          escalation: {
            mode: 'dm',
            channelId: undefined,
            analystUserId: undefined, // dm mode but no analyst → target NOT configured
            reminderIntervalMinutes: 30,
            timeoutHours: 4,
            onNegativeFeedback: false,
          },
        }),
      }),
    );

    expect(report.features.fileSearch).toBe(true);
    expect(report.features.dbtWebhookIngestion).toBe(true);
    expect(report.features.escalation.mode).toBe('dm');
    expect(report.features.escalation.targetConfigured).toBe(false);
    expect(report.features.escalation.onNegativeFeedback).toBe(false);
    expect(report.features).toEqual(expect.objectContaining({
      whatsapp: expect.objectContaining({
        enabled: false,
        configured: false,
        allowlistSize: 0,
      }),
    }));
  });

  it('marks escalation target configured when the active mode has its target set', async () => {
    const channelReport = await runDiagnostics(
      makeDeps({
        config: makeConfig({
          escalation: {
            mode: 'channel',
            channelId: 'C123',
            analystUserId: undefined,
            reminderIntervalMinutes: 30,
            timeoutHours: 4,
            onNegativeFeedback: true,
          },
        }),
      }),
    );
    expect(channelReport.features.escalation.targetConfigured).toBe(true);
  });

  it('echoes the non-sensitive limits', async () => {
    const report = await runDiagnostics(makeDeps());
    expect(report.limits).toEqual({
      costGateMaxBytes: 10_737_418_240,
      queryTimeoutMs: 30_000,
      maxResultRows: 1_000,
      rateLimitPerHour: 30,
    });
  });
});
