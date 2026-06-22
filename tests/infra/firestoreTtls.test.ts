import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';

/**
 * Parity test for the Firestore TTL manifest (`infra/firestore.ttls.json`).
 *
 * TTL policies are applied manually via gcloud (Terraform in `infra/` is not
 * applied); the manifest is the source of truth for which collection/field
 * pairs have TTL policies in the live project. This test pins the exact
 * expected set so the manifest drifts loudly, not silently — same spirit as
 * the model/thinking-level parity test in tests/agents/.
 *
 * Intentionally absent (no TTL policy):
 * - `rate_limits` — bounded sliding window, overwritten in place per user
 * - `teaching_candidates` — human-drained via scripts/promote-teachings.ts
 * - `feedback_notes` — human-drained via scripts/promote-teachings.ts
 * - `config` — singleton metadata docs, never expire
 *
 * Note: `escalation_state.expiresAt` is a logical escalation timeout, NOT a
 * retention deadline — its TTL policy targets `retainUntil` instead so
 * resolved/timed-out audit history survives.
 */
describe('infra/firestore.ttls.json', () => {
  it('contains exactly the expected TTL policies', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../../infra/firestore.ttls.json', import.meta.url), 'utf-8'),
    );

    const expected = [
      { collectionGroup: 'slack_event_dedupe', field: 'expiresAt' },
      { collectionGroup: 'whatsapp_event_dedupe', field: 'expiresAt' },
      { collectionGroup: 'processing_threads', field: 'expiresAt' },
      { collectionGroup: 'clarification_state', field: 'expiresAt' },
      { collectionGroup: 'information_schema_cache', field: 'expiresAt' },
      { collectionGroup: 'dbt_run_history', field: 'expiresAt' },
      { collectionGroup: 'escalation_state', field: 'retainUntil' },
      { collectionGroup: 'response_context', field: 'expiresAt' },
      { collectionGroup: 'pending_notifications', field: 'expiresAt' },
    ];

    expect(manifest.ttls).toEqual(expected);
  });
});
