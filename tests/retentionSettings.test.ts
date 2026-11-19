import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';

it.each(['1.5', '1e300', 'private-invalid-value'])('backfill rejects invalid retention before accessing Firestore: %s', value => {
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/backfill-retention-fields.ts', '--project', 'unused-test-project', '--apply'], {
    env: { ...process.env, RESPONSE_CONTEXT_RETENTION_DAYS: value }, encoding: 'utf8',
  });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('RESPONSE_CONTEXT_RETENTION_DAYS');
  expect(result.stderr).not.toContain(value);
  expect(result.stdout).toBe('');
});
