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
