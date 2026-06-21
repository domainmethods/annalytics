import { describe, it, expect, vi, beforeEach } from 'vitest';
import { loadConfig } from '../src/config.js';

// Minimal env so loadConfig() does not throw on requireEnv().
function baseEnv() {
  vi.stubEnv('SLACK_BOT_TOKEN', 'xoxb-test');
  vi.stubEnv('SLACK_SIGNING_SECRET', 'secret');
  vi.stubEnv('GEMINI_API_KEY', 'key');
  vi.stubEnv('GCP_PROJECT_ID', 'proj');
}

describe('loadConfig escalation.onNegativeFeedback', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    baseEnv();
  });

  it('defaults to true when ESCALATION_ON_NEGATIVE_FEEDBACK is unset', () => {
    expect(loadConfig().escalation.onNegativeFeedback).toBe(true);
  });

  it('is false when ESCALATION_ON_NEGATIVE_FEEDBACK="false"', () => {
    vi.stubEnv('ESCALATION_ON_NEGATIVE_FEEDBACK', 'false');
    expect(loadConfig().escalation.onNegativeFeedback).toBe(false);
  });

  it('is true when ESCALATION_ON_NEGATIVE_FEEDBACK="true"', () => {
    vi.stubEnv('ESCALATION_ON_NEGATIVE_FEEDBACK', 'true');
    expect(loadConfig().escalation.onNegativeFeedback).toBe(true);
  });

  it('throws fail-fast on an invalid ESCALATION_ON_NEGATIVE_FEEDBACK value', () => {
    vi.stubEnv('ESCALATION_ON_NEGATIVE_FEEDBACK', 'invalid-value');
    expect(() => loadConfig()).toThrow(/must be "true" or "false"/);
  });
});

describe('loadConfig lifecycleSweepSecret', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    baseEnv();
  });

  it('is undefined when LIFECYCLE_SWEEP_SECRET is unset', () => {
    expect(loadConfig().lifecycleSweepSecret).toBeUndefined();
  });

  it('is undefined when LIFECYCLE_SWEEP_SECRET is empty', () => {
    vi.stubEnv('LIFECYCLE_SWEEP_SECRET', '');
    expect(loadConfig().lifecycleSweepSecret).toBeUndefined();
  });

  it('parses LIFECYCLE_SWEEP_SECRET from env', () => {
    vi.stubEnv('LIFECYCLE_SWEEP_SECRET', 'sweep-secret');
    expect(loadConfig().lifecycleSweepSecret).toBe('sweep-secret');
  });
});

describe('loadConfig fastPath', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    baseEnv();
  });

  it('defaults the routine fast path off with a 1GB fast-path limit and forced supervisor review', () => {
    const config = loadConfig();
    expect(config.fastPath).toEqual({
      enabled: false,
      maxBytesProcessed: 1_073_741_824,
      requireSupervisor: true,
    });
  });

  it('parses routine fast-path flags from env', () => {
    vi.stubEnv('FAST_PATH_ENABLED', 'true');
    vi.stubEnv('FAST_PATH_MAX_BYTES', '524288000');
    vi.stubEnv('FAST_PATH_REQUIRE_SUPERVISOR', 'false');

    const config = loadConfig();

    expect(config.fastPath).toEqual({
      enabled: true,
      maxBytesProcessed: 524_288_000,
      requireSupervisor: false,
    });
  });

  it('throws on invalid routine fast-path booleans', () => {
    vi.stubEnv('FAST_PATH_ENABLED', 'yes');
    expect(() => loadConfig()).toThrow(/FAST_PATH_ENABLED must be "true" or "false"/);
  });
});

describe('loadConfig whatsapp', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it('leaves WhatsApp disabled by default without requiring WhatsApp secrets', async () => {
    vi.stubEnv('SLACK_BOT_TOKEN', 'xoxb-test');
    vi.stubEnv('SLACK_SIGNING_SECRET', 'slack-secret');
    vi.stubEnv('GEMINI_API_KEY', 'gemini-key');
    vi.stubEnv('GCP_PROJECT_ID', 'gcp-project');
    vi.stubEnv('WHATSAPP_ENABLED', '');
    vi.resetModules();

    const { loadConfig } = await import('../src/config.js');
    const config = loadConfig();

    expect(config.whatsapp.enabled).toBe(false);
    expect(config.whatsapp.allowedWaIds).toEqual([]);
    vi.unstubAllEnvs();
  });

  it('requires WhatsApp secrets only when WhatsApp is enabled', async () => {
    vi.stubEnv('SLACK_BOT_TOKEN', 'xoxb-test');
    vi.stubEnv('SLACK_SIGNING_SECRET', 'slack-secret');
    vi.stubEnv('GEMINI_API_KEY', 'gemini-key');
    vi.stubEnv('GCP_PROJECT_ID', 'gcp-project');
    vi.stubEnv('WHATSAPP_ENABLED', 'true');
    vi.resetModules();

    const { loadConfig } = await import('../src/config.js');

    expect(() => loadConfig()).toThrow('Missing required env var: WHATSAPP_VERIFY_TOKEN');
    vi.unstubAllEnvs();
  });

  it('parses enabled WhatsApp config and allowlist', async () => {
    vi.stubEnv('SLACK_BOT_TOKEN', 'xoxb-test');
    vi.stubEnv('SLACK_SIGNING_SECRET', 'slack-secret');
    vi.stubEnv('GEMINI_API_KEY', 'gemini-key');
    vi.stubEnv('GCP_PROJECT_ID', 'gcp-project');
    vi.stubEnv('WHATSAPP_ENABLED', 'true');
    vi.stubEnv('WHATSAPP_VERIFY_TOKEN', 'verify-token');
    vi.stubEnv('WHATSAPP_APP_SECRET', 'app-secret');
    vi.stubEnv('WHATSAPP_ACCESS_TOKEN', 'access-token');
    vi.stubEnv('WHATSAPP_PHONE_NUMBER_ID', 'phone-number-id');
    vi.stubEnv('WHATSAPP_GRAPH_API_VERSION', 'v23.0');
    vi.stubEnv('WHATSAPP_ALLOWED_WA_IDS', '15551234567, 15557654321');
    vi.resetModules();

    const { loadConfig } = await import('../src/config.js');
    const config = loadConfig();

    expect(config.whatsapp).toEqual({
      enabled: true,
      verifyToken: 'verify-token',
      appSecret: 'app-secret',
      accessToken: 'access-token',
      phoneNumberId: 'phone-number-id',
      graphApiVersion: 'v23.0',
      allowedWaIds: ['15551234567', '15557654321'],
    });
    vi.unstubAllEnvs();
  });
});
