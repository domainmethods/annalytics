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
