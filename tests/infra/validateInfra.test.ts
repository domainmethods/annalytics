import { execFileSync, spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

describe('infrastructure validation', () => {
  it('fails clearly without a validation tool, locally and in CI', () => {
    for (const ci of ['', 'true']) {
      const result = spawnSync('/bin/sh', ['scripts/validate-infra.sh'], {
        env: { PATH: '/nonexistent', CI: ci },
        encoding: 'utf8',
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Terraform/OpenTofu not installed');
    }
  });

  it('has valid shell syntax', () => {
    execFileSync('/bin/sh', ['-n', 'scripts/validate-infra.sh']);
  });
});
